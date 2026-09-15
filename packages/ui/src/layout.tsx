import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export function Page({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main className={cx("min-h-[60vh]", className)} {...props} />;
}

export function Section({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return <section className={cx("py-12 sm:py-16", className)} {...props} />;
}

export function Container({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}
      {...props}
    />
  );
}

export interface StackProps extends HTMLAttributes<HTMLDivElement> {
  gap?: "sm" | "md" | "lg";
}

const stackGaps = { sm: "gap-2", md: "gap-4", lg: "gap-8" } as const;

export function Stack({ gap = "md", className, ...props }: StackProps) {
  return (
    <div className={cx("flex flex-col", stackGaps[gap], className)} {...props} />
  );
}

export function HStack({ gap = "md", className, ...props }: StackProps) {
  return (
    <div
      className={cx("flex flex-wrap items-center", stackGaps[gap], className)}
      {...props}
    />
  );
}

export interface GridProps extends HTMLAttributes<HTMLDivElement> {
  cols?: 1 | 2 | 3 | 4;
}

const gridCols = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
} as const;

export function Grid({ cols = 3, className, ...props }: GridProps) {
  return (
    <div className={cx("grid gap-4", gridCols[cols], className)} {...props} />
  );
}
