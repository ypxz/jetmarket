import { getTranslations } from "next-intl/server";

/** Global not-found for paths outside the locale tree (default-locale copy;
 * own <html>/<body> since the locale layout does not apply). */
export default async function RootNotFound() {
  const t = await getTranslations({ locale: "en", namespace: "errors" });
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen items-center justify-center p-6">
          <div className="w-full max-w-md rounded-lg border border-border p-8 text-center">
            <h1 className="text-xl font-semibold">{t("notFound")}</h1>
            <p className="mt-2 text-sm text-muted">{t("notFoundBody")}</p>
            <a
              href="/"
              className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
