import { NextResponse } from "next/server";
import { verifyOpUnsub } from "@jetmarket/config/tokens";
import { clientIp, rateLimit } from "@/lib/api";
import { appOrigin } from "@/lib/origin";
import { getRepo } from "@/lib/repo";
import { logInfo } from "@/lib/log";

/**
 * GET /api/operator/notify/unsubscribe?token=… (QA-541): every RFQ-match
 * mail (worker email.quote_notification and the memory-mode inline send)
 * ends with this link — one click mutes the same pref the dashboard's
 * QA-505 toggle flips, without needing a session. The signed token IS the
 * proof (HMAC'd operator id); the row flip is idempotent, so mail-client
 * prefetch / List-Unsubscribe-Post hits do exactly the right thing.
 * Landing is /sign-in?notice=match-muted — sign-in shows the "mail is
 * off" line and offers the way back in (the toggle re-arms it).
 */
export async function GET(req: Request) {
  const canonical = appOrigin(req);
  const to = (q: string) =>
    NextResponse.redirect(new URL(`/sign-in?${q}`, canonical));
  if (!rateLimit(`op-unsub:${clientIp(req)}`, 120, 60 * 60 * 1000)) {
    return to("error=rate-limited");
  }
  const token = new URL(req.url).searchParams.get("token");
  const operatorId = verifyOpUnsub(token);
  if (!operatorId) return to("error=invalid-token");
  const repo = await getRepo();
  const operator = await repo.getOperator(operatorId);
  if (!operator) return to("error=invalid-token");
  await repo.setOperatorNotifyRfqMatch(operator.id, false);
  logInfo("operator.match_mail_muted", { operatorId: operator.id });
  return to("notice=match-muted");
}
