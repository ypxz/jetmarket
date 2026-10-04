export const locales = ["en", "de"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/**
 * Load the message catalog for a locale. Catalogs live in messages/ as
 * `<locale>.json` and are wired here + in apps/web/i18n/request.ts
 * (check:i18n enforces leaf-key + placeholder parity across them).
 */
export async function getMessages(locale: string) {
  switch (locale) {
    case "de":
      return (await import("../messages/de.json")).default;
    case "en":
    default:
      return (await import("../messages/en.json")).default;
  }
}

export type MailDict = Record<string, Record<string, string>>;

const mailCache = new Map<string, MailDict>();

/**
 * QA-493: mail copy keyed by recipient locale. Mail strings live inside the
 * same catalogs under `mail.*` so check:i18n's leaf/placeholder parity gate
 * covers every locale for free. Unknown/missing locales fall back to en.
 * Used by web routes/libs AND the worker (which renders nudges off the same
 * catalogs) — no next-intl dependency so it works outside request context.
 */
export async function mailCopy(
  locale: string | null | undefined,
): Promise<MailDict> {
  const l = (locales as readonly string[]).includes(locale ?? "")
    ? (locale as string)
    : defaultLocale;
  let hit = mailCache.get(l);
  if (!hit) {
    hit =
      ((await getMessages(l)) as { mail?: MailDict }).mail ?? {};
    mailCache.set(l, hit);
  }
  return hit;
}

/**
 * `{placeholder}` interpolation for mail templates. Mail strings use only
 * flat placeholders — count plurals are expressed as one/many KEY PAIRS in
 * the catalog (English's appended-`s` pattern doesn't translate).
 */
export function mailFmt(
  tpl: string | undefined,
  vars: Record<string, string | number>,
): string {
  return (tpl ?? "").replace(
    /\{([A-Za-z0-9_]+)\}/g,
    (m, k) => (k in vars ? String(vars[k as never]) : m) as string,
  );
}

/**
 * `mailT(dict, "group.key", vars)` — two-level lookup + format in one call.
 * Mail strings are unreachable from `t()` (they're sent, not rendered), and
 * noUncheckedIndexedAccess makes `dict.group.key` always-optional — this
 * helper keeps call sites free of `!` while a missing key just renders "".
 */
export function mailT(
  dict: MailDict,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const dot = key.indexOf(".");
  const tpl =
    dot > 0 ? dict[key.slice(0, dot)]?.[key.slice(dot + 1)] : undefined;
  return mailFmt(tpl, vars);
}
