import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createClientAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { clientStatusStyles } from "@/lib/labels";

export default async function ClientsPage() {
  const supabase = await createClient();
  const { data: clients } = await supabase
    .from("clients")
    .select(
      "id, name, status, website_url, service_area, plans(package_name, monthly_fee), client_pipelines(status, pipelines(name, is_recurring))"
    )
    .order("name");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <Dialog>
          <DialogTrigger render={<Button>New client</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New client</DialogTitle>
            </DialogHeader>
            <form action={createClientAction} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="name">Business name</Label>
                <Input id="name" name="name" required />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="industry">Industry</Label>
                  <Input id="industry" name="industry" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="website_url">Website</Label>
                  <Input id="website_url" name="website_url" placeholder="https://" />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="service_area">Service area</Label>
                <Input id="service_area" name="service_area" />
              </div>
              <Button type="submit" className="w-full">
                Create client
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Pipelines</TableHead>
              <TableHead className="text-right">Progress</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(clients ?? []).map((client) => {
              const launch = client.client_pipelines.filter(
                (cp) => !cp.pipelines?.is_recurring
              );
              const completed = launch.filter(
                (cp) => cp.status === "complete"
              ).length;
              return (
                <TableRow key={client.id}>
                  <TableCell>
                    <Link
                      href={`/clients/${client.id}`}
                      className="font-medium hover:underline"
                    >
                      {client.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={clientStatusStyles[client.status]}
                    >
                      {client.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {client.plans?.package_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {launch.length
                      ? launch.map((cp) => cp.pipelines?.name).join(", ")
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {launch.length ? `${completed}/${launch.length}` : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
