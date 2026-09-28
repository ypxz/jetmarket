import type { Metadata } from "next";

// The RFQ form and its thanks page carry request tokens — not SEO content.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function RfqLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
