import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations("common");
  return (
    <main className="mx-auto max-w-6xl px-6 py-16" role="status" aria-live="polite">
      <div className="h-8 w-64 animate-pulse rounded bg-surface" />
      <div className="mt-4 h-4 w-96 max-w-full animate-pulse rounded bg-surface" />
      <p className="sr-only">{t("loading")}</p>
    </main>
  );
}
