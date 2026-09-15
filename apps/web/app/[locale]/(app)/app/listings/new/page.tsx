"use client";

import { Link } from "@/i18n/navigation";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface ListingTypeOpt {
  slug: string;
  labelKey: string;
}
const FALLBACK_TYPES: ListingTypeOpt[] = [
  { slug: "charter", labelKey: "charter" },
  { slug: "empty_leg", labelKey: "empty_leg" },
  { slug: "aircraft_sale", labelKey: "aircraft_sale" },
];

export default function NewListingPage() {
  const t = useTranslations("app.newListing");
  const router = useRouter();
  const [types, setTypes] = useState<ListingTypeOpt[]>(FALLBACK_TYPES);
  const [type, setType] = useState<string>("charter");
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);

  useEffect(() => {
    fetch("/api/vertical")
      .then((r) => r.json())
      .then((c: { listingTypes?: ListingTypeOpt[] }) => {
        if (c.listingTypes?.length) {
          setTypes(c.listingTypes);
          setType((cur) =>
            c.listingTypes!.some((t) => t.slug === cur)
              ? cur
              : c.listingTypes![0]!.slug,
          );
        }
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLimitHit(false);
    const f = new FormData(e.currentTarget);
    const attributes: Record<string, unknown> = {
      aircraftCategory: f.get("aircraftCategory"),
      model: f.get("model"),
      seats: Number(f.get("seats") || 0),
      rangeNm: Number(f.get("rangeNm") || 0),
    };
    if (f.get("year")) attributes.year = Number(f.get("year"));
    if (type === "empty_leg") {
      attributes.from = f.get("from");
      attributes.to = f.get("to");
      attributes.date = f.get("date");
    }
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
      setError(data.error ?? t("failed"));
      if (res.status === 402) setLimitHit(true);
      return;
    }
    router.push("/app");
    router.refresh();
  }

  const input =
    "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

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
          {types.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.labelKey.replace(/[._]/g, " ")}
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
        <div className="grid grid-cols-2 gap-3">
          <select name="aircraftCategory" data-testid="listing-category" className={input}>
            <option value="light">{t("catLight")}</option>
            <option value="mid">{t("catMid")}</option>
            <option value="super_mid">{t("catSuperMid")}</option>
            <option value="heavy">{t("catHeavy")}</option>
            <option value="ultra_long">{t("catUltra")}</option>
          </select>
          <input name="model" required placeholder={t("modelPh")} data-testid="listing-model" className={input} />
          <input name="year" type="number" placeholder={t("yearPh")} className={input} />
          <input name="seats" type="number" required placeholder={t("seatsPh")} data-testid="listing-seats" className={input} />
          <input name="rangeNm" type="number" placeholder={t("rangePh")} className={input} />
          <input name="price" type="number" required min={0} placeholder={t("pricePh")} data-testid="listing-price" className={input} />
        </div>
        {type === "empty_leg" ? (
          <div className="grid grid-cols-3 gap-3">
            <input name="from" required placeholder={t("fromPh")} data-testid="listing-from" className={input} />
            <input name="to" required placeholder={t("toPh")} data-testid="listing-to" className={input} />
            <input name="date" type="date" required data-testid="listing-date" className={input} />
          </div>
        ) : null}
        <button
          type="submit"
          data-testid="listing-save"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          {t("publish")}
        </button>
        {error ? (
          <div className="rounded-md border border-border bg-surface p-3 text-sm">
            <p className="text-[color:var(--color-danger)]">{error}</p>
            {limitHit ? (
              <Link href="/app/billing" className="mt-1 inline-block font-medium text-primary underline" data-testid="upgrade-cta">
                {t("upgradeCta")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </form>
    </main>
  );
}
