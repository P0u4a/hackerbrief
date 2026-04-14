import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { GoogleGenerativeAI } from "@google/generative-ai";

const TARGET_ITEMS = 30;
const FETCH_BUFFER = 20;
const MAX_COMMENTS = 100;
const GEMINI_DELAY_MS = 2500;
const ARTICLE_FETCH_TIMEOUT_MS = 15_000;
const MAX_ARTICLE_CHARS = 15_000;
const MAX_COMMENT_CHARS = 15_000;

const HN_TOP_STORIES = "https://hacker-news.firebaseio.com/v0/topstories.json";
const hnItem = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const algoliaItem = (id: number) => `https://hn.algolia.com/api/v1/items/${id}`;

interface HNStory {
  id: number;
  title: string;
  url?: string;
  text?: string;
  by: string;
  score: number;
  descendants?: number;
  time: number;
}

interface AlgoliaComment {
  id: number;
  text: string | null;
  author: string | null;
  children: AlgoliaComment[];
}

interface DigestItem {
  objectID: string;
  title: string;
  url: string;
  hnUrl: string;
  author: string;
  points: number;
  numComments: number;
  createdAt: string;
  summary: string | null;
  commentSummary: string | null;
}

interface FrontPageDigest {
  generatedAt: string;
  itemCount: number;
  items: DigestItem[];
}

type Model = ReturnType<GoogleGenerativeAI["getGenerativeModel"]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, "0");
const stripHtml = (s: string) => s.replaceAll(/<[^>]*>/g, " ").trim();

function createModel(): Model {
  const key =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY env var");
  return new GoogleGenerativeAI(key).getGenerativeModel({
    model: "gemini-2.5-flash",
  });
}

async function fetchCandidateStories(count: number): Promise<HNStory[]> {
  console.log("Fetching top HN story IDs...");
  const res = await fetch(HN_TOP_STORIES);
  if (!res.ok) throw new Error(`Failed to fetch top stories: ${res.status}`);
  const ids: number[] = await res.json();

  console.log(`Fetching ${Math.min(count, ids.length)} story details...`);
  const stories = await Promise.all(
    ids.slice(0, count).map(async (id) => {
      try {
        const r = await fetch(hnItem(id));
        return r.ok ? ((await r.json()) as HNStory) : null;
      } catch {
        return null;
      }
    })
  );

  const valid = stories.filter((s): s is HNStory => s !== null && !!s.title);
  console.log(`Got ${valid.length} valid stories\n`);
  return valid;
}

async function extractContent(story: HNStory): Promise<string | null> {
  if (story.url) {
    try {
      const res = await fetch(story.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; HackerBrief/1.0)",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      });

      if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
        const html = await res.text();
        const dom = new JSDOM(html, { url: story.url });
        const article = new Readability(dom.window.document).parse();
        if (article?.textContent?.trim()) {
          return article.textContent.trim().slice(0, MAX_ARTICLE_CHARS);
        }
      }
    } catch {}
  }

  if (story.text) {
    return stripHtml(story.text).slice(0, MAX_ARTICLE_CHARS) || null;
  }

  return null;
}

async function summarizeArticle(
  model: Model,
  content: string
): Promise<string | null> {
  try {
    const result = await model.generateContent(
      `You are a concise technical writer. Summarize the following article. Focus on key points, technical details, and why it matters. If the content is primarily about partisan politics, elections, political campaigns, or political figures in a political context, respond with exactly "POLITICAL_CONTENT" and nothing else.
      <article>
        ${content}
      </article>`
    );
    const text = result.response.text().trim();
    if (!text || text === "POLITICAL_CONTENT") return null;
    return text;
  } catch (e) {
    console.error("Gemini article summary error:", e);
    return null;
  }
}

async function fetchAndSummarizeComments(
  model: Model,
  storyId: number
): Promise<string | null> {
  let comments: string[];
  try {
    const res = await fetch(algoliaItem(storyId));
    if (!res.ok) return null;
    const root: AlgoliaComment = await res.json();

    comments = [];
    const queue = [...(root.children ?? [])];
    while (queue.length > 0 && comments.length < MAX_COMMENTS) {
      const node = queue.shift()!;
      if (node.text) {
        const clean = stripHtml(node.text);
        if (clean) comments.push(clean);
      }
      if (node.children) queue.push(...node.children);
    }
  } catch {
    return null;
  }

  if (comments.length === 0) return null;

  await sleep(GEMINI_DELAY_MS);

  try {
    const joined = comments.join("\n---\n").slice(0, MAX_COMMENT_CHARS);
    const result = await model.generateContent(
      `Summarize the general ideas being discussed and the overall sentiment in these Hacker News comments. Highlight key themes, notable insights, and whether the community response is generally positive, negative, or mixed. Keep it concise (2-3 short paragraphs).
      <comments>
        ${joined}
      </comments>`
    );
    const text = result.response.text().trim();
    return text || null;
  } catch (e) {
    console.error("Gemini comment summary error:", e);
    return null;
  }
}

async function processStory(
  model: Model,
  story: HNStory
): Promise<DigestItem | null> {
  const content = await extractContent(story);
  if (!content) {
    console.log("-> Skipped: no extractable content");
    return null;
  }

  await sleep(GEMINI_DELAY_MS);
  const summary = await summarizeArticle(model, content);
  if (!summary) {
    console.log("-> Skipped: political or summarization failed");
    return null;
  }

  const commentSummary = await fetchAndSummarizeComments(model, story.id);
  console.log(`-> OK (comment summary: ${commentSummary ? "yes" : "no"})`);

  return {
    objectID: String(story.id),
    title: story.title,
    url: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
    hnUrl: `https://news.ycombinator.com/item?id=${story.id}`,
    author: story.by,
    points: story.score,
    numComments: story.descendants ?? 0,
    createdAt: new Date(story.time * 1000).toISOString(),
    summary,
    commentSummary,
  };
}

async function processStories(
  model: Model,
  candidates: HNStory[],
  target: number
): Promise<DigestItem[]> {
  const items: DigestItem[] = [];

  for (const story of candidates) {
    if (items.length >= target) break;

    console.log(`[${items.length + 1}/${target}] ${story.title.slice(0, 60)}`);

    const item = await processStory(model, story);
    if (item) items.push(item);
  }

  if (items.length < target) {
    console.warn(
      `\nWarning: only ${items.length} items (ran out of candidate stories)`
    );
  }

  return items;
}

function writeDigest(items: DigestItem[]): void {
  const now = new Date();

  const digest: FrontPageDigest = {
    generatedAt: now.toISOString(),
    itemCount: items.length,
    items,
  };

  const filename = `hn-digest-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${now.getUTCFullYear()}.json`;
  const outPath = join(process.cwd(), "digests", filename);
  writeFileSync(outPath, JSON.stringify(digest, null, 2) + "\n");

  console.log(`\nDigest written to digests/${filename}`);
  console.log(`Total items: ${items.length}/${TARGET_ITEMS}`);
}

async function main() {
  const model = createModel();
  const candidates = await fetchCandidateStories(TARGET_ITEMS + FETCH_BUFFER);
  const items = await processStories(model, candidates, TARGET_ITEMS);
  writeDigest(items);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
