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
- `DIGEST_MAX_ITEMS` (optional, default `10`)
- `GEMINI_REQUESTS_PER_MINUTE` (optional, default `5`)
- `DIGEST_RUNTIME_BUDGET_SECONDS` (optional, default `280`)
- `SUMMARIZE_SNAPSHOT_ID` (optional; force a specific snapshot ID)

## How It Works

1. Vercel cron calls `GET /api/cron/digest` every day (`0 0 * * *` in `vercel.json`).
2. The route fetches front-page items from the last 24h via `https://hn.algolia.com/api/v1/search_by_date?tags=front_page`.
3. The job reuses a sandbox snapshot with `@steipete/summarize` preinstalled.
4. If no usable snapshot exists, it installs once, creates a snapshot, and stores snapshot ID in private blob state.
5. The route summarizes up to `DIGEST_MAX_ITEMS`, capped by the runtime budget and request rate limits.
6. Result JSON is uploaded to private Vercel Blob at `digests/frontpage-latest.json` with overwrite enabled.
7. Frontend reads and renders the latest private blob content server-side.

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
