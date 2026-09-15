"use client";

import { readJson } from "@/lib/fetch-json";
import { Link } from "@/i18n/navigation";
import { useRouter } from "@/i18n/navigation";
import type { ClientAttribute } from "@/lib/vertical-input";
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

// Jets fields mirrored so the form stays usable if /api/vertical never
// answers (dev recompile window) — same required-ness as before QA-15.
const FALLBACK_ATTRIBUTES: ClientAttribute[] = [
  {
    key: "aircraftCategory",
    labelKey: "attributes.aircraftCategory",
    appliesTo: ["charter", "empty_leg", "aircraft_sale"],
    input: {
      kind: "select",
      options: ["light", "mid", "super_mid", "heavy", "ultra_long"],
      required: true,
    },
  },
  {
    key: "model",
    labelKey: "attributes.model",
    appliesTo: ["charter", "empty_leg", "aircraft_sale"],
    input: { kind: "text", required: true },
  },
  {
    key: "year",
    labelKey: "attributes.year",
    appliesTo: ["charter", "empty_leg", "aircraft_sale"],
    input: { kind: "number", required: false },
  },
  {
    key: "seats",
    labelKey: "attributes.seats",
    appliesTo: ["charter", "empty_leg", "aircraft_sale"],
    unitKey: "units.seats",
    input: { kind: "number", required: true },
  },
  {
    key: "rangeNm",
    labelKey: "attributes.rangeNm",
    appliesTo: ["charter", "empty_leg", "aircraft_sale"],
    unitKey: "units.nm",
    input: { kind: "number", required: false },
  },
  {
    key: "baseAirport",
    labelKey: "attributes.baseAirport",
    appliesTo: ["charter"],
    input: { kind: "text", required: false },
  },
  {
    key: "from",
    labelKey: "attributes.from",
    appliesTo: ["empty_leg"],
    input: { kind: "text", required: true },
  },
  {
    key: "to",
    labelKey: "attributes.to",
    appliesTo: ["empty_leg"],
    input: { kind: "text", required: true },
  },
  {
    key: "date",
    labelKey: "attributes.date",
    appliesTo: ["empty_leg"],
    input: { kind: "date", required: true },
  },
  {
    key: "hoursTotal",
    labelKey: "attributes.hoursTotal",
    appliesTo: ["aircraft_sale"],
    unitKey: "units.hours",
    input: { kind: "number", required: false },
  },
];

interface VerticalPayload {
  slug?: string;
  listingTypes?: ListingTypeOpt[];
  attributes?: ClientAttribute[];
}

export default function NewListingPage() {
  const t = useTranslations("app.newListing");
  const tv = useTranslations();
  const router = useRouter();
  const [types, setTypes] = useState<ListingTypeOpt[]>(FALLBACK_TYPES);
  const [type, setType] = useState<string>("charter");
  const [vertical, setVertical] = useState<string>("jets");
  const [attrs, setAttrs] = useState<ClientAttribute[]>(FALLBACK_ATTRIBUTES);
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    // Retry once — in dev a route recompile can briefly answer 404/empty,
    // which used to fall through to the jets fallback types.
    const load = () =>
      fetch("/api/vertical").then((r) => readJson<VerticalPayload>(r));
    load()
      .catch(() => new Promise((r) => setTimeout(r, 400)).then(load))
      .then((c) => {
        if (c.slug) setVertical(c.slug);
        if (c.listingTypes?.length) {
          setTypes(c.listingTypes);
          setType((cur) =>
            c.listingTypes!.some((t) => t.slug === cur)
              ? cur
              : c.listingTypes![0]!.slug,
          );
        }
        if (c.attributes?.length) setAttrs(c.attributes);
      })
      .catch(() => {});
  }, []);

  const visibleAttrs = attrs.filter((a) => a.appliesTo.includes(type));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setLimitHit(false);
    const f = new FormData(e.currentTarget);
    const attributes: Record<string, unknown> = {};
    for (const a of visibleAttrs) {
      const v = f.get(a.key);
      if (v === null || v === "") continue;
      attributes[a.key] = a.input.kind === "number" ? Number(v) : v;
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
        const upData = await readJson<{ key: string; error?: string }>(up);
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
      const data = await readJson<{ error?: string; id?: string }>(res);
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
          {visibleAttrs.map((a) => {
            const label = tv(`vertical.${vertical}.${a.labelKey}`);
            const unit = a.unitKey
              ? tv(`vertical.${vertical}.${a.unitKey}`)
              : null;
            const placeholder = unit ? `${label} (${unit})` : label;
            if (a.input.kind === "select") {
              return (
                <select
                  key={a.key}
                  name={a.key}
                  required={a.input.required}
                  defaultValue=""
                  data-testid={`listing-${a.key}`}
                  className={input}
                >
                  <option value="" disabled>
                    {label}
                  </option>
                  {a.input.options!.map((o) => (
                    <option key={o} value={o}>
                      {tv(`vertical.${vertical}.categories.${o}`)}
                    </option>
                  ))}
                </select>
              );
            }
            return (
              <input
                key={a.key}
                name={a.key}
                type={a.input.kind}
                required={a.input.required}
                placeholder={placeholder}
                data-testid={`listing-${a.key}`}
                className={input}
              />
            );
          })}
          <input
            name="price"
            type="number"
            required
            min={0}
            placeholder={t("pricePh")}
            data-testid="listing-price"
            className={input}
          />
        </div>
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
