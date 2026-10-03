import { getAttributesSchema } from "@jetmarket/verticals";
import { z } from "zod";
import { clientIp, err, ok, parseBody, rateLimit } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { PlanCapError, publicOperator } from "@/lib/repo/types";
import { appOrigin } from "@/lib/origin";
import { listingFilterFor, SEARCH_PAGE_SIZE } from "@/lib/search";
import { alertSavedSearches } from "@/lib/search-alerts";
import { verticalConfig, verticalSlug } from "@/lib/vertical";
import { analyticsProvider } from "@jetmarket/providers";

export async function GET(req: Request) {
  // Public search runs LIKE/facet queries — keep it cheap per IP so a
  // scraper can't sit on the DB (QA-107).
  if (!rateLimit(`listing-search:${clientIp(req)}`, 240, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const url = new URL(req.url);
  // Facets are whitelisted to the vertical's declared set (QA-143) — raw
  // `f_*` keys used to hit `attributes ->> ?` with arbitrary paths.
  const filter = listingFilterFor(
    Object.fromEntries(url.searchParams.entries()),
  );
  // Optional ?limit/&offset= cap the payload; default is one page (QA-66).
  const lim = Number(url.searchParams.get("limit"));
  const off = Number(url.searchParams.get("offset"));
  const repo = await getRepo();
  const listings = await repo.listListings({
    ...filter,
    limit: Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 200) : SEARCH_PAGE_SIZE,
    offset: Number.isInteger(off) && off >= 0 ? off : 0,
  });
  // Batched operator join — one inArray query for the whole page (QA-104).
  const opById = new Map(
    (
      await repo.listOperators({
        ids: [...new Set(listings.map((l) => l.operatorId))],
      })
    ).map((o) => [o.id, publicOperator(o)] as const),
  );
  return ok(
    listings.map((l) => ({
      ...l,
      operator: opById.get(l.operatorId) ?? null,
    })),
  );
}

const CreateListing = z.object({
  type: z.string().min(1).max(60),
  title: z.string().min(4).max(160),
  attributes: z.record(z.string(), z.unknown()).default({}),
  price: z.number().positive().max(1e9),
  // Defaults to the active vertical's currency; a mismatched code is rejected
  // — a EUR listing in the USD jets pool would sort/facet against raw minor
  // units in the wrong denomination (QA-185).
  currency: z.string().length(3).optional(),
  photos: z.array(z.string().max(300)).max(12).default([]),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  if (!rateLimit(`listing:${clientIp(req)}`, 40, 60 * 60 * 1000)) {
    return err("rate limit exceeded — try again later", 429);
  }
  const repo = await getRepo();
  const operator = await repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { data, error } = await parseBody(req, CreateListing);
  if (error) return error;

  const config = verticalConfig();
  if (!config.listingTypes.some((t) => t.slug === data!.type)) {
    return err(
      `unknown listing type "${data!.type}" for vertical ${config.slug}`,
      422,
      { allowed: config.listingTypes.map((t) => t.slug) },
    );
  }

  // Attributes present in the payload are validated against the vertical's
  // zod schema for this listing type (e.g. seats >= 1); missing keys are
  // tolerated, unknown keys stripped.
  if (data!.currency !== undefined && data!.currency !== config.currency) {
    return err(
      `listings in the ${config.slug} vertical are priced in ${config.currency}`,
      422,
      { allowed: [config.currency] },
    );
  }
  const attrs = getAttributesSchema(config, data!.type)
    .partial()
    .safeParse(data!.attributes ?? {});
  if (!attrs.success) {
    return err("invalid attributes", 422, attrs.error.issues);
  }

  // The cap is enforced atomically inside createListing (operator row lock) —
  // a check here would race a concurrent create.

  // Photos must point at this operator's own uploads — an arbitrary key
  // would render someone else's images (or a broken image) on the listing.
  const photoPrefix = `uploads/${user.id}/`;
  if ((data!.photos ?? []).some((k) => !k.startsWith(photoPrefix))) {
    return err("photos must come from your own uploads", 422);
  }

  let listing;
  try {
    listing = await repo.createListing(
      {
        operatorId: operator.id,
        vertical: verticalSlug(),
        type: data!.type,
        title: data!.title,
        attributes: attrs.data,
        price: data!.price,
        currency: data!.currency ?? config.currency,
        photos: data!.photos ?? [],
      },
      { cap: operator.plan === "free" ? FREE_LISTING_LIMIT : undefined },
    );
  } catch (e) {
    if (e instanceof PlanCapError) {
      return err(
        `free plan allows ${FREE_LISTING_LIMIT} listings — upgrade to Pro`,
        402,
        { upgrade: true },
      );
    }
    throw e;
  }
  analyticsProvider().track({
    name: "listing_created",
    props: {
      listingId: listing.id,
      type: listing.type,
      vertical: listing.vertical,
    },
  });
  // Saved-search fan-out (QA-403): a fresh listing landing 'active' is an
  // alert event — match/mail/backlog inside, non-fatal by contract.
  if (listing.status === "active") {
    await alertSavedSearches(repo, listing, appOrigin(req));
  }
  return ok(listing, 201);
}
