import { err, ok } from "@/lib/api";
import { applyPaymentEvent } from "@/lib/billing";
import { getRepo } from "@/lib/repo";
import { paymentsProvider, paymentsProviderName } from "@jetmarket/providers";

/**
 * Provider webhook entry point. Raw body + `stripe-signature` header go
 * through `handleWebhook` (mock: plain JSON; stripe: signature-verified),
 * then the normalized event updates subscription + operator plan.
 *
 * Mock mode has no signature to verify — the real checkout emulates this
 * webhook in-process, so the HTTP route only serves tools/tests that know
 * MOCK_WEBHOOK_SECRET. Without the env var the mock route stays closed
 * (QA-40: unsigned free-Pro activation for any operatorId otherwise).
 */
export async function POST(req: Request) {
  if (paymentsProviderName() === "mock") {
    const secret = process.env.MOCK_WEBHOOK_SECRET;
    if (!secret || req.headers.get("x-mock-webhook-secret") !== secret) {
      return err("forbidden", 403);
    }
  }
  const raw = await req.text();
  const signature = req.headers.get("stripe-signature");
  let event;
  try {
    event = await paymentsProvider().handleWebhook(raw, signature);
  } catch (e) {
    return err(
      `invalid webhook: ${e instanceof Error ? e.message : String(e)}`,
      400,
    );
  }
  const applied = await applyPaymentEvent(await getRepo(), event);
  return ok({ received: true, kind: event.kind, applied });
}
