import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function secondsUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  midnight.setUTCHours(0, 0, 0, 0);
  return Math.floor((midnight.getTime() - now.getTime()) / 1000);
}

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const maxAge = secondsUntilMidnightUTC();
  response.headers.set(
    "Cache-Control",
    `public, max-age=${maxAge}, stale-while-revalidate=60`
  );
  return response;
}

export const config = {
  matcher: "/",
};
