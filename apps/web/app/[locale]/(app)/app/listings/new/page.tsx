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
  { slug: "charter", labelKey: "listingTypes.charter" },
  { slug: "empty_leg", labelKey: "listingTypes.empty_leg" },
  { slug: "aircraft_sale", labelKey: "listingTypes.aircraft_sale" },
];

export default function NewListingPage() {
  const t = useTranslations("app.newListing");
  const tv = useTranslations();
  const router = useRouter();
  const [types, setTypes] = useState<ListingTypeOpt[]>(FALLBACK_TYPES);
  const [type, setType] = useState<string>("charter");
  const [vertical, setVertical] = useState<string>("jets");
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetch("/api/vertical")
      .then((r) => r.json())
      .then((c: { slug?: string; listingTypes?: ListingTypeOpt[] }) => {
        if (c.slug) setVertical(c.slug);
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
    if (pending) return;
    setPending(true);
    setError(null);
    setLimitHit(false);
    const f = new FormData(e.currentTarget);
    const attributes: Record<string, unknown> = {
      aircraftCategory: f.get("aircraftCategory"),
      model: f.get("model"),
    };
    if (f.get("seats")) attributes.seats = Number(f.get("seats"));
    if (f.get("rangeNm")) attributes.rangeNm = Number(f.get("rangeNm"));
    if (f.get("year")) attributes.year = Number(f.get("year"));
    if (type === "empty_leg") {
      attributes.from = f.get("from");
      attributes.to = f.get("to");
      attributes.date = f.get("date");
    }
    try {
      const files = f
        .getAll("photos")
        .filter((v): v is File => v instanceof File && v.size > 0);
      const photos: string[] = [];
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        const up = await fetch("/api/uploads", { method: "POST", body });
        const upData = await up.json();
        if (!up.ok) throw new Error(upData.error ?? t("failed"));
        photos.push(upData.key);
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
          photos,
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input name="from" required placeholder={t("fromPh")} data-testid="listing-from" className={input} />
            <input name="to" required placeholder={t("toPh")} data-testid="listing-to" className={input} />
            <input name="date" type="date" required data-testid="listing-date" className={input} />
          </div>
        ) : null}
        <label className="block text-sm text-muted">
          {t("photosLabel")}
          <input
            name="photos"
            type="file"
            accept="image/*"
            multiple
            data-testid="listing-photos"
            className={`${input} mt-1 file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-3 file:py-1 file:text-sm`}
          />
        </label>
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
