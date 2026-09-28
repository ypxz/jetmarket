import type { Metadata } from "next";

// Buyer inbox URLs carry the per-RFQ access token — never indexable.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function QuotesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
