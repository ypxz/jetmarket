import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

function pageHref(
  params: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || key === "page") continue;
    for (const v of Array.isArray(value) ? value : [value]) sp.append(key, v);
  }
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return `/search${qs ? `?${qs}` : ""}`;
}

export async function SearchPager({
  params,
  page,
  pages,
}: {
  params: Record<string, string | string[] | undefined>;
  page: number;
  pages: number;
}) {
  const t = await getTranslations("search");
  if (pages <= 1) return null;
  const linkCls =
    "rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-surface";
  return (
    <nav
      aria-label={t("pagination")}
      className="mt-6 flex items-center justify-between"
      data-testid="search-pager"
    >
      {page > 1 ? (
        <Link href={pageHref(params, page - 1)} className={linkCls}>
          {t("prev")}
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-muted">
        {t("pageOf", { page, pages })}
      </span>
      {page < pages ? (
        <Link href={pageHref(params, page + 1)} className={linkCls}>
          {t("next")}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
