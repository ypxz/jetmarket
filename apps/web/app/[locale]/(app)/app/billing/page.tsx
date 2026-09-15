import { currentUser } from "@/lib/auth";
import { FREE_LISTING_LIMIT, PRO_PLAN_PRICE_USD } from "@/lib/fees";
import { getRepo } from "@/lib/repo";
import { UpgradeButton } from "./upgrade-button";

export default async function BillingPage() {
  const user = await currentUser();
  const repo = await getRepo();
  const operator = user ? await repo.getOperatorByUserId(user.id) : undefined;
  const sub = operator ? await repo.getSubscription(operator.id) : undefined;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Plan &amp; billing</h1>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-border p-5">
          <h2 className="font-semibold">Free</h2>
          <p className="mt-1 text-sm text-muted">
            {FREE_LISTING_LIMIT} listings · RFQs arrive delayed
          </p>
          <p className="mt-4 text-2xl font-semibold">$0</p>
        </div>
        <div className="rounded-md border-2 border-primary p-5">
          <h2 className="font-semibold">Pro</h2>
          <p className="mt-1 text-sm text-muted">
            Unlimited listings · instant RFQ inbox · analytics
          </p>
          <p className="mt-4 text-2xl font-semibold">
            ${PRO_PLAN_PRICE_USD}<span className="text-sm font-normal text-muted">/mo</span>
          </p>
          {operator?.plan === "pro" ? (
            <p className="mt-3 text-sm font-medium text-[color:var(--color-success)]" data-testid="pro-active">
              Active{sub ? ` until ${new Date(sub.currentPeriodEnd).toDateString()}` : ""}
            </p>
          ) : (
            <UpgradeButton />
          )}
        </div>
      </div>
      <p className="mt-6 text-xs text-muted">
        Success fees are invoiced separately on closed deals: 3% charter / empty
        leg, 1.5% aircraft sale. Checkout runs in mock mode.
      </p>
    </main>
  );
}
