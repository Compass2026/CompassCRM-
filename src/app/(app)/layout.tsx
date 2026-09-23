import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { AppNav } from "@/components/app-nav";

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

  const initials = (user.email ?? "?")
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

  return (
    <div className="min-h-screen">
      {/* A floating white bar on the cool ground. Sticky from tablet up; on
          phones the nav drops to its own row and scrolls sideways instead
          of pushing the page wider than the screen. */}
      <header className="px-3 pt-3 sm:sticky sm:top-0 sm:z-40 sm:px-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-card px-3 py-2.5 shadow-float ring-1 ring-border backdrop-blur-md sm:h-16 sm:flex-nowrap sm:px-4 sm:py-0">
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-lg font-heading font-semibold tracking-tight text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-navy-900 shadow-[0_4px_12px_-4px_rgba(11,22,42,0.5)]">
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
            </span>
            <span className="leading-tight">
              Compass
              <span className="hidden text-xs font-normal text-muted-foreground lg:block">
                Client Platform
              </span>
            </span>
          </Link>
          <AppNav className="order-last sm:order-none" />
          <div className="ml-auto flex items-center gap-2">
            <span
              className="hidden size-9 place-items-center rounded-full bg-navy-700 text-xs font-semibold text-white ring-2 ring-card sm:grid"
              title={user.email ?? undefined}
              aria-hidden="true"
            >
              {initials}
            </span>
            <span className="hidden max-w-48 truncate text-xs text-muted-foreground xl:inline">
              {user.email}
            </span>
            <form action={signOut}>
              <Button variant="ghost" size="sm" type="submit" className="text-muted-foreground">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
