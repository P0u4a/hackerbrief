"use client";

import { useState, useEffect } from "react";
import { ExpandableSummary } from "./expandable-summary";

const GITHUB_REPO = "P0u4a/hackerbrief";
const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/digests`;

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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function getDigestFilename(date: Date): string {
  return `hn-digest-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}-${date.getUTCFullYear()}.json`;
}

function getCacheKey(date: Date): string {
  return `hackerbrief-${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function getCachedDigest(date: Date): FrontPageDigest | null {
  try {
    const key = getCacheKey(date);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as FrontPageDigest;
  } catch {
    return null;
  }
}

function setCachedDigest(date: Date, digest: FrontPageDigest): void {
  try {
    const key = getCacheKey(date);
    // Clear old cache entries
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("hackerbrief-") && k !== key) {
        localStorage.removeItem(k);
      }
    }
    localStorage.setItem(key, JSON.stringify(digest));
  } catch {
    // localStorage might be full or unavailable
  }
}

async function fetchDigest(date: Date): Promise<FrontPageDigest | null> {
  const filename = getDigestFilename(date);
  const url = `${RAW_BASE}/${filename}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as FrontPageDigest;
  } catch {
    return null;
  }
}

export function DigestView() {
  const [digest, setDigest] = useState<FrontPageDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function load() {
      const now = new Date();

      // Check client-side cache first
      const cached = getCachedDigest(now);
      if (cached) {
        setDigest(cached);
        setLoading(false);
        return;
      }

      // Fetch today's digest
      let data = await fetchDigest(now);

      // If today's isn't available, try yesterday
      if (!data) {
        const yesterday = new Date(now);
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        data = await fetchDigest(yesterday);
      }

      if (data) {
        setCachedDigest(now, data);
        setDigest(data);
      } else {
        setError(true);
      }

      setLoading(false);
    }

    load();
  }, []);

  if (loading) {
    return (
      <main className="h-dvh flex items-center justify-center bg-stone-800 text-stone-100">
        <p className="text-lg font-mono text-stone-300 animate-pulse">
          Loading digest...
        </p>
      </main>
    );
  }

  return (
    <main className="h-dvh overflow-y-scroll snap-y snap-mandatory bg-stone-800 text-stone-100 md:h-auto md:overflow-y-auto md:snap-none md:px-6 md:py-10 md:min-h-screen">
      <div className="flex flex-col md:mx-auto md:w-full md:max-w-5xl md:gap-8">
        <header className="h-dvh snap-start flex flex-col justify-center px-6 space-y-2 md:h-auto md:snap-align-none md:px-0">
          <div className="flex w-full justify-between items-center">
            <h1 className="text-3xl font-semibold md:text-4xl">Hackerbrief</h1>
          </div>
          {digest ? (
            <hgroup className="flex flex-col gap-2">
              <h2 className="text-lg text-stone-200">
                The top posts on <span className="font-bold">Hacker News</span>{" "}
                summarized daily
              </h2>
              <p className="text-sm text-stone-300 font-mono">
                Generated: {new Date(digest.generatedAt).toLocaleString()}
              </p>
              <p className="text-sm font-semibold font-mono text-stone-300">
                Built by{" "}
                <a
                  className="underline"
                  href="https://github.com/P0u4a"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  P0u4a
                </a>
              </p>
            </hgroup>
          ) : (
            <p className="text-sm text-stone-300 font-mono">
              {error
                ? "Today's digest is not available yet. Check back soon."
                : "Loading..."}
            </p>
          )}
        </header>

        {digest?.items.map((item) => (
          <article
            key={item.objectID}
            className="h-dvh min-h-dvh snap-start overflow-y-auto overflow-x-hidden bg-stone-900 pt-0 pb-5 px-5 md:h-auto md:min-h-0 md:snap-align-none md:overflow-visible md:rounded-xl md:border md:border-stone-700"
          >
            <div className="sticky top-0 z-10 bg-stone-900 -mx-5 px-5 pt-5 pb-3 md:bg-stone-900/90 md:backdrop-blur-sm md:rounded-t-xl">
              <h2 className="text-2xl font-medium">
                <a
                  className="text-amber-500 hover:underline"
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {item.title}
                </a>
              </h2>
              <p className="text-sm text-stone-300">
                by {item.author} | {item.points} points | {item.numComments}{" "}
                comments |{" "}
                <a
                  className="underline"
                  href={item.hnUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  HN thread
                </a>
              </p>
            </div>

            {item.summary && <ExpandableSummary summary={item.summary} />}

            {item.commentSummary && (
              <div className="mt-4 border-t border-stone-700 pt-4">
                <h3 className="text-sm font-semibold text-stone-400 uppercase tracking-wide mb-2">
                  Community Discussion
                </h3>
                <ExpandableSummary summary={item.commentSummary} />
              </div>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
