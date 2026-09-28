import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Any signed-in user may enter — buyers need /app/onboarding to become an
  // operator (QA-267: sign-in role only applies at account creation, so an
  // existing buyer-role account must be able to reach the onboarding form).
  // Pages handle the operator-less case themselves: /app renders the
  // becomeOperator CTA, /app/rfqs a needProfile note, billing/listings are
  // API-gated.
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }
  return <>{children}</>;
}
