import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadBrandBoard } from "@/lib/brand";
import { BrandBoard } from "@/components/brand-board";
import { PrintButton } from "./print-button";

/**
 * Standalone, print-ready brand board (no app chrome). Cmd/Ctrl+P → "Save as
 * PDF" gives a file to drop into the client's Drive folder.
 */
export default async function BrandBoardPrintPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const data = await loadBrandBoard(supabase, clientId);
  if (!data) notFound();

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-5xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
        <div className="mb-4 flex items-center justify-between print:hidden">
          <Link
            href={`/clients/${clientId}/brand`}
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-primary"
          >
            &larr; Back to Brand tab
          </Link>
          <PrintButton />
        </div>
        <div className="print:[&>div]:border-0 print:[&>div]:shadow-none print:[&>div]:p-0">
          <BrandBoard data={data} />
        </div>
      </div>
    </div>
  );
}
