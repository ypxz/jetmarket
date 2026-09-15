import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { QuoteForm } from "./quote-form";

export default async function RfqInboxPage() {
  const user = await currentUser();
  const repo = await getRepo();
  const operator = user ? await repo.getOperatorByUserId(user.id) : undefined;
  if (!operator) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-muted">Create an operator profile first.</p>
      </main>
    );
  }
  const rfqs = await repo.listRfqs({ operatorId: operator.id });
  const rfqRows = await Promise.all(
    rfqs.map(async (r) => ({
      rfq: r,
      listing: (await repo.getListing(r.listingId)) ?? null,
      quotes: await repo.listQuotes({ rfqId: r.id }),
    })),
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">RFQ inbox</h1>
      {rfqs.length === 0 ? (
        <p className="mt-6 rounded-md border border-dashed border-border p-6 text-sm text-muted" data-testid="rfq-empty">
          No requests yet. Buyers RFQ from your public listing pages.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {rfqRows.map(({ rfq: r, listing, quotes }) => {
            return (
              <li
                key={r.id}
                data-testid={`rfq-${r.id}`}
                className="rounded-md border border-border bg-surface p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{listing?.title ?? "listing"}</div>
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                    {r.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  From {r.buyerEmail} · {new Date(r.createdAt).toLocaleString("en-US")}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  {Object.entries(r.fields).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="text-muted">{k}:</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                {quotes.length > 0 ? (
                  <p className="mt-3 text-sm text-[color:var(--color-success)]">
                    Quote sent — {quotes[0]!.currency} {quotes[0]!.amount.toLocaleString("en-US")} ({quotes[0]!.status})
                  </p>
                ) : (
                  <QuoteForm rfqId={r.id} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
