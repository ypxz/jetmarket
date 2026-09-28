import { Badge } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { jobStateVariant } from "@/lib/state-variant";
import { verticalSlug } from "@/lib/vertical";
import { RetryJobButton } from "./retry-button";

export default async function AdminJobsPage() {
  const t = await getTranslations("admin.jobs");
  const user = await currentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const repo = await getRepo();
  const jobs = await repo.listJobs({ limit: 100, vertical: verticalSlug() });

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">
        <Link href="/admin" className="underline">
          {t("backToAdmin")}
        </Link>
      </p>
      <div className="overflow-x-auto">
        <table
          className="mt-4 w-full min-w-3xl text-left text-sm"
          data-testid="jobs-table"
        >
          <thead className="border-b border-border text-muted">
            <tr>
              <th className="py-2 pr-4">{t("colKind")}</th>
              <th className="py-2 pr-4">{t("colStatus")}</th>
              <th className="py-2 pr-4">{t("colAttempts")}</th>
              <th className="py-2 pr-4">{t("colRunAt")}</th>
              <th className="py-2 pr-4">{t("colError")}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {jobs.map((j) => (
              <tr key={j.id} data-testid={`job-${j.id}`}>
                <td className="py-2 pr-4 font-medium">{j.kind}</td>
                <td className="py-2 pr-4">
                  <Badge variant={jobStateVariant(j.status)}>{j.status}</Badge>
                </td>
                <td className="py-2 pr-4">
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="py-2 pr-4 text-muted">
                  {new Date(j.runAt).toLocaleString("en-US")}
                </td>
                <td className="max-w-xs truncate py-2 pr-4 font-mono text-xs text-muted">
                  {j.lastError ?? ""}
                </td>
                <td className="py-2">
                  {j.status === "failed" ? <RetryJobButton jobId={j.id} /> : null}
                </td>
              </tr>
            ))}
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted">
                  {t("empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
