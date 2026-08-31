import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ownerLabels } from "@/lib/labels";

export default async function SettingsPage() {
  const supabase = await createClient();
  const [{ data: pipelines }, { data: taskTemplates }, { data: gridDefaults }] =
    await Promise.all([
      supabase
        .from("pipelines")
        .select("*, stages(id, name, sort_order, is_optional, description)")
        .order("sort_order"),
      supabase
        .from("task_templates")
        .select("*, pipelines(name)")
        .order("sort_order"),
      supabase
        .from("app_settings")
        .select("value")
        .eq("key", "grid_defaults")
        .maybeSingle(),
    ]);

  const recurringTemplates = (taskTemplates ?? []).filter((t) => t.pipeline_id);
  const grid = (gridDefaults?.value ?? []) as {
    client_type: string;
    grid_size: number;
    spacing_miles: number;
  }[];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-sm text-muted-foreground">
        Pipeline, stage, and task templates (seeded from the Compass process
        spec). Template editing lands with the Trackers phase — changes for now
        go through Claude Code.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {(pipelines ?? []).map((p) => (
          <Card key={p.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                {p.name}
                {p.is_recurring && <Badge variant="secondary">recurring</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {p.stages.length === 0 ? (
                <div className="space-y-1">
                  {recurringTemplates
                    .filter((t) => t.pipeline_id === p.id)
                    .map((t) => (
                      <div key={t.id} className="flex items-center gap-2 text-sm">
                        <span className="flex-1">{t.title}</span>
                        {t.department && (
                          <Badge variant="outline" className="text-[10px]">
                            {t.department}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {ownerLabels[t.default_owner]}
                        </Badge>
                      </div>
                    ))}
                </div>
              ) : (
                <ol className="space-y-1 text-sm list-decimal list-inside">
                  {[...p.stages]
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((s) => (
                      <li key={s.id}>
                        {s.name}
                        {s.is_optional && (
                          <span className="text-muted-foreground"> (optional)</span>
                        )}
                      </li>
                    ))}
                </ol>
              )}
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Geo-grid defaults</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {grid.map((g) => (
                <div key={g.client_type} className="flex justify-between gap-4">
                  <span>{g.client_type}</span>
                  <span className="text-muted-foreground shrink-0">
                    {g.grid_size}×{g.grid_size} · {g.spacing_miles} mi
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
