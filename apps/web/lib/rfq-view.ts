import {
  nonContactFields,
  type ListingTypeSlug,
  type VerticalConfig,
} from "@jetmarket/verticals";
import type { Rfq } from "./repo/types";

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
    buyerName: typeof rfq.fields["name"] === "string" ? rfq.fields["name"] : null,
    fields: nonContactFields(vertical, listingType, rfq.fields),
  };
}
