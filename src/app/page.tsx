import { getDigestFromBlob } from "@/lib/digest";
import { Streamdown } from "streamdown";

export const dynamic = "force-dynamic";

export default async function Home() {
  const digest = await getDigestFromBlob().catch(() => null);

  return (
    <main className="min-h-screen bg-stone-800 px-6 py-10 text-stone-100 md:px-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="space-y-2">
          <div className="flex w-full justify-between items-center">
            <h1 className="text-3xl font-semibold md:text-4xl">Hackerbrief</h1>
          </div>
          {digest ? (
            <hgroup className="flex flex-col gap-2">
              <h2 className="text-lg text-stone-200">
                The top 10 posts on{" "}
                <span className="font-bold">Hacker News</span> summarized daily
              </h2>
              <p className="text-sm text-stone-300 font-mono">
                Generated: {new Date(digest.generatedAt).toLocaleString()}
              </p>
            </hgroup>
          ) : (
            <p className="text-sm text-stone-300 font-mono">
              No digest yet. Trigger `GET /api/cron/digest`.
            </p>
          )}
        </header>

        {digest ? (
          <section className="grid gap-4">
            {digest.items.map((item) => (
              <article
                key={item.objectID}
                className="rounded-xl border border-stone-700 bg-stone-900/80 p-5"
              >
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
                  by {item.author} |{" "}
                  <a
                    className="underline"
                    href={item.hnUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    HN thread
                  </a>
                </p>
                {item.error ? (
                  "No summary available."
                ) : (
                  <div className="pt-5 text-pretty">
                    <Streamdown>{item.summary!}</Streamdown>
                  </div>
                )}
              </article>
            ))}
          </section>
        ) : null}
      </div>
    </main>
  );
}
