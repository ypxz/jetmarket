"use client";

import { Link } from "@/i18n/navigation";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface ListingTypeOpt {
  slug: string;
  labelKey: string;
}
interface AttributeView {
  key: string;
  labelKey: string;
  appliesTo: string[];
  unitKey?: string;
  input: "select" | "number" | "text" | "date";
  required: boolean;
  options?: string[];
}
const FALLBACK_TYPES: ListingTypeOpt[] = [
  { slug: "charter", labelKey: "listingTypes.charter" },
  { slug: "empty_leg", labelKey: "listingTypes.empty_leg" },
  { slug: "aircraft_sale", labelKey: "listingTypes.aircraft_sale" },
];

export default function NewListingPage() {
  const t = useTranslations("app.newListing");
  const tv = useTranslations();
  const router = useRouter();
  const [types, setTypes] = useState<ListingTypeOpt[]>(FALLBACK_TYPES);
  const [attrs, setAttrs] = useState<AttributeView[]>([]);
  const [type, setType] = useState<string>("charter");
  const [vertical, setVertical] = useState<string>("jets");
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/vertical")
      .then((r) => r.json())
      .then(
        (c: {
          slug?: string;
          listingTypes?: ListingTypeOpt[];
          attributes?: AttributeView[];
        }) => {
          if (c.slug) setVertical(c.slug);
          if (c.listingTypes?.length) {
            setTypes(c.listingTypes);
            setType((cur) =>
              c.listingTypes!.some((t) => t.slug === cur)
                ? cur
                : c.listingTypes![0]!.slug,
            );
          }
          if (c.attributes) setAttrs(c.attributes);
        },
      )
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setLimitHit(false);
    const f = new FormData(e.currentTarget);
    const attributes: Record<string, unknown> = {};
    for (const a of attrs) {
      if (!a.appliesTo.includes(type)) continue;
      const v = f.get(`attr_${a.key}`);
      if (v === null || v === "") continue;
      attributes[a.key] = a.input === "number" ? Number(v) : v;
    }
    try {
      const res = await fetch("/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          title: f.get("title"),
          attributes,
          price: Number(f.get("price") || 0),
          currency: "USD",
          photos: [],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPending(false);
        setError(data.error ?? t("failed"));
        if (res.status === 402) setLimitHit(true);
        return;
      }
      router.push("/app");
      router.refresh();
    } catch {
      setPending(false);
      setError(t("failed"));
    }
  }

  const input =
    "w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm";
  const visible = attrs.filter((a) => a.appliesTo.includes(type));

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          data-testid="listing-type"
          className={input}
        >
          {types.map((opt) => (
            <option key={opt.slug} value={opt.slug}>
              {tv(`vertical.${vertical}.${opt.labelKey}`)}
            </option>
          ))}
        </select>
        <input
          name="title"
          required
          placeholder={t("titlePh")}
          data-testid="listing-title"
          className={input}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {visible.map((a) => {
            const label = tv(`vertical.${vertical}.${a.labelKey}`);
            const unit = a.unitKey
              ? ` (${tv(`vertical.${vertical}.${a.unitKey}`)})`
              : "";
            if (a.input === "select") {
              return (
                <select
                  key={a.key}
                  name={`attr_${a.key}`}
                  required={a.required}
                  defaultValue=""
                  data-testid={`listing-${a.key}`}
                  className={input}
                >
                  <option value="" disabled>
                    {label}
                  </option>
                  {(a.options ?? []).map((v) => (
                    <option key={v} value={v}>
                      {tv(`vertical.${vertical}.categories.${v}`)}
                    </option>
                  ))}
                </select>
              );
            }
            return (
              <input
                key={a.key}
                name={`attr_${a.key}`}
                type={
                  a.input === "number" ? "number" : a.input === "date" ? "date" : "text"
                }
                min={a.input === "number" ? 0 : undefined}
                required={a.required}
                placeholder={`${label}${unit}`}
                data-testid={`listing-${a.key}`}
                className={input}
              />
            );
          })}
        </div>
        <input
          name="price"
          type="number"
          required
          min={0}
          placeholder={t("pricePh")}
          data-testid="listing-price"
          className={input}
        />
        <button
          type="submit"
          disabled={pending}
          data-testid="listing-save"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? t("publishing") : t("publish")}
        </button>
        {error ? (
          <div className="rounded-md border border-border bg-surface p-3 text-sm">
            <p className="text-[color:var(--color-danger)]">{error}</p>
            {limitHit ? (
              <Link
                href="/app/billing"
                className="mt-1 inline-block font-medium text-primary underline"
                data-testid="upgrade-cta"
              >
                {t("upgradeCta")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </form>
    </main>
  );
}
