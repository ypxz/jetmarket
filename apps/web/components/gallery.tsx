import { getTranslations } from "next-intl/server";
import { Grid } from "@jetmarket/ui";

/**
 * Listing photo gallery. photos[] holds storage-adapter keys; the mock storage
 * provider (T5) will resolve them to URLs — until then we render branded
 * placeholder tiles so the layout is real. TODO(storage).
 */
export async function Gallery({ photos, title }: { photos: string[]; title: string }) {
  const t = await getTranslations("listing");
  const items = photos.length ? photos : ["placeholder-1", "placeholder-2", "placeholder-3"];
  return (
    <Grid cols={3} data-testid="gallery" aria-label={t("gallery")}>
      {items.map((p, i) => (
        <div
          key={`${p}-${i}`}
          className="flex aspect-[4/3] items-center justify-center rounded-lg border border-border bg-surface text-sm text-muted"
        >
          {photos.length ? title : `${t("photoPlaceholder", { n: i + 1 })}`}
        </div>
      ))}
    </Grid>
  );
}
