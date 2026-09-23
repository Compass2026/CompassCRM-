import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { clientStatusStyles } from "@/lib/labels";
import { ClientTabs } from "@/components/client-tabs";

export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase
    .from("clients")
    .select("id, name, dba, status, website_url")
    .eq("id", clientId)
    .single();

  if (!client) notFound();

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Link
          href="/clients"
          className="inline-flex text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; All clients
        </Link>
        <div className="flex items-center gap-4">
          <span
            className="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-royal-500 to-navy-800 text-lg font-bold text-white shadow-[0_6px_16px_-6px_rgba(11,22,42,0.55)]"
            aria-hidden="true"
          >
            {client.name.trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
              <h1 className="page-title">{client.name}</h1>
              <Badge variant="outline" className={clientStatusStyles[client.status]}>
                {client.status}
              </Badge>
            </div>
            {(client.dba || client.website_url) && (
              <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-sm text-muted-foreground">
                {client.dba && <span>dba {client.dba}</span>}
                {client.website_url && (
                  <a
                    href={client.website_url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all hover:text-foreground hover:underline transition-colors"
                  >
                    {client.website_url.replace(/^https?:\/\//, "")}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
        <ClientTabs clientId={client.id} />
      </div>
      <div>{children}</div>
    </div>
  );
}
