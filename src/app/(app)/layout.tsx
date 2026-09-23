import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The CRM is team-only. Policies already hide every row from anyone else;
  // this keeps a non-team sign-in from landing on an empty shell.
  const { data: member } = await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!member) {
    // A client contact who signed in at /login lands here first; their home
    // is the portal. portal_client is empty for anyone who is neither.
    const { data: portalClient } = await supabase
      .from("portal_client")
      .select("id")
      .maybeSingle();
    redirect(portalClient ? "/portal" : "/auth/signout");
  }

  return (
    <div className="min-h-screen">
      <header className="bg-navy-900 text-cream">
        {/* On phones the nav drops to its own row and scrolls sideways
            instead of pushing the page wider than the screen. */}
        <div className="mx-auto max-w-6xl px-4 flex flex-wrap items-center gap-x-6 gap-y-1 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
          <Link
            href="/"
            className="flex items-center gap-2 font-heading font-semibold tracking-tight text-white"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5 text-orange-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88" fill="currentColor" stroke="none" />
            </svg>
            Compass<span className="hidden sm:inline text-cream/60 font-normal">&nbsp;Client Platform</span>
          </Link>
          <nav className="order-last flex w-full items-center gap-4 overflow-x-auto text-sm whitespace-nowrap sm:order-none sm:w-auto">
            <Link href="/" className="text-cream/70 transition-colors hover:text-white">
              Dashboard
            </Link>
            <Link href="/clients" className="text-cream/70 transition-colors hover:text-white">
              Clients
            </Link>
            <Link href="/tasks" className="text-cream/70 transition-colors hover:text-white">
              Tasks
            </Link>
            <Link href="/brief" className="text-cream/70 transition-colors hover:text-white">
              Brief
            </Link>
            <Link href="/settings" className="text-cream/70 transition-colors hover:text-white">
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-cream/50 hidden sm:inline">
              {user.email}
            </span>
            <form action={signOut}>
              <Button
                variant="ghost"
                size="sm"
                type="submit"
                className="text-cream/80 hover:bg-white/10 hover:text-white"
              >
                Sign out
              </Button>
            </form>
          </div>
        </div>
        <div className="h-0.5 bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400" />
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
