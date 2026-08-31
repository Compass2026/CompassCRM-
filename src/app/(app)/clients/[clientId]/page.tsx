import { createClient } from "@/lib/supabase/server";
import {
  addContactAction,
  deleteContactAction,
  updateClientAction,
  upsertAccessAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  accessStatusStyles,
  accessSystemLabels,
  defaultAccessSystems,
  type AccessStatus,
  type AccessSystem,
} from "@/lib/labels";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs";

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await createClient();
  const [{ data: client }, { data: contacts }, { data: access }] =
    await Promise.all([
      supabase.from("clients").select("*").eq("id", clientId).single(),
      supabase
        .from("client_contacts")
        .select("*")
        .eq("client_id", clientId)
        .order("is_primary", { ascending: false }),
      supabase.from("client_access").select("*").eq("client_id", clientId),
    ]);

  if (!client) return null;

  const updateClient = updateClientAction.bind(null, clientId);
  const addContact = addContactAction.bind(null, clientId);

  const accessBySystem = new Map(access?.map((a) => [a.system, a]));
  const systems: AccessSystem[] = [
    ...defaultAccessSystems,
    ...(access ?? [])
      .map((a) => a.system)
      .filter((s) => !defaultAccessSystems.includes(s)),
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Business</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={updateClient} className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="name">Business name</Label>
              <Input id="name" name="name" defaultValue={client.name} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dba">DBA</Label>
              <Input id="dba" name="dba" defaultValue={client.dba ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="industry">Industry / vertical</Label>
              <Input id="industry" name="industry" defaultValue={client.industry ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="website_url">Website</Label>
              <Input id="website_url" name="website_url" defaultValue={client.website_url ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" defaultValue={client.phone ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="status">Status</Label>
              <select id="status" name="status" defaultValue={client.status} className={`${selectClass} w-full`}>
                <option value="launching">launching</option>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="offboarded">offboarded</option>
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="address_line1">Address (NAP)</Label>
              <Input id="address_line1" name="address_line1" defaultValue={client.address_line1 ?? ""} />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:col-span-1">
              <div className="space-y-1">
                <Label htmlFor="city">City</Label>
                <Input id="city" name="city" defaultValue={client.city ?? ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="state">State</Label>
                <Input id="state" name="state" defaultValue={client.state ?? ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="zip">Zip</Label>
                <Input id="zip" name="zip" defaultValue={client.zip ?? ""} />
              </div>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="service_area">Service area</Label>
              <Input id="service_area" name="service_area" defaultValue={client.service_area ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="drive_root_url">Drive root folder</Label>
              <Input id="drive_root_url" name="drive_root_url" defaultValue={client.drive_root_url ?? ""} placeholder="https://drive.google.com/…" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="signed_at">Signed</Label>
              <Input id="signed_at" name="signed_at" type="date" defaultValue={client.signed_at ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="kickoff_at">Kickoff</Label>
              <Input id="kickoff_at" name="kickoff_at" type="date" defaultValue={client.kickoff_at ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="launched_at">Launched</Label>
              <Input id="launched_at" name="launched_at" type="date" defaultValue={client.launched_at ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="renewal_at">Renewal</Label>
              <Input id="renewal_at" name="renewal_at" type="date" defaultValue={client.renewal_at ?? ""} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" defaultValue={client.notes ?? ""} rows={2} />
            </div>
            <div className="sm:col-span-3">
              <Button type="submit">Save</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contacts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(contacts ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No contacts yet.</p>
          )}
          <ul className="space-y-2">
            {(contacts ?? []).map((c) => {
              const deleteContact = deleteContactAction.bind(null, clientId, c.id);
              return (
                <li key={c.id} className="flex items-start gap-2 text-sm border rounded-md p-2">
                  <div className="flex-1">
                    <div className="font-medium flex items-center gap-2">
                      {c.name}
                      {c.is_primary && <Badge variant="secondary">primary</Badge>}
                    </div>
                    <div className="text-muted-foreground">
                      {[c.role, c.email, c.phone].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <form action={deleteContact}>
                    <Button variant="ghost" size="sm" type="submit">
                      ✕
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
          <form action={addContact} className="grid grid-cols-2 gap-2 border-t pt-3">
            <Input name="name" placeholder="Name" required />
            <Input name="role" placeholder="Role" />
            <Input name="email" placeholder="Email" type="email" />
            <Input name="phone" placeholder="Phone" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" name="is_primary" /> Primary
            </label>
            <Button type="submit" variant="outline">
              Add contact
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access tracker</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Status per system — no passwords stored.
          </p>
          <div className="space-y-2">
            {systems.map((system) => {
              const row = accessBySystem.get(system);
              async function saveAccess(form: FormData) {
                "use server";
                await upsertAccessAction(
                  clientId,
                  system,
                  (form.get("status") as AccessStatus) ?? "not_needed",
                  (form.get("notes") as string) || null
                );
              }
              return (
                <form
                  key={system}
                  action={saveAccess}
                  className="flex items-center gap-2"
                >
                  <span className="text-sm w-44 shrink-0">
                    {accessSystemLabels[system]}
                  </span>
                  <select
                    name="status"
                    defaultValue={row?.status ?? "not_needed"}
                    className={selectClass}
                  >
                    <option value="not_needed">not needed</option>
                    <option value="requested">requested</option>
                    <option value="granted">granted</option>
                  </select>
                  <Input
                    name="notes"
                    defaultValue={row?.notes ?? ""}
                    placeholder="Notes"
                    className="h-9"
                  />
                  <Button type="submit" variant="outline" size="sm">
                    Save
                  </Button>
                  {row && (
                    <Badge variant="outline" className={accessStatusStyles[row.status]}>
                      {row.status.replace("_", " ")}
                    </Badge>
                  )}
                </form>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
