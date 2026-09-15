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
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          {site.name}
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/search" className="text-muted hover:text-foreground">
            {t("search")}
          </Link>
          {user?.role === "operator" || user?.role === "admin" ? (
            <Link href="/app" className="text-muted hover:text-foreground">
              {t("operator")}
            </Link>
          ) : null}
          {user?.role === "admin" ? (
            <Link href="/admin" className="text-muted hover:text-foreground">
              {t("admin")}
            </Link>
          ) : null}
          <Link href="/quotes" className="text-muted hover:text-foreground">
            {t("myQuotes")}
          </Link>
          {user ? (
            <span className="text-muted">{user.email}</span>
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
