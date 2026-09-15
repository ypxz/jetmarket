import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type BadgeVariant = "default" | "success" | "warning" | "danger" | "outline";

const variants: Record<BadgeVariant, string> = {
  default: "bg-surface text-foreground",
  success: "bg-surface text-success",
  warning: "bg-surface text-warning",
  danger: "bg-surface text-danger",
  outline: "border border-border text-muted",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ variant = "default", className, ...props }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
