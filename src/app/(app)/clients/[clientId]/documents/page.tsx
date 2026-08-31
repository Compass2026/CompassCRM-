import { createClient } from "@/lib/supabase/server";
import {
  addDriveLinkAction,
  deleteDocumentAction,
  getDocumentUrlAction,
  uploadDocumentAction,
} from "@/app/actions";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { documentCategories } from "@/lib/labels";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs";

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const [{ data: client }, { data: documents }] = await Promise.all([
    supabase.from("clients").select("drive_root_url").eq("id", clientId).single(),
    supabase
      .from("documents")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false }),
  ]);

  const driveLinks = (documents ?? []).filter((d) => d.kind === "drive_link");
  const uploads = (documents ?? []).filter((d) => d.kind === "upload");
  const addLink = addDriveLinkAction.bind(null, clientId);
  const upload = uploadDocumentAction.bind(null, clientId);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Drive links</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {client?.drive_root_url && (
            <a
              href={client.drive_root_url}
              target="_blank"
              rel="noreferrer"
              className="block text-sm font-medium hover:underline border rounded-md px-3 py-2 bg-muted/40"
            >
              📁 Client root folder
            </a>
          )}
          <ul className="space-y-2">
            {driveLinks.map((d) => {
              const del = deleteDocumentAction.bind(null, clientId, d.id);
              return (
                <li key={d.id} className="flex items-center gap-2 border rounded-md px-3 py-2 text-sm">
                  <a
                    href={d.url ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline flex-1 truncate"
                  >
                    {d.label}
                  </a>
                  <Badge variant="secondary">{d.category}</Badge>
                  <form action={del}>
                    <Button variant="ghost" size="sm" type="submit">✕</Button>
                  </form>
                </li>
              );
            })}
            {driveLinks.length === 0 && (
              <p className="text-sm text-muted-foreground">No pinned links yet.</p>
            )}
          </ul>
          <form action={addLink} className="grid grid-cols-2 gap-2 border-t pt-3">
            <Input name="label" placeholder="Label (e.g. Proposal)" required />
            <select name="category" className={selectClass} defaultValue="other">
              {documentCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <Input name="url" placeholder="https://drive.google.com/…" required className="col-span-2" />
            <Button type="submit" variant="outline" className="col-span-2">
              Add link
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Uploaded files</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {uploads.map((d) => {
              const del = deleteDocumentAction.bind(null, clientId, d.id);
              async function open() {
                "use server";
                if (!d.storage_path) return;
                const url = await getDocumentUrlAction(d.storage_path);
                redirect(url);
              }
              return (
                <li key={d.id} className="flex items-center gap-2 border rounded-md px-3 py-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <form action={open}>
                      <button type="submit" className="font-medium hover:underline truncate">
                        {d.label}
                      </button>
                    </form>
                    <div className="text-xs text-muted-foreground truncate">
                      {d.file_name} · {d.uploaded_by ?? "unknown"} ·{" "}
                      {d.created_at?.slice(0, 10)}
                    </div>
                  </div>
                  <Badge variant="secondary">{d.category}</Badge>
                  <form action={del}>
                    <Button variant="ghost" size="sm" type="submit">✕</Button>
                  </form>
                </li>
              );
            })}
            {uploads.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No uploads yet — contracts, signed proposals, W-9s, brand assets.
              </p>
            )}
          </ul>
          <form action={upload} className="grid grid-cols-2 gap-2 border-t pt-3">
            <Input name="label" placeholder="Label" className="col-span-2" />
            <select name="category" className={selectClass} defaultValue="contract">
              {documentCategories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <Input name="file" type="file" required />
            <Button type="submit" variant="outline" className="col-span-2">
              Upload
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
