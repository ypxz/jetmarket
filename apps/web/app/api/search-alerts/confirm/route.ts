import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/api";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";
import { searchAlertTargetUrl } from "@/lib/search-alerts";

/**
 * GET /api/search-alerts/confirm?token=… (QA-403): flips the alert
 * pending→active via repo CAS, then redirects onto the saved search itself
 * so the buyer lands on exactly what they subscribed to. Confirm mails are
 * link-click one-shots (no side effect to prefetch) so GET-consumes is
 * acceptable here; an unknown/used token just lands on /search un-alerted.
 */
export async function GET(req: Request) {
  const canonical = appOrigin(req);
  if (!rateLimit(`alert-confirm:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return NextResponse.redirect(
      new URL("/search?alert=rate-limited", canonical),
    );
  }
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.redirect(new URL("/search?alert=invalid", canonical));
  }
  const repo = await getRepo();
  const alert = await repo.confirmSearchAlert(token);
  if (!alert) {
    return NextResponse.redirect(new URL("/search?alert=invalid", canonical));
  }
  const target = new URL(searchAlertTargetUrl(canonical, alert.params));
  target.searchParams.set("alert", "confirmed");
  return NextResponse.redirect(target);
}
