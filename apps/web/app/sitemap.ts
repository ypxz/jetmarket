import type { MetadataRoute } from "next";
import { seoSlugs, siteUrl } from "@/lib/seo";
import { getRepo } from "@/lib/repo";
import { browseExpiry } from "@/lib/search";
import { verticalSlug } from "@/lib/vertical";

// Public routes only — app/admin/auth pages are excluded by intent.
// Cached per hour — without revalidate every crawler hit re-runs the
// listing query (up to 1000 rows) and re-serializes the document.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const now = new Date();
  // Only indexable public pages: the home page, legal/imprint, and the
  // dedicated SEO landing slugs. search/quotes/sign-in are no-index surfaces.
  const staticPaths = ["", "tos", "privacy", "imprint"];
  // Live listings are the indexable long tail — cap so a huge inventory
  // can't grow the sitemap unboundedly (search engines cap at 50k/50MB).
  const repo = await getRepo();
  const listings = await repo.listListings({
    vertical: verticalSlug(),
    status: "active",
    limit: 1000,
    ...browseExpiry(),
  });
  // Operator profiles are indexable trust surfaces — one per operator that
  // has at least one active listing (capped alongside the listings cap).
  const operatorIds = [...new Set(listings.map((l) => l.operatorId))];
  return [
    ...staticPaths.map((p) => ({
      url: `${base}/${p}`,
      lastModified: now,
    })),
    ...seoSlugs().map((slug) => ({
      url: `${base}/${slug}`,
      lastModified: now,
    })),
    ...listings.map((l) => ({
      url: `${base}/listing/${l.id}`,
      lastModified: l.createdAt,
    })),
    ...operatorIds.map((id) => ({
      url: `${base}/operators/${id}`,
      lastModified: now,
    })),
  ];
}
