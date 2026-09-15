import { getVertical } from "@jetmarket/verticals";
import { getTranslations } from "next-intl/server";
import { attrsFor, optionLabelKey } from "@/lib/attrs";
import { formatAttribute } from "@/lib/format";
import type { Listing } from "@/lib/repo/types";

/** Attribute table for a listing, labelled via the vertical's copy namespace. */
export async function AttributeTable({ listing }: { listing: Listing }) {
  const vertical = getVertical();
  const vt = await getTranslations(vertical.copy.namespace);

  const rows = attrsFor(vertical, listing.type)
    .map((a) => {
      const value = listing.attributes[a.key];
      if (value === undefined || value === null || value === "") return null;
      const optKey = optionLabelKey(vertical, a, String(value));
      const unit = a.unitKey ? vt(a.unitKey) : undefined;
      return {
        label: vt(a.labelKey),
        value: optKey ? vt(optKey) : formatAttribute(value, unit),
      };
    })
    .filter((r): r is { label: string; value: string } => r !== null);

  return (
    <dl className="divide-y divide-border" data-testid="attribute-table">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between gap-4 py-2 text-sm">
          <dt className="text-muted">{r.label}</dt>
          <dd className="font-medium">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
