import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import {
  GenerativeModel,
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
} from "@google/generative-ai";
import { sleep, stripHtml, pad } from "./utils";
import { summarizeCommentsPrompt, summarizePrompt } from "./prompts";
import {
  GEMINI_DELAY_MS,
  GEMINI_MODEL,
  HN_TOP_STORIES,
  ARTICLE_FETCH_TIMEOUT_MS,
  MAX_ARTICLE_CHARS,
  MAX_COMMENTS,
  MAX_COMMENT_CHARS,
  TARGET_ITEMS,
  FETCH_BUFFER,
} from "./constants";
import { HNStory, AlgoliaComment, DigestItem, FrontPageDigest } from "./types";

const hnItem = (id: number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const algoliaItem = (id: number) => `https://hn.algolia.com/api/v1/items/${id}`;

class QuotaExhaustedError extends Error {}

function parseRetryDelayMs(err: unknown): number | null {
  if (!(err instanceof GoogleGenerativeAIFetchError) || err.status !== 429) {
    return null;
  }
  const retryInfo = err.errorDetails?.find(
    (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  const delay = retryInfo?.retryDelay;
  if (typeof delay !== "string") return null;
  const match = delay.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

async function generateWithRetry(
  model: GenerativeModel,
  prompt: string
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      await sleep(GEMINI_DELAY_MS);
      return text;
    } catch (e) {
      const is429 =
        e instanceof GoogleGenerativeAIFetchError && e.status === 429;
      if (!is429) throw e;
      const delayMs = parseRetryDelayMs(e);
      if (delayMs == null || attempt >= 1) throw new QuotaExhaustedError();
      const seconds = Math.ceil(delayMs / 1000);
      console.log(`-> Rate limited; waiting ${seconds}s before retry...`);
      await sleep(delayMs + 1000);
    }
  }
}

function createModel(): GenerativeModel {
  const key =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY env var");
  return new GoogleGenerativeAI(key).getGenerativeModel({
    model: GEMINI_MODEL,
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`-> Article fetch failed (${story.url}): ${msg}`);
    }
  }

  if (story.text) {
    return stripHtml(story.text).slice(0, MAX_ARTICLE_CHARS) || null;
  }

  return null;
}

async function summarizeArticle(
  model: GenerativeModel,
  content: string
): Promise<string | null> {
  try {
    const text = await generateWithRetry(model, summarizePrompt(content));
    if (!text || text === "POLITICAL_CONTENT") return null;
    return text;
  } catch (e) {
    if (e instanceof QuotaExhaustedError) throw e;
    console.error("Gemini article summary error:", e);
    return null;
  }
}

async function fetchComments(storyId: number): Promise<string[]> {
  try {
    const res = await fetch(algoliaItem(storyId));
    if (!res.ok) return [];
    const root: AlgoliaComment = await res.json();

    const comments: string[] = [];
    const queue: AlgoliaComment[] = [...(root.children ?? [])];
    for (let i = 0; i < queue.length && comments.length < MAX_COMMENTS; i++) {
      const node = queue[i];
      if (node.text) {
        const clean = stripHtml(node.text);
        if (clean) comments.push(clean);
      }
      if (node.children) queue.push(...node.children);
    }
    return comments;
  } catch {
    return [];
  }
}

async function summarizeComments(
  model: GenerativeModel,
  comments: string[]
): Promise<string | null> {
  if (comments.length === 0) return null;

  try {
    const joined = comments.join("\n---\n").slice(0, MAX_COMMENT_CHARS);
    const text = await generateWithRetry(
      model,
      summarizeCommentsPrompt(joined)
    );
    return text || null;
  } catch (e) {
    if (e instanceof QuotaExhaustedError) throw e;
    console.error("Gemini comment summary error:", e);
    return null;
  }
}

async function processStory(
  model: GenerativeModel,
  story: HNStory
): Promise<DigestItem | null> {
  const content = await extractContent(story);
  if (!content) {
    console.log("-> Skipped: no extractable content");
    return null;
  }

  const summary = await summarizeArticle(model, content);
  if (!summary) {
    console.log("-> Skipped: political or summarization failed");
    return null;
  }

  const comments = await fetchComments(story.id);
  let commentSummary: string | null = null;
  try {
    commentSummary = await summarizeComments(model, comments);
  } catch (e) {
    if (!(e instanceof QuotaExhaustedError)) throw e;
    console.log("-> Quota hit on comments; keeping article-only item");
  }

  console.log(`-> OK (comment summary: ${commentSummary ? "yes" : "no"})`);

  const hnUrl = `https://news.ycombinator.com/item?id=${story.id}`;

  return {
    objectID: String(story.id),
    title: story.title,
    url: story.url ?? hnUrl,
    hnUrl,
    author: story.by,
    points: story.score,
    numComments: story.descendants ?? 0,
    createdAt: new Date(story.time * 1000).toISOString(),
    summary,
    commentSummary,
  };
}

async function processStories(
  model: GenerativeModel,
  candidates: HNStory[],
  target: number
): Promise<DigestItem[]> {
  const items: DigestItem[] = [];

  for (const story of candidates) {
    if (items.length >= target) break;

    console.log(`[${items.length + 1}/${target}] ${story.title.slice(0, 60)}`);

    try {
      const item = await processStory(model, story);
      if (item) items.push(item);
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        console.warn("\nGemini quota exhausted; writing partial digest");
        break;
      }
      throw e;
    }
  }

  return items;
}

function writeDigest(items: DigestItem[], target: number): void {
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
  console.log(`Total items: ${items.length}/${target}`);
}

async function main() {
  const model = createModel();
  const candidates = await fetchCandidateStories(TARGET_ITEMS + FETCH_BUFFER);
  const items = await processStories(model, candidates, TARGET_ITEMS);
  writeDigest(items, TARGET_ITEMS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
