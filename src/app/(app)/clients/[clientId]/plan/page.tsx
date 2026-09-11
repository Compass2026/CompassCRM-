import { createClient } from "@/lib/supabase/server";
import {
  enrollPipelineAction,
  unenrollPipelineAction,
  upsertPlanAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { BlockedBanner } from "@/components/blocked-banner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function PlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ blocked?: string; hint?: string }>;
}) {
  const { clientId } = await params;
  const { blocked, hint } = await searchParams;
  const supabase = await createClient();
  const [{ data: plan }, { data: pipelines }, { data: enrollments }] =
    await Promise.all([
      supabase.from("plans").select("*").eq("client_id", clientId).maybeSingle(),
      supabase
        .from("pipelines")
        .select("*")
        .eq("is_recurring", false)
        .order("sort_order"),
      supabase
        .from("client_pipelines")
        .select("*, pipelines(name, is_recurring)")
        .eq("client_id", clientId),
    ]);

  const savePlan = upsertPlanAction.bind(null, clientId);
  const enrolledByPipeline = new Map(
    (enrollments ?? []).map((e) => [e.pipeline_id, e])
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={savePlan} className="grid grid-cols-2 gap-3">
            <div className="space-y-1 col-span-2">
              <Label htmlFor="package_name">Package name</Label>
              <Input id="package_name" name="package_name" defaultValue={plan?.package_name ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="monthly_fee">Monthly fee ($)</Label>
              <Input id="monthly_fee" name="monthly_fee" type="number" step="0.01" defaultValue={plan?.monthly_fee ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="term_months">Term (months)</Label>
              <Input id="term_months" name="term_months" type="number" defaultValue={plan?.term_months ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="start_date">Start date</Label>
              <Input id="start_date" name="start_date" type="date" defaultValue={plan?.start_date ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="renewal_date">Renewal date</Label>
              <Input id="renewal_date" name="renewal_date" type="date" defaultValue={plan?.renewal_date ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="gbp_posts_per_month">GBP posts / month</Label>
              <Input id="gbp_posts_per_month" name="gbp_posts_per_month" type="number" defaultValue={plan?.gbp_posts_per_month ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="blog_posts_per_month">Blog posts / month</Label>
              <Input id="blog_posts_per_month" name="blog_posts_per_month" type="number" defaultValue={plan?.blog_posts_per_month ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="social_posts_per_month">Social posts / month</Label>
              <Input id="social_posts_per_month" name="social_posts_per_month" type="number" defaultValue={plan?.social_posts_per_month ?? ""} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ad_budget_managed">Ad budget managed ($)</Label>
              <Input id="ad_budget_managed" name="ad_budget_managed" type="number" step="0.01" defaultValue={plan?.ad_budget_managed ?? ""} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label htmlFor="notes">Plan notes</Label>
              <Textarea id="notes" name="notes" defaultValue={plan?.notes ?? ""} rows={3} />
            </div>
            <div className="col-span-2">
              <Button type="submit">Save plan</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enrolled pipelines</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <BlockedBanner message={blocked} hint={hint} />
          <p className="text-xs text-muted-foreground">
            Enrolling creates the pipeline&apos;s stages and its playbook tasks.
            Removing an enrollment deletes its stage progress. Foundation runs
            for every client and cannot be removed.
          </p>
          <p className="text-xs text-muted-foreground">
            A <span className="font-medium">pending</span> pipeline is enrolled
            but waiting on Foundation — it reads the taxonomy, brand board and
            keyword map. It starts itself, and creates its tasks, the moment
            Foundation completes.
          </p>
          {(pipelines ?? []).map((p) => {
            const enrollment = enrolledByPipeline.get(p.id);
            const enroll = enrollPipelineAction.bind(null, clientId, p.id);
            const unenroll = enrollment
              ? unenrollPipelineAction.bind(null, clientId, enrollment.id)
              : null;
            return (
              <div
                key={p.id}
                className="flex items-center justify-between border rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{p.name}</span>
                  {enrollment && (
                    <Badge
                      variant="outline"
                      className={
                        enrollment.status === "complete"
                          ? "bg-green-100 text-green-800 border-green-200"
                          : enrollment.status === "pending"
                            ? "bg-amber-100 text-amber-800 border-amber-200"
                            : "bg-blue-100 text-blue-800 border-blue-200"
                      }
                    >
                      {enrollment.status}
                    </Badge>
                  )}
                </div>
                {enrollment ? (
                  p.key === "foundation" ? (
                    <span className="text-xs text-muted-foreground">
                      Always enrolled
                    </span>
                  ) : (
                    <form action={unenroll!}>
                      <Button variant="outline" size="sm" type="submit">
                        Remove
                      </Button>
                    </form>
                  )
                ) : (
                  <form action={enroll}>
                    <Button size="sm" type="submit">
                      Enroll
                    </Button>
                  </form>
                )}
              </div>
            );
          })}
          {(enrollments ?? []).some((e) => e.pipelines?.is_recurring) && (
            <div className="border rounded-md px-3 py-2 flex items-center justify-between bg-muted/40">
              <span className="font-medium text-sm">Reporting (recurring)</span>
              <Badge variant="outline" className="bg-green-100 text-green-800 border-green-200">
                enrolled
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
