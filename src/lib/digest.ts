import { Sandbox } from "@vercel/sandbox";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HN_API_BASE = "https://hn.algolia.com/api/v1";
const SANDBOX_TIMEOUT_MS = 60_000 * 20;
const DEFAULT_REQUESTS_PER_MINUTE = 5;
const DEFAULT_RUNTIME_BUDGET_SECONDS = 280;
const DEFAULT_MAX_ITEMS = 10;

export type DigestItem = {
  objectID: string;
  title: string;
  url: string;
  hnUrl: string;
  author: string;
  points: number;
  numComments: number;
  createdAt: string;
  summary: string | null;
  error: string | null;
};

export type FrontPageDigest = {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  itemCount: number;
  source: string;
  items: DigestItem[];
};

type HNHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  created_at: string;
};

function getGeminiApiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)");
  }
  return key;
}

async function createSummarizeSandbox(): Promise<Sandbox> {
  const snapshotId = process.env.SUMMARIZE_SNAPSHOT_ID?.trim();
  if (snapshotId) {
    try {
      return await Sandbox.create({
        source: { type: "snapshot", snapshotId },
        timeout: SANDBOX_TIMEOUT_MS,
      });
    } catch {
      // fall through to fresh install
    }
  }

  const sandbox = await Sandbox.create({
    runtime: "node22",
    timeout: SANDBOX_TIMEOUT_MS,
  });

  const install = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "--silent", "@steipete/summarize"],
  });
  if (install.exitCode !== 0) {
    const output = await install.output("both");
    throw new Error(`Failed to install summarize in sandbox: ${output}`);
  }

  return sandbox;
}

async function fetchFrontPageHits(windowSeconds: number): Promise<HNHit[]> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  const hits: HNHit[] = [];

  let page = 0;
  let nbPages = 1;

  while (page < nbPages) {
    const searchParams = new URLSearchParams({
      tags: "front_page",
      hitsPerPage: "1000",
      page: String(page),
      numericFilters: `created_at_i>${since}`,
    });
    const res = await fetch(
      `${HN_API_BASE}/search_by_date?${searchParams.toString()}`,
      {
        cache: "no-store",
      }
    );

    if (!res.ok) {
      throw new Error(`HN API failed (${res.status})`);
    }

    const payload = (await res.json()) as { hits: HNHit[]; nbPages: number };
    hits.push(...payload.hits);
    nbPages = payload.nbPages;
    page += 1;

    if (page > 20) {
      break;
    }
  }

  const byId = new Map<string, HNHit>();
  for (const hit of hits) {
    if (!byId.has(hit.objectID)) {
      byId.set(hit.objectID, hit);
    }
  }

  return [...byId.values()];
}

function normalizeHit(hit: HNHit): Omit<DigestItem, "summary" | "error"> {
  const fallbackHnUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;

  return {
    objectID: hit.objectID,
    title: hit.title ?? "Untitled",
    url: hit.url ?? fallbackHnUrl,
    hnUrl: fallbackHnUrl,
    author: hit.author ?? "unknown",
    points: hit.points ?? 0,
    numComments: hit.num_comments ?? 0,
    createdAt: hit.created_at,
  };
}

async function runSummarizeInSandbox(
  sandbox: Sandbox,
  url: string,
  geminiApiKey: string
): Promise<{ summary: string | null; error: string | null }> {
  const command = await sandbox.runCommand({
    cmd: "npx",
    args: [
      "summarize",
      url,
      "--model",
      "google/gemini-2.5-flash",
      "--metrics",
      "off",
    ],
    env: {
      GEMINI_API_KEY: geminiApiKey,
    },
  });

  const output = (await command.output("both")).trim();

  if (command.exitCode !== 0) {
    return {
      summary: null,
      error: output || `summarize failed with exit code ${command.exitCode}`,
    };
  }

  return {
    summary: output,
    error: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRateLimitConfig(): {
  requestsPerMinute: number;
  minIntervalMs: number;
  runtimeBudgetSeconds: number;
} {
  const requestsPerMinute = Math.max(
    1,
    Number(
      process.env.GEMINI_REQUESTS_PER_MINUTE ?? DEFAULT_REQUESTS_PER_MINUTE
    )
  );
  const runtimeBudgetSeconds = Math.max(
    60,
    Number(
      process.env.DIGEST_RUNTIME_BUDGET_SECONDS ??
        DEFAULT_RUNTIME_BUDGET_SECONDS
    )
  );

  return {
    requestsPerMinute,
    minIntervalMs: Math.ceil(60_000 / requestsPerMinute),
    runtimeBudgetSeconds,
  };
}

function getEffectiveItemLimit(
  requestedMaxItems: number,
  minIntervalMs: number,
  runtimeBudgetSeconds: number
): number {
  const budgetMs = runtimeBudgetSeconds * 1000;
  const maxByBudget = Math.max(1, Math.floor(budgetMs / minIntervalMs));
  return Math.max(1, Math.min(requestedMaxItems, maxByBudget));
}

export async function buildDailyDigest(): Promise<FrontPageDigest> {
  const windowSeconds = 24 * 60 * 60;
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - windowSeconds * 1000
  ).toISOString();
  const geminiApiKey = getGeminiApiKey();

  const hits = await fetchFrontPageHits(windowSeconds);
  const normalized = hits.map(normalizeHit);

  const items: DigestItem[] = [];
  const maxItems = Number(
    process.env.DIGEST_MAX_ITEMS ?? String(DEFAULT_MAX_ITEMS)
  );
  const { minIntervalMs, runtimeBudgetSeconds } = getRateLimitConfig();
  const effectiveMaxItems = getEffectiveItemLimit(
    Number.isFinite(maxItems) ? maxItems : DEFAULT_MAX_ITEMS,
    minIntervalMs,
    runtimeBudgetSeconds
  );
  const itemsToSummarize = normalized.slice(0, effectiveMaxItems);

  const sandbox = await createSummarizeSandbox();

  try {
    let nextAllowedAt = Date.now();
    for (const item of itemsToSummarize) {
      const waitMs = Math.max(0, nextAllowedAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const summaryResult = await runSummarizeInSandbox(
        sandbox,
        item.url,
        geminiApiKey
      );
      nextAllowedAt = Date.now() + minIntervalMs;
      items.push({
        ...item,
        summary: summaryResult.summary,
        error: summaryResult.error,
      });
    }
  } finally {
    await sandbox.stop();
  }

  return {
    generatedAt: now.toISOString(),
    windowStart,
    windowEnd: now.toISOString(),
    itemCount: items.length,
    source: "https://hn.algolia.com/api/v1/search_by_date?tags=front_page",
    items,
  };
}

const DIGEST_FILE_PATH = join(process.cwd(), "data", "digest.json");

export function readDigestFromFile(): FrontPageDigest | null {
  try {
    const text = readFileSync(DIGEST_FILE_PATH, "utf-8");
    const parsed = JSON.parse(text);
    if (!parsed?.items) {
      return null;
    }
    return parsed as FrontPageDigest;
  } catch {
    return null;
  }
}

export function writeDigestToFile(digest: FrontPageDigest): void {
  writeFileSync(DIGEST_FILE_PATH, JSON.stringify(digest, null, 2) + "\n");
}

function getGitHubConfig(): { token: string; repo: string } {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("Missing GITHUB_TOKEN");
  }
  const repo = process.env.GITHUB_REPO;
  if (!repo) {
    throw new Error("Missing GITHUB_REPO (format: owner/repo)");
  }
  return { token, repo };
}

export async function pushDigestToGitHub(
  digest: FrontPageDigest
): Promise<void> {
  const { token, repo } = getGitHubConfig();
  const filePath = "data/digest.json";
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Get current file SHA (required for updates)
  const getRes = await fetch(apiUrl, { headers });
  let sha: string | undefined;
  if (getRes.ok) {
    const existing = (await getRes.json()) as { sha: string };
    sha = existing.sha;
  }

  const content = Buffer.from(JSON.stringify(digest, null, 2) + "\n").toString(
    "base64"
  );

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `update digest ${digest.generatedAt}`,
      content,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`GitHub API error (${putRes.status}): ${body}`);
  }
}
