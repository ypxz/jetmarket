# Operator outreach — JetMarket

Goal: first 20 operators onboarded as founding supply. Public directories used
for names/approach only — **no scraping**; contacts are looked up individually
on company sites.

## Outreach email

**Subject options:**
- `Your fleet, listed where buyers actually look — free`
- `Avinode is $318/mo whether it sells or not. We're $0 until it does.`

**Body:**

> Hi {operator_name},
>
> I'm launching JetMarket — an open marketplace where charter operators list
> aircraft directly to retail buyers: charter trips, empty legs, and aircraft
> for sale.
>
> The short version:
> - **Free to start** — 3 live listings, RFQs from real buyers, no card.
> - **Pro $199/mo** — unlimited listings, instant RFQs, analytics. For reference,
>   Avinode's operator tier starts at $318/mo and never touches the retail side.
> - **Success fee only when it closes** — 3 % on charter, 1.5 % on sales.
>   A slow month costs you nothing extra.
>
> Empty legs are where operators lose the most money — roughly 40 % of flights
> fly empty as positioning legs with no public channel to sell them. That's the
> inventory we surface first.
>
> We're onboarding 20 founding operators at locked-in rates before public launch.
> You'd be listed alongside {peer_operator} on {corridor, e.g. "the ZRH–NCE
> corridor"}. 15 minutes to list your first aircraft — want me to set up your
> storefront?
>
> {sender_name}
> JetMarket — marketplace, not a broker. Contracts stay between you and the buyer.

**Follow-up (day +5, one line):** "Still happy to set up your storefront myself —
first 20 operators keep founding rates."

## First 20 operators (names + approach)

Sourced from public directories — see next section. Weighted toward
small/mid-size European operators on our ZRH/GVA/NCE/LTN corridors: they feel
Avinode's fixed fees hardest and are most likely to try a $0 entry channel.
Flagships (VistaJet, NetJets) included for credibility outreach; lower probability.

| # | Operator | Base | Why |
|---|---|---|---|
| 1 | Jet Aviation Business Jets | Zurich/Basel | Flagship Swiss operator; large managed fleet |
| 2 | TAG Aviation | Geneva | Big Geneva fleet; charter-heavy |
| 3 | Comlux Aviation | Zurich | VIP charter + own fleet |
| 4 | ExecuJet (Luxaviation) | Zurich | Mid/large cabin charter, Europe-wide |
| 5 | Nomad Aviation | Samedan/Zurich | Alpine operator, Samedan base — strong ski-season fit |
| 6 | Cat Aviation | Zurich | Swiss owner-operator, Falcon/Gulfstream types |
| 7 | Premium Jet | Basel/Zurich | Basel-base charter, Phenom/Challenger class |
| 8 | Air-Dynamic | Lugano | Southern Switzerland base, helicopter+jet mix |
| 9 | Swiss Private Jet / Fly7 | Lausanne | Romandie operator, European hops |
| 10 | GlobeAir | Hörsching (AT) | Europe's largest VLJ fleet — heaviest empty-leg generator in our region |
| 11 | VistaJet | Malta/global | Flagship; program model, low fit — credibility outreach |
| 12 | NetJets Europe | fractional | Low probability (fractional model), include for completeness |
| 13 | Luxaviation Group | Luxembourg | Large managed-fleet group; ExecuJet parent |
| 14 | Avcon Jet | Vienna | Big Austrian operator, mixed fleet |
| 15 | International Jet Management (IJM) | Vienna | Mid/heavy managed fleet |
| 16 | MJet | Vienna | ACJ/heavy specialist |
| 17 | Sparfell Luftfahrt | Vienna | Boutique, long-range types |
| 18 | Tyrolean Jet Services | Innsbruck | Alpine base, light/mid charter |
| 19 | DC Aviation | Stuttgart | German charter operator, Challenger/Global |
| 20 | Air Hamburg | Hamburg | High-volume light-jet operator (Citation Mustang/Phenom) — strong empty-leg seller |

Reserve/next-in-line: Elitavia (Ljubljana/Malta), Art Aviation (Zurich), BHS
Aviation (Munich), Centair (Geneva), Skynex?, Sparfell's Geneva office.

**Approach:** start with #4–10, 14–20 (SMB operators, 2–30 aircraft) — highest
pain-to-close ratio. Flagships (#1–3, 11–12) go through their charter-sales /
marketing contacts with a "featured founding operator" angle rather than the
cost pitch.

## Source directories (public — browse, don't scrape)

| Directory | What it gives | Access |
|---|---|---|
| **EBAA member directory** (ebaa.org) | European business-aviation operators incl. small charter cos | public browse |
| **ARGUS CHEQ registry** (argus.aero) | safety-rated operator list — doubles as our verification shortlist | public lookup |
| **WYVERN Wingman directory** (wyvernltd.com) | vetted operator list | public lookup |
| **The Air Charter Association** member list (theaircharterassociation.org) | operators + brokers, UK-heavy | public |
| **NBAA member directory** | large, global | public |
| **MEBAA directory** | Middle East/North Africa (expansion) | public |
| **BACA** (Baltic Air Charter Assoc.) | brokers + operators | public |
| **Aviapages / aircharterguide** | operator directories by base airport | public browse |

**Verification angle for product:** when an operator claims ARGUS/WYVERN/
EBAA membership during signup, admin checks the public registry — feeds the
`verified` badge (spec: manual verification, unverified = badge + RFQ delay).

## Notes for seed worker (T11)

Operators in seed data should echo this shape: ~15 operators, mostly 2–15
aircraft, based at ZRH/GVA/Samedan/Lugano/LTN/FAB/LBG/NCE, mixed categories
weighted light→mid→heavy→ULR. Names stay synthetic.
