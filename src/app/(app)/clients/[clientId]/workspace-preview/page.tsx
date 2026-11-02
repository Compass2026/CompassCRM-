import { redirect, notFound } from "next/navigation";
import { isUuid } from "@/lib/tasks";

export default async function WorkspacePreviewRedirect({ params, searchParams }: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ lead?: string }>;
}) {
  const { clientId } = await params;
  const { lead } = await searchParams;
  if (!isUuid(clientId) || (lead && !isUuid(lead))) notFound();
  redirect(`/workspace-preview/${clientId}${lead ? `?lead=${lead}` : ""}`);
}
