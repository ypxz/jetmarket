import type { BadgeVariant } from "@jetmarket/ui";
import type { Deal, JobInfo, Quote, Rfq } from "@/lib/repo/types";

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

export function rfqStateVariant(status: Rfq["status"]): BadgeVariant {
  switch (status) {
    case "open":
      return "outline";
    case "matched":
      return "warning";
    case "quoted":
      return "success";
    case "closed":
      return "default";
    case "expired":
      return "outline";
    case "spam":
      return "danger";
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
    case "void":
      return "outline";
  }
}

export function jobStateVariant(status: JobInfo["status"]): BadgeVariant {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "warning";
    case "pending":
      return "outline";
  }
}
