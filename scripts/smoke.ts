/**
 * `pnpm smoke -- --url=https://...` — smoke test against any deploy URL.
 * Checks: landing renders, health endpoint, locale redirect, login page.
 */
const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6)
  ?? args[args.indexOf("--url") + 1]
  ?? process.env.E2E_BASE_URL
  ?? "http://localhost:3000";
const base = urlArg.replace(/\/$/, "");

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

async function get(path: string, redirect: "follow" | "manual" = "follow") {
  const res = await fetch(`${base}${path}`, { redirect });
  return res;
}

await check("GET /api/health", async () => {
  const res = await get("/api/health");
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { ok?: boolean };
  if (body.ok !== true) throw new Error("ok !== true");
});

await check("GET / renders landing", async () => {
  const res = await get("/");
  if (!res.ok) throw new Error(`status ${res.status}`);
  // poweredByHeader: false — no framework fingerprint on responses.
  if (res.headers.get("x-powered-by"))
    throw new Error("x-powered-by emitted");
  const html = await res.text();
  if (!html.toLowerCase().includes("<html")) throw new Error("no html");
});

await check("GET /en/sign-in renders", async () => {
  const res = await get("/en/sign-in");
  if (!res.ok) throw new Error(`status ${res.status}`);
});

await check("GET /en/quotes renders", async () => {
  const res = await get("/en/quotes");
  if (!res.ok) throw new Error(`status ${res.status}`);
});

await check("GET /api/vertical returns config", async () => {
  const res = await get("/api/vertical");
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as { slug?: string; listingTypes?: unknown[] };
  if (!body.slug || !Array.isArray(body.listingTypes)) throw new Error("bad config");
});

await check("GET /api/listings returns seeded listings", async () => {
  const res = await get("/api/listings");
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || body.length === 0)
    throw new Error("no listings");
});

// Operator profile + listing detail pages derive off the same seeded rows —
// catches a broken dynamic route or a publicOperator regression on a deploy.
await check("GET listing + operator pages render", async () => {
  const listings = (await (await get("/api/listings?limit=1")).json()) as {
    id: string;
    operatorId: string;
  }[];
  const l = listings[0];
  if (!l) throw new Error("no listings");
  for (const path of [`/listing/${l.id}`, `/operators/${l.operatorId}`]) {
    const res = await get(path);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    if (!(await res.text()).includes("<h1"))
      throw new Error(`${path} rendered without h1`);
  }
});

await check("GET /robots.txt + /sitemap.xml", async () => {
  const robots = await get("/robots.txt");
  if (!robots.ok) throw new Error(`robots status ${robots.status}`);
  if (!(await robots.text()).includes("Sitemap:"))
    throw new Error("robots has no sitemap line");
  const map = await get("/sitemap.xml");
  if (!map.ok) throw new Error(`sitemap status ${map.status}`);
  if (!(await map.text()).includes("<url>"))
    throw new Error("empty sitemap");
});

// First config-declared SEO landing slug renders — catches a broken
// [slug] route or a slug whose i18n keys went missing on the active vertical.
await check("GET first SEO landing slug renders", async () => {
  const cfg = (await (await get("/api/vertical")).json()) as {
    seo?: { landingPages?: { slug: string }[] };
  };
  const slug = cfg.seo?.landingPages?.[0]?.slug;
  if (!slug) throw new Error("vertical declares no landing pages");
  const res = await get(`/${slug}`);
  if (!res.ok) throw new Error(`/${slug} -> ${res.status}`);
  if (!(await res.text()).includes("<h1"))
    throw new Error(`/${slug} rendered without h1`);
});

console.log(`smoke done against ${base}`);
