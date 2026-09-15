"use client";

import { Link } from "@/i18n/navigation";
import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

const TYPES = [
  { value: "charter", label: "Charter (on-demand)" },
  { value: "empty_leg", label: "Empty leg (repositioning)" },
  { value: "aircraft_sale", label: "Aircraft for sale" },
] as const;

export default function NewListingPage() {
  const router = useRouter();
  const [type, setType] = useState<string>("charter");
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);

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
      setError(data.error ?? "failed");
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
      <h1 className="text-2xl font-semibold">New listing</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          data-testid="listing-type"
          className={input}
        >
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          name="title"
          required
          placeholder="Title (e.g. Empty leg Zurich → Nice · Phenom 300)"
          data-testid="listing-title"
          className={input}
        />
        <div className="grid grid-cols-2 gap-3">
          <select name="aircraftCategory" data-testid="listing-category" className={input}>
            <option value="light">Light jet</option>
            <option value="mid">Mid-size</option>
            <option value="super_mid">Super mid</option>
            <option value="heavy">Heavy</option>
            <option value="ultra_long">Ultra-long range</option>
          </select>
          <input name="model" required placeholder="Model (e.g. Phenom 300)" data-testid="listing-model" className={input} />
          <input name="year" type="number" placeholder="Year" className={input} />
          <input name="seats" type="number" required placeholder="Seats" data-testid="listing-seats" className={input} />
          <input name="rangeNm" type="number" placeholder="Range (nm)" className={input} />
          <input name="price" type="number" required min={0} placeholder="Price (USD)" data-testid="listing-price" className={input} />
        </div>
        {type === "empty_leg" ? (
          <div className="grid grid-cols-3 gap-3">
            <input name="from" required placeholder="From (ZRH)" data-testid="listing-from" className={input} />
            <input name="to" required placeholder="To (NCE)" data-testid="listing-to" className={input} />
            <input name="date" type="date" required data-testid="listing-date" className={input} />
          </div>
        ) : null}
        <button
          type="submit"
          data-testid="listing-save"
          className="w-full rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
        >
          Publish listing
        </button>
        {error ? (
          <div className="rounded-md border border-border bg-surface p-3 text-sm">
            <p className="text-[color:var(--color-danger)]">{error}</p>
            {limitHit ? (
              <Link href="/app/billing" className="mt-1 inline-block font-medium text-primary underline" data-testid="upgrade-cta">
                Upgrade to Pro — unlimited listings →
              </Link>
            ) : null}
          </div>
        ) : null}
      </form>
    </main>
  );
}
