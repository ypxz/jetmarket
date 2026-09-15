import { site } from "@jetmarket/config";
import { Container, Section } from "../layout/primitives";

/**
 * Legal page shell — renders placeholder sections driven by site config.
 * Products replace `sections` with real ToS/privacy/imprint copy.
 */
export function LegalPage({
  title,
  updated,
  sections,
}: {
  title: string;
  updated?: string;
  sections: { heading: string; body: string }[];
}) {
  return (
    <Section>
      <Container className="max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {updated ? <p className="mt-2 text-sm text-muted-foreground">{updated}</p> : null}
        <div className="mt-8 flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">
            {site.legalName} · {site.legalAddress} · {site.legalEmail}
          </p>
          {sections.map((s, i) => (
            <section key={i}>
              <h2 className="text-lg font-semibold">{s.heading}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
            </section>
          ))}
        </div>
      </Container>
    </Section>
  );
}
