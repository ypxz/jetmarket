import { getTranslations } from "next-intl/server";
import { redirect, notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getRepo } from "@/lib/repo";
import { EditListingForm } from "./edit-form";

export default async function EditListingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await currentUser();
  if (!user || (user.role !== "operator" && user.role !== "admin")) {
    redirect("/sign-in");
  }
  const repo = await getRepo();
  const listing = await repo.getListing(id);
  const operator = await repo.getOperatorByUserId(user.id);
  if (!listing || !operator || listing.operatorId !== operator.id) notFound();
  const t = await getTranslations("app.editListing");
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <EditListingForm
        listing={{
          id: listing.id,
          title: listing.title,
          price: listing.price,
          type: listing.type,
          attributes: listing.attributes,
        }}
      />
    </main>
  );
}
