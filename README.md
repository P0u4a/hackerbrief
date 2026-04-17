## Hackerbrief

Daily Hacker News front-page digest. Summaries of linked articles and comments.

## How It Works

1. `.github/workflows/daily-digest.yml` runs every day at `00:00 UTC`
2. The workflow runs `pnpm generate`, which executes `scripts/generate-digest.ts`.
3. The script:
   - Fetches top story IDs from `https://hacker-news.firebaseio.com/v0/topstories.json`
   - For each story: fetches the linked article, runs it through `@mozilla/readability` to extract main text.
   - Calls Gemini (`gemini-2.5-flash`) to summarize the article. Stories flagged as primarily partisan/political content are skipped.
   - Fetches the comment tree from the Algolia HN API and asks Gemini to summarize
4. The output is written to `digests/hn-digest-MM-DD-YYYY.json`.
5. The workflow commits and pushes the new digest file to `main`.
6. The frontend (`src/components/digest-view.tsx`) fetches today's digest from `raw.githubusercontent.com/P0u4a/hackerbrief/main/digests/`, falling back to yesterday's if today's hasn't been generated yet. Results are cached in `localStorage`.

## Environment Variables

- `GEMINI_API_KEY` - Gemini API key (also accepts `GOOGLE_GENERATIVE_AI_API_KEY`).

## Local Development

Run the frontend:

```bash
pnpm dev
```

## Tuning

Constants live in `scripts/constants.ts`:

- `TARGET_ITEMS` - number of accepted stories per digest.
- `FETCH_BUFFER` - extra candidates pulled to survive skipped stories.
- `MAX_COMMENTS` - cap on comments summarized per story.
- `GEMINI_DELAY_MS` - throttle applied after each Gemini call.
- `ARTICLE_FETCH_TIMEOUT_MS`, `MAX_ARTICLE_CHARS`, `MAX_COMMENT_CHARS` - request and prompt-size limits.
