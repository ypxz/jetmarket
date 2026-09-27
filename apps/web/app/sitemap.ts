import type { MetadataRoute } from "next";
import { seoSlugs, siteUrl } from "@/lib/seo";
import { getRepo } from "@/lib/repo";
import { verticalSlug } from "@/lib/vertical";

// Public routes only — app/admin/auth pages are excluded by intent.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const now = new Date();
  // Only indexable public pages: the home page, legal/imprint, and the
  // dedicated SEO landing slugs. search/quotes/sign-in are no-index surfaces.
  const staticPaths = ["", "tos", "privacy", "imprint"];
  // Live listings are the indexable long tail — cap so a huge inventory
  // can't grow the sitemap unboundedly (search engines cap at 50k/50MB).
  const listings = await (await getRepo()).listListings({
    vertical: verticalSlug(),
    status: "active",
    limit: 1000,
  });
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
  ];
}
