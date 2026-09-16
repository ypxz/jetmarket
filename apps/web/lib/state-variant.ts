import type { BadgeVariant } from "@jetmarket/ui";
import type { Deal, Quote } from "@/lib/repo/types";

export function quoteStateVariant(status: Quote["status"]): BadgeVariant {
  switch (status) {
    case "sent":
      return "warning";
    case "accepted":
      return "success";
    case "declined":
      return "danger";
    case "withdrawn":
      return "outline";
  }
}

export function invoiceStateVariant(
  status: Deal["invoiceStatus"],
): BadgeVariant {
  switch (status) {
    case "pending":
      return "warning";
    case "invoiced":
      return "default";
    case "paid":
      return "success";
  }
}
