import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("home");
  return (
    <main className="mx-auto max-w-5xl px-6 py-24">
      <p className="text-sm font-medium text-muted">{t("eyebrow")}</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-tight">
        {t("title")}
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-muted">{t("subtitle")}</p>
    </main>
  );
}
