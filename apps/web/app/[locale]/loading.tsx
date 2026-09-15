import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("common");
  return (
    <main className="mx-auto max-w-5xl px-6 py-16" role="status" aria-live="polite">
      <div className="h-6 w-40 animate-pulse rounded bg-surface" />
      <p className="mt-4 text-sm text-muted">{t("loading")}</p>
    </main>
  );
}
