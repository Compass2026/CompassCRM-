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

  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto max-w-6xl px-4 flex h-14 items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            Compass<span className="text-muted-foreground"> Client Platform</span>
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/" className="text-muted-foreground hover:text-foreground">
              Dashboard
            </Link>
            <Link href="/clients" className="text-muted-foreground hover:text-foreground">
              Clients
            </Link>
            <Link href="/tasks" className="text-muted-foreground hover:text-foreground">
              Tasks
            </Link>
            <Link href="/settings" className="text-muted-foreground hover:text-foreground">
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {user.email}
            </span>
            <form action={signOut}>
              <Button variant="ghost" size="sm" type="submit">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
