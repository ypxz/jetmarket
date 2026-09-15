import * as React from "react";
import { Container, Section } from "../layout/primitives";
import { cn } from "../lib/utils";

export function Hero({
  title,
  subtitle,
  cta,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  cta?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Section className={cn("pt-20 sm:pt-28", className)}>
      <Container className="flex flex-col items-center gap-6 text-center">
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">{title}</h1>
        {subtitle ? (
          <p className="max-w-2xl text-lg text-muted-foreground">{subtitle}</p>
        ) : null}
        {cta ? <div className="mt-2 flex gap-3">{cta}</div> : null}
        {children}
      </Container>
    </Section>
  );
}
