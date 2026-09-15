import { Card, CardBody } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { site } from "@jetmarket/config";

export default async function ImprintPage() {
  const t = await getTranslations("legal.imprint");
  const l = site.legal;
  const rows: [string, string][] = [
    [t("entityLabel"), l.entityName],
    [
      t("addressLabel"),
      `${l.addressLine1}, ${l.postalCode} ${l.city}, ${l.country}`,
    ],
    [t("registrationLabel"), l.registrationId],
    [t("contactLabel"), l.contactEmail],
  ];
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6" data-testid="legal-imprint">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <Card className="mt-8">
        <CardBody>
          <dl className="divide-y divide-border">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-2 text-sm">
                <dt className="text-muted">{k}</dt>
                <dd className="font-medium text-right">{v}</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    </main>
  );
}
