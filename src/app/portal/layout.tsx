import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { PortalNav } from "@/components/portal-nav";

async function signOut() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // A team member who lands here belongs in the CRM, not in a client's view.
  const { data: member } = await supabase
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (member) redirect("/");

  // portal_client is filtered to the signed-in client, so an empty result
  // means this sign-in is not a portal user at all.
  const { data: client } = await supabase
    .from("portal_client")
    .select("name")
    .maybeSingle();
  if (!client) redirect("/auth/signout");

  // So the Overview tab can show who has actually signed in.
  await supabase.rpc("portal_seen");

  return (
    <div className="min-h-screen">
      <header className="bg-navy-900 text-cream">
        <div className="mx-auto max-w-5xl px-4 flex h-14 items-center gap-6">
          <div className="flex items-center gap-2 font-heading font-semibold tracking-tight text-white">
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
            Compass
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-cream/60 hidden sm:inline">
              {client.name}
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
        <div className="mx-auto max-w-5xl px-4">
          <PortalNav />
        </div>
        <div className="h-0.5 bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400" />
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-muted-foreground">
        Questions about anything here? Reply to your last email from Compass and
        we&apos;ll walk you through it.
      </footer>
    </div>
  );
}
