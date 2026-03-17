import {
  buildDailyDigest,
  pushDigestToGitHub,
  writeDigestToFile,
} from "@/lib/digest";

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
    const digest = await buildDailyDigest();

    if (process.env.NODE_ENV === "development") {
      writeDigestToFile(digest);
    } else {
      await pushDigestToGitHub(digest);
    }

    return Response.json({
      ok: true,
      itemCount: digest.itemCount,
      generatedAt: digest.generatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
