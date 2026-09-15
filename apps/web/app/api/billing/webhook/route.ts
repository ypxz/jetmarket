import { err, ok } from "@/lib/api";
import { applyPaymentEvent } from "@/lib/billing";
import { getRepo } from "@/lib/repo";
import { paymentsProvider } from "@jetmarket/providers";

/**
 * Provider webhook entry point. Raw body + `stripe-signature` header go
 * through `handleWebhook` (mock: plain JSON; stripe: signature-verified),
 * then the normalized event updates subscription + operator plan.
 */
export async function POST(req: Request) {
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
