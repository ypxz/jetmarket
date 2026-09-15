import { Button, Card, CardBody, CardHeader, CardTitle, Input, Label, Select } from "@jetmarket/ui";
import { getVertical } from "@jetmarket/verticals";
import { getTranslations } from "next-intl/server";
import type { SearchParams } from "@/lib/search";

/**
 * Facet sidebar rendered from config.facets — a plain GET form so search stays
 * shareable/server-rendered. Field names are facet keys; number-range facets
 * use `<key>Min`/`<key>Max`.
 */
export async function FacetSidebar({ params }: { params: SearchParams }) {
  const vertical = getVertical();
  const vt = await getTranslations(vertical.copy.namespace);
  const t = await getTranslations("search");
  const get = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  };

  return (
    <Card data-testid="facet-sidebar">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardBody>
        <form action="/search" method="get" className="space-y-4">
          <div>
            <Label htmlFor="q">{t("placeholder")}</Label>
            <Input id="q" name="q" defaultValue={get("q")} data-testid="facet-q" />
          </div>
          {vertical.facets.map((f) => {
            if (f.type === "enum") {
              return (
                <div key={f.key}>
                  <Label htmlFor={`f-${f.key}`}>{vt(f.labelKey)}</Label>
                  <Select
                    id={`f-${f.key}`}
                    name={f.key}
                    defaultValue={get(f.key)}
                    data-testid={`facet-${f.key}`}
                  >
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {vt(o.labelKey)}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            }
            if (f.type === "number-range") {
              return (
                <div key={f.key}>
                  <Label>{vt(f.labelKey)}</Label>
                  <div className="flex gap-2">
                    <Input
                      name={`${f.key}Min`}
                      type="number"
                      placeholder={t("min")}
                      defaultValue={get(`${f.key}Min`)}
                      data-testid={`facet-${f.key}-min`}
                    />
                    <Input
                      name={`${f.key}Max`}
                      type="number"
                      placeholder={t("max")}
                      defaultValue={get(`${f.key}Max`)}
                      data-testid={`facet-${f.key}-max`}
                    />
                  </div>
                </div>
              );
            }
            return (
              <div key={f.key}>
                <Label htmlFor={`f-${f.key}`}>{vt(f.labelKey)}</Label>
                <Input
                  id={`f-${f.key}`}
                  name={f.key}
                  defaultValue={get(f.key)}
                  data-testid={`facet-${f.key}`}
                />
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button type="submit" data-testid="facet-apply">
              {t("submit")}
            </Button>
            <a href="/search" className="px-3 py-2 text-sm text-muted">
              {t("reset")}
            </a>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
