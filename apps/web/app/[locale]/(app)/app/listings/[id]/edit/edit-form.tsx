"use client";

import { Button, Field, Input, Select } from "@jetmarket/ui";
import { readJson } from "@/lib/fetch-json";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface AttributeView {
  key: string;
  labelKey: string;
  appliesTo: string[];
  unitKey?: string;
  input: "select" | "number" | "text" | "date";
  required: boolean;
  options?: string[];
}

export function EditListingForm({
  listing,
}: {
  listing: {
    id: string;
    title: string;
    price: number;
    type: string;
    attributes: Record<string, unknown>;
    photos: { key: string; url: string }[];
  };
}) {
  const t = useTranslations("app.editListing");
  const tv = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attrs, setAttrs] = useState<AttributeView[]>([]);
  const [vertical, setVertical] = useState("jets");
  const [currency, setCurrency] = useState("USD");

  useEffect(() => {
    const load = () =>
      fetch("/api/vertical").then((r) =>
        readJson<{ slug?: string; attributes?: AttributeView[]; currency?: string }>(r),
      );
    load()
      .catch(() => new Promise((r) => setTimeout(r, 400)).then(load))
      .then((c) => {
        if (c.slug) setVertical(c.slug);
        if (c.currency) setCurrency(c.currency);
        if (c.attributes) setAttrs(c.attributes);
      })
      .catch(() => {});
  }, []);

  const visible = attrs.filter((a) => a.appliesTo.includes(listing.type));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const attributes: Record<string, unknown> = { ...listing.attributes };
    for (const a of visible) {
      const v = fd.get(`attr_${a.key}`);
      if (v === null || v === "") continue;
      attributes[a.key] = a.input === "number" ? Number(v) : v;
    }
    // Photos: keep checked existing keys + upload any newly-picked files.
    const photos = listing.photos
      .map((p) => p.key)
      .filter((k) => fd.get(`keep_${k}`) !== null);
    const files = (fd.getAll("photosNew") as File[]).filter(
      (f) => f.size > 0,
    );
    for (const file of files) {
      const up = new FormData();
      up.append("file", file);
      const upRes = await fetch("/api/uploads", { method: "POST", body: up });
      if (!upRes.ok) {
        setPending(false);
        setError(t("failed"));
        return;
      }
      const upData = (await upRes.json()) as { key?: string };
      if (upData.key) photos.push(upData.key);
    }
    const res = await fetch(`/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: String(fd.get("title") ?? ""),
        price: Number(fd.get("price")),
        attributes,
        photos,
      }),
    });
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `${res.status}`);
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <Field label={t("fieldTitle")} htmlFor="title" required>
        <Input
          id="title"
          name="title"
          required
          defaultValue={listing.title}
          data-testid="edit-title"
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visible.map((a) => {
          const label = tv(`vertical.${vertical}.${a.labelKey}`);
          const unit = a.unitKey ? ` (${tv(`vertical.${vertical}.${a.unitKey}`)})` : "";
          const cur = listing.attributes[a.key];
          if (a.input === "select") {
            return (
              <Field key={a.key} label={`${label}${unit}`} htmlFor={`attr_${a.key}`} required={a.required}>
                <Select
                  id={`attr_${a.key}`}
                  name={`attr_${a.key}`}
                  required={a.required}
                  defaultValue={typeof cur === "string" ? cur : ""}
                  data-testid={`edit-attr-${a.key}`}
                >
                  <option value="" disabled>
                    —
                  </option>
                  {(a.options ?? []).map((v) => (
                    <option key={v} value={v}>
                      {tv(`vertical.${vertical}.categories.${v}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          }
          return (
            <Field key={a.key} label={`${label}${unit}`} htmlFor={`attr_${a.key}`} required={a.required}>
              <Input
                id={`attr_${a.key}`}
                name={`attr_${a.key}`}
                type={a.input === "number" ? "number" : a.input === "date" ? "date" : "text"}
                min={a.input === "number" ? 0 : undefined}
                required={a.required}
                defaultValue={cur === undefined || cur === null ? "" : String(cur)}
                data-testid={`edit-attr-${a.key}`}
              />
            </Field>
          );
        })}
      </div>
      <Field label={t("photosLabel")} htmlFor="photosNew">
        <div className="flex flex-wrap gap-3">
          {listing.photos.map((p) => (
            <label key={p.key} className="relative block">
              {/* Thumbnails come from our own storage; <img> suffices at this size. */}
              <img
                src={p.url}
                alt=""
                className="h-16 w-24 rounded border border-border object-cover"
              />
              <input
                type="checkbox"
                name={`keep_${p.key}`}
                defaultChecked
                aria-label={t("keepPhoto")}
                className="absolute right-1 top-1 h-4 w-4 accent-primary"
              />
            </label>
          ))}
        </div>
        <input
          id="photosNew"
          name="photosNew"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif"
          data-testid="edit-photos"
          className="mt-2 w-full text-sm"
        />
      </Field>
      <Field label={t("fieldPrice", { currency })} htmlFor="price" required>
        <Input
          id="price"
          name="price"
          type="number"
          min="1"
          required
          defaultValue={listing.price}
          data-testid="edit-price"
        />
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-danger" data-testid="edit-error">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-testid="edit-save">
        {pending ? t("saving") : t("save")}
      </Button>
    </form>
  );
}
