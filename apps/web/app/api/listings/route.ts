import { z } from "zod";
import { err, ok, parseBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { verticalConfig, verticalSlug } from "@/lib/vertical";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const facets: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k.startsWith("f_")) facets[k.slice(2)] = v;
  }
  const listings = await (await getRepo()).listListings({
    status: "active",
    vertical: verticalSlug(),
    ...(url.searchParams.get("type")
      ? { type: url.searchParams.get("type")! }
      : {}),
    ...(url.searchParams.get("q") ? { query: url.searchParams.get("q")! } : {}),
    ...(Object.keys(facets).length ? { facets } : {}),
  });
  const repo = await getRepo();
  return ok(
    await Promise.all(
      listings.map(async (l) => ({
        ...l,
        operator: (await repo.getOperator(l.operatorId)) ?? null,
      })),
    ),
  );
}

const CreateListing = z.object({
  type: z.string().min(1),
  title: z.string().min(4).max(160),
  attributes: z.record(z.string(), z.unknown()).default({}),
  price: z.number().nonnegative(),
  currency: z.string().length(3).default("USD"),
  photos: z.array(z.string()).default([]),
});

export async function POST(req: Request) {
  const user = await requireUser("operator");
  if (!user) return err("sign in as an operator first", 401);
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

  if (
    operator.plan === "free" &&
    await repo.countOperatorListings(operator.id) >= FREE_LISTING_LIMIT
  ) {
    return err(
      `free plan allows ${FREE_LISTING_LIMIT} listings — upgrade to Pro`,
      402,
      { upgrade: true },
    );
  }

  const listing = await repo.createListing({
    operatorId: operator.id,
    vertical: verticalSlug(),
    type: data!.type,
    title: data!.title,
    attributes: data!.attributes ?? {},
    price: data!.price,
    currency: data!.currency ?? "USD",
    photos: data!.photos ?? [],
  });
  return ok(listing, 201);
}
