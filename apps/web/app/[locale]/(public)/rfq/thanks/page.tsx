import { Card, CardBody, buttonVariants } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function RfqThanksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const t = await getTranslations("rfq");
  const id = Array.isArray(sp.id) ? sp.id[0] : (sp.id ?? "");
  const email = Array.isArray(sp.email) ? sp.email[0] : (sp.email ?? "");

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16 sm:px-6">
      <Card data-testid="rfq-confirmation">
        <CardBody>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("thanksTitle")}
          </h1>
          <p className="mt-2 text-sm text-muted">{t("thanksBody")}</p>
          {id ? (
            <p className="mt-3 text-sm font-medium" data-testid="rfq-reference">
              {t("thanksRef", { id })}
            </p>
          ) : null}
          <Link
            href={`/quotes${email ? `?email=${encodeURIComponent(email)}` : ""}`}
            className={`${buttonVariants()} mt-6`}
            data-testid="rfq-view-quotes"
          >
            {t("viewQuotes")}
          </Link>
        </CardBody>
      </Card>
    </main>
  );
}
