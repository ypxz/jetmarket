"use client";

import { Button, Field, Input } from "@jetmarket/ui";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function EditListingForm({
  listing,
}: {
  listing: { id: string; title: string; price: number };
}) {
  const t = useTranslations("app.editListing");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch(`/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: String(fd.get("title") ?? ""),
        price: Number(fd.get("price")),
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
      <Field label={t("fieldPrice")} htmlFor="price" required>
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
