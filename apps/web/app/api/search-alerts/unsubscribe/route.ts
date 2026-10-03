import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/api";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";

/**
 * GET /api/search-alerts/unsubscribe?token=… (QA-403): flips the alert to
 * 'off' and lands the buyer back on /search. Every alert mail carries this
 * link; it's one-shot and idempotent (already-'off' → same redirect).
 */
export async function GET(req: Request) {
  const canonical = appOrigin(req);
  if (!rateLimit(`alert-unsub:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return NextResponse.redirect(
      new URL("/search?alert=rate-limited", canonical),
    );
  }
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.redirect(new URL("/search?alert=invalid", canonical));
  }
  const repo = await getRepo();
  await repo.unsubscribeSearchAlert(token);
  return NextResponse.redirect(new URL("/search?alert=unsubscribed", canonical));
}
