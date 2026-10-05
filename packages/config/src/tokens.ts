import { createHmac, timingSafeEqual } from "node:crypto";

/** Operator mail-unsubscribe tokens (QA-541): `<operatorId>.<hmac>` —
 *  stateless, static per operator, no expiry by design (an unsubscribe
 *  link must keep working for the life of the mail). The only capability
 *  it grants is muting match mail, reversible from the dashboard, so a
 *  leaked token buys nothing. Both web (fan-out mail) and worker
 *  (email.quote_notification) share SESSION_SECRET, so either side can
 *  mint and the web route verifies both. */
function secret(): string {
  return process.env.SESSION_SECRET ?? "dev-only-not-a-secret";
}

export function signOpUnsub(operatorId: string): string {
  const sig = createHmac("sha256", secret())
    .update(`opunsub:${operatorId}`)
    .digest("hex");
  return `${operatorId}.${sig}`;
}

/** Returns the operatorId when the MAC verifies, else null. */
export function verifyOpUnsub(
  token: string | undefined | null,
): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const operatorId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (sig.length !== 64) return null;
  const expect = createHmac("sha256", secret())
    .update(`opunsub:${operatorId}`)
    .digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return operatorId;
}
