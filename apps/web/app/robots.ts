import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api",
        "/app",
        "/admin",
        "/search",
        "/quotes",
        "/rfq",
        "/sign-in",
        "/en/app",
        "/en/admin",
        "/en/search",
        "/en/quotes",
        "/en/rfq",
        "/en/sign-in",
      ],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
