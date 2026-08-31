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
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/clients" className="text-sm text-muted-foreground hover:underline">
          Clients
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-semibold tracking-tight">{client.name}</h1>
        {client.dba && (
          <span className="text-muted-foreground text-sm">dba {client.dba}</span>
        )}
        <Badge variant="outline" className={clientStatusStyles[client.status]}>
          {client.status}
        </Badge>
        {client.website_url && (
          <a
            href={client.website_url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-muted-foreground hover:underline"
          >
            {client.website_url.replace(/^https?:\/\//, "")}
          </a>
        )}
      </div>
      <ClientTabs clientId={client.id} />
      <div>{children}</div>
    </div>
  );
}
