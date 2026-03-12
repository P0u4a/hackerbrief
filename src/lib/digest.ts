import { get, put } from "@vercel/blob";
import { Sandbox } from "@vercel/sandbox";

const HN_API_BASE = "https://hn.algolia.com/api/v1";
export const DIGEST_BLOB_PATH = "digests/frontpage-latest.json";
const SNAPSHOT_STATE_PATH = "state/summarize-snapshot.txt";
const DIGEST_RUN_STATE_PATH = "state/frontpage-run-state.json";
const SANDBOX_TIMEOUT_MS = 60_000 * 20;
const DEFAULT_REQUESTS_PER_MINUTE = 5;
const DEFAULT_RUNTIME_BUDGET_SECONDS = 280;
const DEFAULT_MAX_ITEMS = 10;
const DEFAULT_CHUNK_MAX_ITEMS = 8;
const DEADLINE_BUFFER_MS = 15_000;

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

type DigestRunStatus = "running" | "completed";

type DigestRunState = {
  runId: string;
  status: DigestRunStatus;
  source: string;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  totalItems: number;
  nextIndex: number;
  itemsToSummarize: Array<Omit<DigestItem, "summary" | "error">>;
  completedItems: DigestItem[];
};

export type DigestChunkResult = {
  runId: string;
  status: "in_progress" | "completed";
  processedThisChunk: number;
  itemCount: number;
  remainingItems: number;
  generatedAt: string;
  blobUrl: string | null;
};

type RunDailyDigestChunkOptions = {
  enforceChunkLimit?: boolean;
};

function getGeminiApiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)");
  }
  return key;
}

function getBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("Missing BLOB_READ_WRITE_TOKEN");
  }
  return token;
}

function encodePath(pathname: string): string {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function putPrivateBlob(
  pathname: string,
  body: string,
  contentType: string
): Promise<{ url: string }> {
  const pathnameKey = encodePath(pathname);
  const { url } = await put(pathnameKey, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    token: getBlobToken(),
  });
  return { url };
}

async function getPrivateBlobText(pathname: string): Promise<string | null> {
  const pathnameKey = encodePath(pathname);
  const result = await get(pathnameKey, {
    access: "private",
    useCache: false,
    token: getBlobToken(),
  });

  if (!result || result.statusCode === 304 || !result.stream) {
    return null;
  }

  return new Response(result.stream).text();
}

async function readSnapshotIdFromBlob(): Promise<string | null> {
  const text = await getPrivateBlobText(SNAPSHOT_STATE_PATH);
  if (!text) {
    return null;
  }

  const snapshotId = text.trim();
  return snapshotId.length > 0 ? snapshotId : null;
}

async function readDigestRunStateFromBlob(): Promise<DigestRunState | null> {
  const text = await getPrivateBlobText(DIGEST_RUN_STATE_PATH);
  if (!text) {
    return null;
  }

  return JSON.parse(text) as DigestRunState;
}

async function writeDigestRunStateToBlob(state: DigestRunState): Promise<void> {
  await putPrivateBlob(
    DIGEST_RUN_STATE_PATH,
    JSON.stringify(state),
    "application/json"
  );
}

async function writeSnapshotIdToBlob(snapshotId: string): Promise<void> {
  await putPrivateBlob(SNAPSHOT_STATE_PATH, `${snapshotId}\n`, "text/plain");
}

async function tryCreateSandboxFromSnapshot(
  snapshotId: string
): Promise<Sandbox | null> {
  try {
    return await Sandbox.create({
      source: { type: "snapshot", snapshotId },
      timeout: SANDBOX_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

async function createSnapshotBackedSandbox(): Promise<Sandbox> {
  const forcedSnapshotId = process.env.SUMMARIZE_SNAPSHOT_ID?.trim();
  if (forcedSnapshotId) {
    const forced = await tryCreateSandboxFromSnapshot(forcedSnapshotId);
    if (forced) {
      return forced;
    }
  }

  if (!forcedSnapshotId) {
    const storedSnapshotId = await readSnapshotIdFromBlob();
    if (storedSnapshotId) {
      const restored = await tryCreateSandboxFromSnapshot(storedSnapshotId);
      if (restored) {
        return restored;
      }
    }
  }

  const bootstrap = await Sandbox.create({
    runtime: "node22",
    timeout: SANDBOX_TIMEOUT_MS,
  });
  let newSnapshotId: string | null = null;

  try {
    const install = await bootstrap.runCommand({
      cmd: "npm",
      args: ["install", "--silent", "@steipete/summarize"],
    });
    if (install.exitCode !== 0) {
      const installOut = await install.output("both");
      throw new Error(`Failed to install summarize in sandbox: ${installOut}`);
    }

    const snapshot = await bootstrap.snapshot({ expiration: 0 });
    newSnapshotId = snapshot.snapshotId;
  } finally {
    await bootstrap.stop().catch(() => undefined);
  }

  if (!newSnapshotId) {
    throw new Error("Failed to create summarize snapshot");
  }

  if (!forcedSnapshotId) {
    await writeSnapshotIdToBlob(newSnapshotId);
  }

  const sandbox = await tryCreateSandboxFromSnapshot(newSnapshotId);
  if (!sandbox) {
    throw new Error("Created snapshot but could not start sandbox from it");
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

function getRequestedMaxItems(): number {
  const maxItems = Number(process.env.DIGEST_MAX_ITEMS ?? String(DEFAULT_MAX_ITEMS));
  return Number.isFinite(maxItems) ? Math.max(1, Math.floor(maxItems)) : DEFAULT_MAX_ITEMS;
}

function getRequestedChunkMaxItems(): number {
  const chunkMaxItems = Number(
    process.env.DIGEST_CHUNK_MAX_ITEMS ?? String(DEFAULT_CHUNK_MAX_ITEMS)
  );
  return Number.isFinite(chunkMaxItems)
    ? Math.max(1, Math.floor(chunkMaxItems))
    : DEFAULT_CHUNK_MAX_ITEMS;
}

function createEmptyRunState(nowIso: string): DigestRunState {
  return {
    runId: crypto.randomUUID(),
    status: "running",
    source: "https://hn.algolia.com/api/v1/search_by_date?tags=front_page",
    windowStart: nowIso,
    windowEnd: nowIso,
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
    totalItems: 0,
    nextIndex: 0,
    itemsToSummarize: [],
    completedItems: [],
  };
}

async function initializeDailyRunState(): Promise<DigestRunState> {
  const windowSeconds = 24 * 60 * 60;
  const now = new Date();
  const nowIso = now.toISOString();
  const windowStart = new Date(
    now.getTime() - windowSeconds * 1000
  ).toISOString();
  const hits = await fetchFrontPageHits(windowSeconds);
  const normalized = hits.map(normalizeHit);
  const requestedMaxItems = getRequestedMaxItems();
  const { minIntervalMs, runtimeBudgetSeconds } = getRateLimitConfig();
  const effectiveMaxItems = getEffectiveItemLimit(
    requestedMaxItems,
    minIntervalMs,
    runtimeBudgetSeconds
  );
  const itemsToSummarize = normalized.slice(0, effectiveMaxItems);

  const state = createEmptyRunState(nowIso);
  state.windowStart = windowStart;
  state.windowEnd = nowIso;
  state.totalItems = itemsToSummarize.length;
  state.itemsToSummarize = itemsToSummarize;
  state.updatedAt = new Date().toISOString();
  return state;
}

async function getOrCreateActiveRunState(): Promise<DigestRunState> {
  const existing = await readDigestRunStateFromBlob();
  if (existing && existing.status === "running") {
    return existing;
  }

  const initialized = await initializeDailyRunState();
  await writeDigestRunStateToBlob(initialized);
  return initialized;
}

function finalizeDigestFromState(state: DigestRunState): FrontPageDigest {
  return {
    generatedAt: new Date().toISOString(),
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
    itemCount: state.completedItems.length,
    source: state.source,
    items: state.completedItems,
  };
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

  const sandbox = await createSnapshotBackedSandbox();

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

export async function runDailyDigestChunk(
  options: RunDailyDigestChunkOptions = {}
): Promise<DigestChunkResult> {
  const startedAtMs = Date.now();
  const geminiApiKey = getGeminiApiKey();
  const { minIntervalMs, runtimeBudgetSeconds } = getRateLimitConfig();
  const runtimeDeadlineMs =
    startedAtMs + runtimeBudgetSeconds * 1000 - DEADLINE_BUFFER_MS;
  const budgetItemLimit = getEffectiveItemLimit(
    Number.MAX_SAFE_INTEGER,
    minIntervalMs,
    runtimeBudgetSeconds
  );
  const enforceChunkLimit = options.enforceChunkLimit ?? true;
  const requestedChunkMaxItems = getRequestedChunkMaxItems();
  const maxChunkItems = enforceChunkLimit
    ? Math.max(1, Math.min(requestedChunkMaxItems, budgetItemLimit))
    : Math.max(1, budgetItemLimit);

  const state = await getOrCreateActiveRunState();
  const remainingBefore = Math.max(0, state.totalItems - state.nextIndex);

  if (remainingBefore === 0) {
    const digest = finalizeDigestFromState(state);
    const blob = await putDigestToBlob(digest);
    state.status = "completed";
    state.finishedAt = new Date().toISOString();
    state.updatedAt = state.finishedAt;
    await writeDigestRunStateToBlob(state);
    return {
      runId: state.runId,
      status: "completed",
      processedThisChunk: 0,
      itemCount: digest.itemCount,
      remainingItems: 0,
      generatedAt: digest.generatedAt,
      blobUrl: blob.url,
    };
  }

  const sandbox = await createSnapshotBackedSandbox();
  let processedThisChunk = 0;
  try {
    let nextAllowedAt = Date.now();
    while (processedThisChunk < maxChunkItems) {
      if (Date.now() >= runtimeDeadlineMs && processedThisChunk > 0) {
        break;
      }

      const itemIndex = state.nextIndex + processedThisChunk;
      if (itemIndex >= state.totalItems) {
        break;
      }

      const item = state.itemsToSummarize[itemIndex];
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
      state.completedItems.push({
        ...item,
        summary: summaryResult.summary,
        error: summaryResult.error,
      });
      processedThisChunk += 1;
    }
  } finally {
    await sandbox.stop();
  }

  state.nextIndex += processedThisChunk;
  state.updatedAt = new Date().toISOString();

  const remainingAfter = Math.max(0, state.totalItems - state.nextIndex);
  let blobUrl: string | null = null;
  let status: DigestChunkResult["status"] = "in_progress";
  let generatedAt = state.updatedAt;

  if (remainingAfter === 0) {
    const digest = finalizeDigestFromState(state);
    const blob = await putDigestToBlob(digest);
    blobUrl = blob.url;
    generatedAt = digest.generatedAt;
    status = "completed";
    state.status = "completed";
    state.finishedAt = new Date().toISOString();
    state.updatedAt = state.finishedAt;
  }

  await writeDigestRunStateToBlob(state);

  return {
    runId: state.runId,
    status,
    processedThisChunk,
    itemCount: state.completedItems.length,
    remainingItems: remainingAfter,
    generatedAt,
    blobUrl,
  };
}

export async function putDigestToBlob(
  digest: FrontPageDigest
): Promise<{ url: string }> {
  return putPrivateBlob(
    DIGEST_BLOB_PATH,
    JSON.stringify(digest),
    "application/json"
  );
}

export async function getDigestFromBlob(): Promise<FrontPageDigest | null> {
  const text = await getPrivateBlobText(DIGEST_BLOB_PATH);
  if (text === null) {
    return null;
  }

  return JSON.parse(text) as FrontPageDigest;
}
