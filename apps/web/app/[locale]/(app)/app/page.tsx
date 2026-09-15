import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT, PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { getRepo } from "@/lib/repo";

export default async function OperatorDashboard() {
  const user = await currentUser();
  const repo = getRepo();
  const operator = user ? repo.getOperatorByUserId(user.id) : undefined;

  if (!operator) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Become an operator</h1>
        <p className="mt-2 text-muted">
          Create your operator profile to list aircraft and receive RFQs.
        </p>
        <Link
          href="/app/onboarding"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
          data-testid="onboarding-cta"
        >
          Create operator profile
        </Link>
      </main>
    );
  }

  const listings = repo.listListings({ operatorId: operator.id });
  const rfqs = repo.listRfqs({ operatorId: operator.id });
  const sub = repo.getSubscription(operator.id);
  const limit = operator.plan === "pro" ? "∞" : FREE_LISTING_LIMIT;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold" data-testid="operator-name">
            {operator.name}
          </h1>
          <p className="mt-1 text-sm text-muted">
            Base {operator.baseAirport} · {operator.fleetSummary || "fleet TBD"} ·{" "}
            {operator.verified ? (
              <span className="text-[color:var(--color-success)]">verified</span>
            ) : (
              <span className="text-[color:var(--color-accent)]">
                unverified — RFQs arrive with a delay
              </span>
            )}
          </p>
        </div>
        <div className="text-right text-sm">
          <div data-testid="plan-badge" className="font-medium">
            {operator.plan === "pro" ? "Pro plan" : "Free plan"}
          </div>
          {operator.plan === "free" ? (
            <Link href="/app/billing" className="text-primary underline">
              Upgrade — ${PRO_PLAN_PRICE_USD}/mo
            </Link>
          ) : null}
        </div>
      </div>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Listings ({listings.length}/{limit})
          </h2>
          <Link
            href="/app/listings/new"
            data-testid="new-listing-cta"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            New listing
          </Link>
        </div>
        {listings.length === 0 ? (
          <p className="mt-4 rounded-md border border-dashed border-border p-6 text-sm text-muted">
            No listings yet. Create your first charter, empty leg or aircraft sale.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border rounded-md border border-border">
            {listings.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="font-medium">{l.title}</div>
                  <div className="text-xs text-muted">
                    {l.type} · {l.status}
                  </div>
                </div>
                <div className="text-sm font-medium">
                  {l.currency} {l.price.toLocaleString("en-US")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          RFQ inbox ({rfqs.filter((r) => r.status !== "closed").length} open)
        </h2>
        <p className="mt-1 text-sm text-muted">
          <Link href="/app/rfqs" className="text-primary underline">
            Open inbox →
          </Link>
        </p>
      </section>

      {sub ? (
        <p className="mt-10 text-xs text-muted">
          Subscription active until {new Date(sub.currentPeriodEnd).toDateString()}
        </p>
      ) : null}
    </main>
  );
}
