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

console.log(`smoke done against ${base}`);
