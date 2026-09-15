import { getVertical } from "@jetmarket/verticals";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { RfqForm, type RfqFieldView } from "@/components/rfq-form";
import { getRepo } from "@/lib/repo";

export default async function RfqPage({
  params,
}: {
  params: Promise<{ listingId: string }>;
}) {
  const { listingId } = await params;
  const vertical = getVertical();
  const t = await getTranslations("rfq");
  const vt = await getTranslations(vertical.copy.namespace);
  const repo = getRepo();
  const listing = repo.getListing(listingId);
  if (!listing || listing.status !== "active") notFound();

  const fields: RfqFieldView[] = vertical.rfqFields.map((f) => ({
    key: f.key,
    label: vt(f.labelKey),
    type: f.type,
    required: f.required,
    ...(f.groupKey ? { group: f.groupKey } : {}),
    ...(f.placeholderKey ? { placeholder: vt(f.placeholderKey) } : {}),
    ...(f.options
      ? {
          options: f.options.map((o) => ({
            value: o.value,
            label: vt(o.labelKey),
          })),
        }
      : {}),
  }));

  const groupLabels: Record<string, string> = {};
  for (const f of vertical.rfqFields) {
    if (f.groupKey) groupLabels[f.groupKey] = t(`groups.${f.groupKey}`);
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">
        {t("subtitle")} {t("forListing", { title: listing.title })}
      </p>
      <div className="mt-6">
        <RfqForm
          listingId={listing.id}
          fields={fields}
          groupLabels={groupLabels}
          submitLabel={t("submit")}
          sendingLabel={t("sending")}
          errorLabel={t("error")}
          rateLimitedLabel={t("rateLimited")}
          honeypotHint={t("honeypotHint")}
          emailFieldKey="email"
        />
      </div>
    </main>
  );
}
