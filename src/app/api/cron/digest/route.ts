import { runDailyDigestChunk } from "@/lib/digest";
import { after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return true;
  }

  const authHeader = req.headers.get("authorization");
  return authHeader === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runDailyDigestChunk();

    if (result.status === "in_progress") {
      after(async () => {
        const nextUrl = new URL(req.url);
        nextUrl.searchParams.set("continue", "1");

        const headers = new Headers();
        const secret = process.env.CRON_SECRET;
        if (secret) {
          headers.set("authorization", `Bearer ${secret}`);
        }

        try {
          await fetch(nextUrl.toString(), {
            method: "GET",
            headers,
            cache: "no-store",
          });
        } catch {
          // Best-effort continuation; next cron invocation can resume from blob state.
        }
      });
    }

    return Response.json({
      ok: true,
      runId: result.runId,
      status: result.status,
      processedThisChunk: result.processedThisChunk,
      itemCount: result.itemCount,
      remainingItems: result.remainingItems,
      generatedAt: result.generatedAt,
      blobUrl: result.blobUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
