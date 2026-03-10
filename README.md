## Hackerbrief

Daily Hacker News front-page digest powered by:

- HN Algolia API (`tags=front_page`)
- Vercel Sandbox (`@vercel/sandbox`) to run `summarize` CLI with Gemini
- Vercel Blob SDK (`@vercel/blob`) with private JSON blobs overwritten once per day

## Environment Variables

Set these in Vercel project settings:

- `GEMINI_API_KEY` (or `GOOGLE_GENERATIVE_AI_API_KEY`)
- `BLOB_READ_WRITE_TOKEN`
- `CRON_SECRET` (recommended for cron route protection)
- `DIGEST_READ_SECRET` (optional; defaults to `CRON_SECRET` when not set)
- `DIGEST_MAX_ITEMS` (optional, default `20`)
- `DIGEST_CHUNK_MAX_ITEMS` (optional, default `8`; max items processed per invocation)
- `GEMINI_REQUESTS_PER_MINUTE` (optional, default `5`)
- `DIGEST_RUNTIME_BUDGET_SECONDS` (optional, default `280`)
- `SUMMARIZE_SNAPSHOT_ID` (optional; force a specific snapshot ID)

## How It Works

1. Vercel cron calls `GET /api/cron/digest` every day (`0 0 * * *` in `vercel.json`).
2. The route fetches front-page items from the last 24h via `https://hn.algolia.com/api/v1/search_by_date?tags=front_page`.
3. The job reuses a sandbox snapshot with `@steipete/summarize` preinstalled.
4. If no usable snapshot exists, it installs once, creates a snapshot, and stores snapshot ID in private blob state.
5. The run state is persisted to private blob at `state/frontpage-run-state.json`.
6. Each invocation processes a chunk, updates progress in blob state, returns quickly, and schedules the next invocation.
7. Once all items are processed, result JSON is uploaded to private Vercel Blob at `digests/frontpage-latest.json` with overwrite enabled.
8. Frontend reads and renders the latest private blob content server-side.

## Local Development

Run the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

To run a digest manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/digest
```

Digest endpoint (token-protected if `CRON_SECRET` or `DIGEST_READ_SECRET` is set):

- `GET /api/digest`
