import * as React from "react";
import { Container, Sidebar, Topbar } from "./primitives";
import { cn } from "../lib/utils";

/** Marketing shell: topbar + full-width sections + footer slot. */
export function MarketingLayout({
  nav,
  children,
  footer,
}: {
  nav?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Topbar>
        <Container className="flex h-14 items-center justify-between">{nav}</Container>
      </Topbar>
      <div className="flex-1">{children}</div>
      {footer}
    </div>
  );
}

/** App shell: topbar + optional sidebar + content column. */
export function AppLayout({
  nav,
  sidebar,
  children,
}: {
  nav?: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <Topbar>
        <Container className="flex h-14 items-center justify-between">{nav}</Container>
      </Topbar>
      <div className="flex flex-1">
        {sidebar ? <Sidebar>{sidebar}</Sidebar> : null}
        <main className={cn("flex-1 p-6", !sidebar && "mx-auto max-w-6xl")}>{children}</main>
      </div>
    </div>
  );
}
