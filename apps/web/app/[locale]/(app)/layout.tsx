import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user || (user.role !== "operator" && user.role !== "admin")) {
    redirect("/sign-in");
  }
  return <>{children}</>;
}
