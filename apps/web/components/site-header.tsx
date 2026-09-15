import { Link } from "@/i18n/navigation";
import { currentUser } from "@/lib/auth";

export async function SiteHeader() {
  const user = await currentUser();
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          JetMarket
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/search" className="text-muted hover:text-foreground">
            Search
          </Link>
          {user?.role === "operator" || user?.role === "admin" ? (
            <Link href="/app" className="text-muted hover:text-foreground">
              Operator
            </Link>
          ) : null}
          {user?.role === "admin" ? (
            <Link href="/admin" className="text-muted hover:text-foreground">
              Admin
            </Link>
          ) : null}
          <Link href="/quotes" className="text-muted hover:text-foreground">
            My quotes
          </Link>
          {user ? (
            <span className="text-muted">{user.email}</span>
          ) : (
            <Link
              href="/sign-in"
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground"
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
