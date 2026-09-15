import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { VerifyButton } from "./verify-button";

export default async function AdminPage() {
  const user = await currentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const repo = getRepo();
  const operators = repo.listOperators();
  const deals = repo.listDeals();
  const feeTotal = deals.reduce((s, d) => s + d.feeAmount, 0);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Admin</h1>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Operators ({operators.length})</h2>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Base</th>
              <th className="py-2 pr-4">Plan</th>
              <th className="py-2 pr-4">Listings</th>
              <th className="py-2 pr-4">Verified</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {operators.map((o) => (
              <tr key={o.id} data-testid={`admin-op-${o.id}`}>
                <td className="py-2 pr-4 font-medium">{o.name}</td>
                <td className="py-2 pr-4">{o.baseAirport}</td>
                <td className="py-2 pr-4">{o.plan}</td>
                <td className="py-2 pr-4">{repo.countOperatorListings(o.id)}</td>
                <td className="py-2 pr-4" data-testid={`admin-verified-${o.id}`}>
                  {o.verified ? "yes" : "no"}
                </td>
                <td className="py-2">
                  <VerifyButton operatorId={o.id} verified={o.verified} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">
          Fee ledger ({deals.length} deals · ${feeTotal.toLocaleString("en-US")} fees)
        </h2>
        <table className="mt-3 w-full text-left text-sm" data-testid="fee-ledger">
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">Deal</th>
              <th className="py-2 pr-4">Operator</th>
              <th className="py-2 pr-4">Amount</th>
              <th className="py-2 pr-4">Fee %</th>
              <th className="py-2 pr-4">Fee</th>
              <th className="py-2 pr-4">Invoice</th>
              <th className="py-2">Closed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deals.map((d) => (
              <tr key={d.id} data-testid={`deal-${d.id}`}>
                <td className="py-2 pr-4 font-mono text-xs">{d.id}</td>
                <td className="py-2 pr-4">{repo.getOperator(d.operatorId)?.name}</td>
                <td className="py-2 pr-4">${d.amount.toLocaleString("en-US")}</td>
                <td className="py-2 pr-4">{(d.feePct * 100).toFixed(1)}%</td>
                <td className="py-2 pr-4 font-medium">${d.feeAmount.toLocaleString("en-US")}</td>
                <td className="py-2 pr-4">{d.invoiceStatus}</td>
                <td className="py-2 text-muted">{new Date(d.closedAt).toLocaleDateString("en-US")}</td>
              </tr>
            ))}
            {deals.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted">
                  No closed deals yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </main>
  );
}
