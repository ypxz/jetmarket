# Launch kit — JetMarket

## Post 1 — LinkedIn (founder voice)

**Private jet distribution is stuck in 2005. We're opening it up.**

If you operate charter aircraft, you know the current options: pay Avinode
$318–$2,119 a month for a broker-only network, or pay classified sites for a
static ad next to a phone number. Meanwhile the buyers — the people actually
booking $20k flights — have nowhere public to browse real operator inventory.

JetMarket is the open layer:

→ Operators list charter, empty legs and aircraft for sale — free tier, no card.
→ Buyers send one RFQ; it fans out to every operator whose fleet fits.
→ Quotes come back comparable. Deal closes → we invoice a success fee
  (3 % charter / 1.5 % sales). No deal, no fee. Pro tier is $199/mo flat.

We're live in demo with Zurich/Geneva/Nice/London corridors first.
Operators: first 20 get founding-rate pricing — link in comments.

#privateaviation #bizav #charter #marketplace

## Post 2 — X/Twitter (thread, 5 posts)

1/ Private aviation has a weird secret: the planes already fly empty ~40 % of
the time (positioning legs), yet there's no public marketplace where you can
browse and book them. Brokers guard the inventory. We built the open layer:
JetMarket.

2/ How it works — operator side: list charter, empty legs, or aircraft for sale.
Free tier: 3 listings, no card. Get RFQs from real buyers → quote → mark won →
3 % success fee only when it closes. Pro: $199/mo, unlimited listings + analytics.

3/ Buyer side: browse real inventory, filter by route/date/seats/category, send
ONE request. It fans out to every operator whose fleet fits. Comparable quotes,
no $395 booking fee, no $50k deposit walls.

4/ Why now: incumbents charge $318–2,119/mo fixed for insider networks. A slow
month costs the same as a good one. We flipped it — pay for distribution only
when distribution works.

5/ Live demo link in bio. Zurich–Nice–London corridors first, expanding with
supply. Operators: DM for founding rates. 🛩️

## Post 3 — Indie Hackers / forum-style

**Show IH: JetMarket — a marketplace for private jet charter, empty legs and aircraft sales**

Hey IH — built a two-sided marketplace in a domain that's still run on
spreadsheets and $2k/mo insider tools.

**The problem:** charter distribution = B2B networks (Avinode, CharterPad) that
buyers can't touch, plus consumer apps (XO) that hide operators behind
membership walls. ~40 % of private flights fly empty as repositioning legs and
there's no open channel to sell them.

**The product:** operators list charter/empty-legs/aircraft-for-sale on public
storefronts; buyers send one structured RFQ that fans out to matching operators;
quotes come back comparable; deal closes → success fee invoice.

**Monetization:** operator-first. Free tier (3 listings, delayed RFQs) →
Pro $199/mo (unlimited, instant RFQs, analytics) → 3 % success fee on closed
charters, 1.5 % on aircraft sales. Benchmarked against Avinode's $318–2,119/mo
fixed — we undercut AND align with results.

**Stack:** Next.js 15 + Postgres + Drizzle, vertical-config architecture so the
same engine re-skins into machinery and other high-ticket verticals. Every
external service sits behind a provider adapter (mock/Stripe/Supabase/Resend/
Turnstile) so the whole thing runs offline in mock mode.

**Distribution plan:** SEO route pages ("empty legs Zurich–Nice"), direct
operator outreach from public EBAA/ARGUS/WYVERN directories, founding-operator
rates for the first 20.

Ask me anything — happy to share the RFQ fan-out matching design or the
vertical-config approach.

## 10 SEO page titles (empty-leg routes, seed for `vertical.seo.landingPages`)

1. Empty Legs Zurich–Nice — Charter a Private Jet at Up to 50% Off
2. Empty Leg Flights Geneva–London — Same Aircraft, Fraction of the Price
3. Empty Legs Zurich–London Luton — Private Jet Deals This Week
4. Geneva–Paris Le Bourget Empty Legs — One-Way Private Flights
5. Zurich–Ibiza Empty Legs — Summer Repositioning Flights
6. London–Nice Côte d'Azur Empty Legs — Fly Private for Less
7. Geneva–Palma de Mallorca Empty Legs — Island Repositioning Deals
8. Zurich–Milan Linate Empty Legs — 45-Minute Private Hops
9. Nice–London Empty Leg Returns — South of France to UK
10. Empty Legs Basel–Nice — Business-Aviation Routes, Discounted

(Pattern: `empty-legs-<origin>-<destination>`; each page lists live matching
listings + an RFQ CTA. Slugs generated from `vertical.seo.landingPages`.)

## Demo script (5 min)

0:00–0:30 — **Hook.** Open landing page. "Private jets fly empty ~40 % of the
time. There's no public marketplace for them — until this." Show hero + search.

0:30–1:30 — **Buyer flow.** Search empty legs Zurich→Nice. Facets: category,
seats, date. Open a Phenom 300 listing — photos, seats/range, verification badge
on operator, price. Click "Request quote": RFQ form (route, dates, pax, budget).
Submit.

1:30–2:30 — **The fan-out.** Explain: RFQ matched to listing's operator + N
others whose fleet fits. Show operator inbox — the RFQ arrived.

2:30–3:30 — **Operator flow.** Sign in as operator (mock magic link). Create a
listing live: type empty_leg, Challenger 350, route GVA–LHR, price, photos via
storage mock. Show RFQ → send a quote.

3:30–4:15 — **Close the loop.** Buyer accepts a quote → deal record → success-fee
invoice appears in admin ledger (3 % computed). Then operator upgrades to Pro via
mock checkout — 3-listing limit lifts.

4:15–5:00 — **The twist.** `VERTICAL=machinery` → same engine, different vertical.
"This isn't a jet site — it's a high-ticket marketplace engine. Jets is proof one."
Close on pricing slide: free / $199 Pro / 3 %–1.5 % success fee.
