import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import type { ListingType } from "@/lib/repo/types";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const facets: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k.startsWith("f_")) facets[k.slice(2)] = v;
  }
  const listings = getRepo().listListings({
    status: "active",
    vertical: process.env.VERTICAL ?? "jets",
    ...(url.searchParams.get("type")
      ? { type: url.searchParams.get("type") as ListingType }
      : {}),
    ...(url.searchParams.get("q") ? { query: url.searchParams.get("q")! } : {}),
    ...(Object.keys(facets).length ? { facets } : {}),
  });
  const repo = getRepo();
  return ok(
    listings.map((l) => ({
      ...l,
      operator: repo.getOperator(l.operatorId) ?? null,
    })),
  );
}

const CreateListing = z.object({
  type: z.enum(["charter", "empty_leg", "aircraft_sale"]),
  title: z.string().min(4).max(160),
  attributes: z.record(z.string(), z.unknown()).default({}),
  price: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
  photos: z.array(z.string()).default([]),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
  const repo = getRepo();
  const operator = repo.getOperatorByUserId(user.id);
  if (!operator) return err("create an operator profile first", 409);

  const { data, error } = await parseBody(req, CreateListing);
  if (error) return error;

  if (
    operator.plan === "free" &&
    repo.countOperatorListings(operator.id) >= FREE_LISTING_LIMIT
  ) {
    return err(
      `free plan allows ${FREE_LISTING_LIMIT} listings — upgrade to Pro`,
      402,
      { upgrade: true },
    );
  }

  const listing = repo.createListing({
    operatorId: operator.id,
    vertical: process.env.VERTICAL ?? "jets",
    type: data!.type,
    title: data!.title,
    attributes: data!.attributes ?? {},
    price: data!.price,
    currency: data!.currency ?? "USD",
    photos: data!.photos ?? [],
  });
  return ok(listing, 201);
}
