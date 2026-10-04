import { currentUser } from "@/lib/auth";

/** Dual mailbox proof for buyer actions (QA-474). Two ways in:
 *
 *  1. **Session** — a signed-in buyer whose `user.email` equals the RFQ's
 *     `buyerEmail` owns the mailbox outright; no bearer token needed (the
 *     /account + /quotes session path).
 *  2. **Bearer token** — the emailed-link path: claimed email must match
 *     the RFQ's `buyerEmail` AND `token` must equal `accessToken`.
 *
 *  A session user claiming someone else's mailbox fails both arms (their
 *  session email won't match, and an empty/mismatched token won't either),
 *  so callers keep their uniform "not found" 404.
 */
export async function buyerAuthorized(
  rfq: { buyerEmail: string; accessToken: string },
  input: { buyerEmail: string; token?: string },
): Promise<boolean> {
  const user = await currentUser();
  if (
    user &&
    user.email.toLowerCase() === rfq.buyerEmail.toLowerCase()
  ) {
    return true;
  }
  return (
    rfq.buyerEmail.toLowerCase() === input.buyerEmail.toLowerCase() &&
    rfq.accessToken === (input.token ?? "")
  );
}
