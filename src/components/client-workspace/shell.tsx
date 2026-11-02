import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export function WorkspaceShell({ children, businessName }: {
  children: React.ReactNode;
  businessName: string;
}) {
  return (
    <div className="min-h-screen bg-slate-100 px-3 pb-8 sm:px-6">
      <header className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 py-4 text-sm text-slate-600">
        <span className="font-medium">{businessName}</span>
        <form action={signOut}>
          <button type="submit" className="rounded-lg border border-slate-200 bg-white px-4 py-2 hover:bg-slate-50">Sign out</button>
        </form>
      </header>
      <main className="mx-auto max-w-[1600px]">{children}</main>
    </div>
  );
}
