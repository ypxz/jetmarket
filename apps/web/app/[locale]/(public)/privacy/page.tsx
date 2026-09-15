import { getTranslations } from "next-intl/server";
import { site } from "@jetmarket/config";

interface Section {
  h: string;
  body: string;
}

export default async function PrivacyPage() {
  const t = await getTranslations("legal.privacy");
  const sections = t.raw("sections") as Section[];
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6" data-testid="legal-privacy">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">
        {t("updated", { date: "2026-09-15" })}
      </p>
      <div className="mt-8 space-y-6">
        {sections.map((s) => (
          <section key={s.h}>
            <h2 className="text-lg font-semibold">{s.h}</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              {s.body
                .replaceAll("{entity}", site.legal.entityName)
                .replaceAll("{email}", site.legal.contactEmail)}
            </p>
          </section>
        ))}
      </div>
    </main>
  );
}
