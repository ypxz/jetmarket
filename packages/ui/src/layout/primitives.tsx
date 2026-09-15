import * as React from "react";
import { cn } from "../lib/utils";

/** Page-level vertical rhythm. */
export function Page({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 py-8 sm:px-6", className)} {...props} />;
}

/** A marketing/app section with consistent vertical spacing. */
export function Section({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <section className={cn("py-12 sm:py-16", className)} {...props} />;
}

/** Constrains content width; centers it. */
export function Container({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)} {...props} />;
}

export function Stack({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-4", className)} {...props} />;
}

export function Grid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-6 sm:grid-cols-2 lg:grid-cols-3", className)} {...props} />;
}

/** Sticky top bar for marketing + app shells. */
export function Topbar({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <header
      className={cn("sticky top-0 z-40 border-b bg-background/80 backdrop-blur", className)}
      {...props}
    />
  );
}

/** Column for secondary nav inside AppLayout. */
export function Sidebar({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <aside
      className={cn("hidden w-56 shrink-0 border-r bg-muted/30 p-4 md:block", className)}
      {...props}
    />
  );
}
