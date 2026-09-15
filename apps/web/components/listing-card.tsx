import { Badge, Card, CardBody } from "@jetmarket/ui";
import { storageProvider } from "@jetmarket/providers";
import { getVertical } from "@jetmarket/verticals";
import type { ComponentType } from "react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { attrsFor, optionLabelKey } from "@/lib/attrs";
import { formatAttribute, formatMoney } from "@/lib/format";
import type { Listing, Operator } from "@/lib/repo/types";

interface ListingCardProps {
  listing: Listing;
  operator?: Operator | null;
}

export async function ListingCard({ listing, operator }: ListingCardProps) {
  const vertical = getVertical();
  const vt = await getTranslations(vertical.copy.namespace);
  const ct = await getTranslations("common");

  // Per-vertical card override (config.components.ListingCard) — TODO: type
  // override components once a vertical ships one.
  const Override = vertical.components?.ListingCard as
    | ComponentType<ListingCardProps>
    | undefined;
  if (Override) return <Override listing={listing} operator={operator} />;

  const attrs = attrsFor(vertical, listing.type)
    .map((a) => {
      const value = listing.attributes[a.key];
      if (value === undefined || value === null || value === "") return null;
      const optKey = optionLabelKey(vertical, a, String(value));
      const unit = a.unitKey ? vt(a.unitKey) : undefined;
      return optKey ? vt(optKey) : formatAttribute(value, unit);
    })
    .filter(Boolean);

  const route =
    listing.attributes.from && listing.attributes.to
      ? `${listing.attributes.from} → ${listing.attributes.to}`
      : null;

  return (
    <Link href={`/listing/${listing.id}`} className="block" data-testid="listing-card">
      <Card className="h-full transition-shadow hover:shadow-pop">
        {listing.photos[0] ? (
          <img
            src={storageProvider().url(listing.photos[0])}
            alt={listing.title}
            data-testid="listing-photo"
            className="aspect-[4/3] w-full rounded-t-lg border-b border-border object-cover"
          />
        ) : null}
        <CardBody>
          <div className="flex items-center justify-between gap-2">
            <Badge>{vt(`listingTypes.${listing.type}`)}</Badge>
            <span className="text-sm font-semibold">
              {formatMoney(listing.price, listing.currency)}
            </span>
          </div>
          <p className="mt-2 font-medium leading-snug">{listing.title}</p>
          {route ? (
            <p className="mt-1 text-sm font-medium text-primary">{route}</p>
          ) : null}
          {attrs.length ? (
            <p className="mt-1 text-sm text-muted">{attrs.join(" · ")}</p>
          ) : null}
          {operator ? (
            <p className="mt-3 text-xs text-muted">
              {operator.name}{" "}
              {operator.verified ? (
                <Badge variant="success">{ct("verified")}</Badge>
              ) : (
                <Badge variant="warning">{ct("unverified")}</Badge>
              )}
            </p>
          ) : null}
        </CardBody>
      </Card>
    </Link>
  );
}
