import {
  nonContactFields,
  type ListingTypeSlug,
  type VerticalConfig,
} from "@jetmarket/verticals";
import type { Rfq } from "./repo/types";
import { rfqDeadlineAt } from "./rfq-deadline";

/**
 * Operator-facing view of an RFQ (QA-152). Contact-detail fields
 * (email/tel-typed) and `buyerEmail` are stripped — the marketplace intro is
 * the fee, so raw contact details stay hidden until the buyer accepts and the
 * winner gets them in the deal-closed email. `accessToken` never leaves this
 * view (an operator holding it could self-accept their own quote, QA-41).
 * `buyerName` gives the operator a display identity that can't be contacted.
 */
export function operatorRfqView(
  rfq: Rfq,
  listingType: ListingTypeSlug | undefined,
  vertical: VerticalConfig,
) {
  return {
    id: rfq.id,
    vertical: rfq.vertical,
    listingId: rfq.listingId,
    status: rfq.status,
    createdAt: rfq.createdAt,
    // QA-482: content-write stamp — the inbox marks "Updated" when this
    // passes the operator's last visit (inboxSeenAt).
    updatedAt: rfq.updatedAt,
    buyerName: typeof rfq.fields["name"] === "string" ? rfq.fields["name"] : null,
    concierge: rfq.concierge,
    // QA-442: derived liveness deadline — non-contact, so it rides the
    // view; the inbox shows when the request stops collecting quotes.
    deadlineAt: rfqDeadlineAt(rfq).toISOString(),
    // QA-533: buyer intake freeze — badge so the operator doesn't burn a
    // quote attempt that would 409.
    ...(rfq.pausedAt ? { pausedAt: rfq.pausedAt } : {}),
    fields: nonContactFields(vertical, listingType, rfq.fields),
  };
}
