import { buttonVariants } from "@jetmarket/ui";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";
import { site } from "@jetmarket/config";

export async function SiteHeader() {
  const user = await currentUser();
  const t = await getTranslations("nav");
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <Link
          href="/"
          className="shrink-0 text-lg font-semibold tracking-tight"
        >
          {site.name}
        </Link>
        <nav className="flex min-w-0 items-center justify-end gap-3 text-sm sm:gap-4">
          <Link
            href="/search"
            className="shrink-0 text-muted hover:text-foreground"
          >
            {t("search")}
          </Link>
          {user?.role === "operator" || user?.role === "admin" ? (
            <Link
              href="/app"
              className="shrink-0 text-muted hover:text-foreground"
            >
              {t("operator")}
            </Link>
          ) : null}
          {user?.role === "admin" ? (
            <Link
              href="/admin"
              className="shrink-0 text-muted hover:text-foreground"
            >
              {t("admin")}
            </Link>
          ) : null}
          <Link
            href="/quotes"
            className="shrink-0 text-muted hover:text-foreground"
          >
            {t("myQuotes")}
          </Link>
          {user ? (
            <>
              <span className="hidden truncate text-muted md:inline">
                {user.email}
              </span>
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                >
                  {t("signOut")}
                </button>
              </form>
            </>
          ) : (
            <Link href="/sign-in" className={buttonVariants({ size: "sm" })}>
              {t("signIn")}
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
