import { getTranslations } from "next-intl/server";
import { storageProvider } from "@jetmarket/providers";
import { Grid } from "@jetmarket/ui";

/**
 * Listing photo gallery. photos[] holds storage-provider keys resolved via
 * `storageProvider().url(key)`; empty listings render placeholder tiles.
 */
export async function Gallery({ photos, title }: { photos: string[]; title: string }) {
  const t = await getTranslations("listing");
  if (!photos.length) {
    return (
      <Grid cols={3} data-testid="gallery" aria-label={t("gallery")}>
        {["placeholder-1", "placeholder-2", "placeholder-3"].map((p, i) => (
          <div
            key={p}
            className="flex aspect-[4/3] items-center justify-center rounded-lg border border-border bg-surface text-sm text-muted"
          >
            {t("photoPlaceholder", { n: i + 1 })}
          </div>
        ))}
      </Grid>
    );
  }
  const storage = storageProvider();
  return (
    <Grid cols={3} data-testid="gallery" aria-label={t("gallery")}>
      {photos.map((key, i) => (
        <img
          key={key}
          src={storage.url(key)}
          alt={`${title} — ${i + 1}`}
          data-testid={`gallery-photo-${i}`}
          className="aspect-[4/3] w-full rounded-lg border border-border object-cover"
        />
      ))}
    </Grid>
  );
}
