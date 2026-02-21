import { getDigestFromBlob } from "@/lib/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(req: Request): boolean {
  const secret = process.env.DIGEST_READ_SECRET ?? process.env.CRON_SECRET;
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
    const digest = await getDigestFromBlob();

    if (!digest) {
      return Response.json(
        { error: "No digest available yet. Run /api/cron/digest first." },
        { status: 404 }
      );
    }

    return Response.json(digest);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
