import * as React from "react";
import { Container, Section } from "../layout/primitives";

export function CTA({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <Section>
      <Container className="flex flex-col items-center gap-4 rounded-xl border bg-muted/40 p-10 text-center">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
        {subtitle ? <p className="max-w-xl text-muted-foreground">{subtitle}</p> : null}
        {children}
      </Container>
    </Section>
  );
}
