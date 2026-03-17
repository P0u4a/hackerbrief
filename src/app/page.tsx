import { readDigestFromFile } from "@/lib/digest";
import { ExpandableSummary } from "@/components/expandable-summary";

export default async function Home() {
  const digest = readDigestFromFile();

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
                The top 10 posts on{" "}
                <span className="font-bold">Hacker News</span> summarized daily
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
              Quota limits have been reached for this project. Please stay tuned
              for a fix.
            </p>
          )}
        </header>

        {digest
          ? digest.items.map((item) => (
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
                </div>
                {item.error ? (
                  "No summary available."
                ) : (
                  <ExpandableSummary summary={item.summary!} />
                )}
              </article>
            ))
          : null}
      </div>
    </main>
  );
}
