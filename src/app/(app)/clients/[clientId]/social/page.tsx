import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  addSocialPostAction,
  deleteSocialPostAction,
  updateSocialPostAction,
} from "@/app/tracker-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PLATFORMS = ["facebook", "instagram", "linkedin", "x", "tiktok"] as const;
const SOCIAL_STATUSES = ["idea", "drafted", "approved", "scheduled", "published", "failed"] as const;
const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs";

const platformIcons: Record<string, string> = {
  facebook: "FB",
  instagram: "IG",
  linkedin: "LI",
  x: "X",
  tiktok: "TT",
};

const statusStyles: Record<string, string> = {
  idea: "bg-zinc-100 text-zinc-600",
  drafted: "bg-purple-100 text-purple-800",
  approved: "bg-blue-100 text-blue-800",
  scheduled: "bg-amber-100 text-amber-800",
  published: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export default async function SocialPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const { clientId } = await params;
  const { view = "list", month } = await searchParams;
  const supabase = await createClient();

  const [{ data: posts }, { data: plan }] = await Promise.all([
    supabase
      .from("social_posts")
      .select("*")
      .eq("client_id", clientId)
      .order("scheduled_at", { ascending: true, nullsFirst: false }),
    supabase
      .from("plans")
      .select("social_posts_per_month")
      .eq("client_id", clientId)
      .maybeSingle(),
  ]);

  const now = new Date();
  const monthStr =
    month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, mon] = monthStr.split("-").map(Number);
  const publishedThisMonth = (posts ?? []).filter(
    (p) =>
      p.status === "published" &&
      (p.scheduled_at ?? "").startsWith(monthStr)
  ).length;

  const addPost = addSocialPostAction.bind(null, clientId);

  // Calendar grid for the selected month
  const firstDay = new Date(Date.UTC(year, mon - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const startWeekday = firstDay.getUTCDay(); // 0 = Sunday
  const cells: (number | null)[] = [
    ...Array<null>(startWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const postsByDay = new Map<number, typeof posts>();
  for (const p of posts ?? []) {
    if (p.scheduled_at?.startsWith(monthStr)) {
      const day = Number(p.scheduled_at.slice(8, 10));
      postsByDay.set(day, [...(postsByDay.get(day) ?? []), p]);
    }
  }
  const prevMonth = new Date(Date.UTC(year, mon - 2, 1));
  const nextMonth = new Date(Date.UTC(year, mon, 1));
  const fmtMonth = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={`/clients/${clientId}/social?view=list`}
          className={cn(
            "text-sm px-3 py-1 rounded-full border",
            view === "list" ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"
          )}
        >
          List
        </Link>
        <Link
          href={`/clients/${clientId}/social?view=calendar&month=${monthStr}`}
          className={cn(
            "text-sm px-3 py-1 rounded-full border",
            view === "calendar" ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"
          )}
        >
          Calendar
        </Link>
        <span className="ml-auto text-sm text-muted-foreground">
          Published in {monthStr}:{" "}
          <span className="font-medium text-foreground">{publishedThisMonth}</span>
          {plan?.social_posts_per_month != null && ` / ${plan.social_posts_per_month} planned`}
        </span>
      </div>

      {view === "calendar" ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <Link
                href={`/clients/${clientId}/social?view=calendar&month=${fmtMonth(prevMonth)}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                ← {fmtMonth(prevMonth)}
              </Link>
              <CardTitle className="text-base">{monthStr}</CardTitle>
              <Link
                href={`/clients/${clientId}/social?view=calendar&month=${fmtMonth(nextMonth)}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {fmtMonth(nextMonth)} →
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground mb-1">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((day, i) => (
                <div
                  key={i}
                  className={cn(
                    "min-h-20 border rounded p-1 text-xs",
                    day == null && "bg-muted/30 border-transparent"
                  )}
                >
                  {day != null && (
                    <>
                      <div className="text-muted-foreground">{day}</div>
                      {(postsByDay.get(day) ?? []).map((p) => (
                        <div
                          key={p!.id}
                          className={cn("mt-0.5 rounded px-1 py-0.5 truncate", statusStyles[p!.status])}
                          title={p!.copy ?? ""}
                        >
                          {platformIcons[p!.platform]} {p!.copy?.slice(0, 20) ?? "(no copy)"}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Post tracker (log-only)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Posts are published in the native platforms or your scheduler; this
              logs them. In-app publishing comes in Phase 4.
            </p>
            {(posts ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No posts logged yet.</p>
            )}
            <ul className="space-y-2">
              {(posts ?? []).map((post) => (
                <li key={post.id} className="border rounded-md p-3">
                  <form
                    action={updateSocialPostAction.bind(null, clientId, post.id)}
                    className="space-y-2"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary">{platformIcons[post.platform]}</Badge>
                      <Badge variant="outline" className={cn("text-[10px]", statusStyles[post.status])}>
                        {post.status}
                      </Badge>
                      {post.scheduled_at && (
                        <span className="text-xs text-muted-foreground">
                          {post.scheduled_at.slice(0, 16).replace("T", " ")}
                        </span>
                      )}
                      <span className="ml-auto" />
                      <Button type="submit" variant="ghost" size="sm">Save</Button>
                    </div>
                    <Textarea name="copy" defaultValue={post.copy ?? ""} rows={2} placeholder="Post copy" className="text-xs" />
                    <div className="flex items-center gap-2 flex-wrap">
                      <select name="platform" defaultValue={post.platform} className={selectClass}>
                        {PLATFORMS.map((p) => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                      <select name="status" defaultValue={post.status} className={selectClass}>
                        {SOCIAL_STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      <Input name="scheduled_at" type="datetime-local" defaultValue={post.scheduled_at?.slice(0, 16) ?? ""} className="h-8 w-48 text-xs" />
                      <Input name="asset_url" placeholder="Asset (Drive/Canva link)" defaultValue={post.asset_url ?? ""} className="h-8 flex-1 min-w-36 text-xs" />
                      <Input name="published_url" placeholder="Published URL" defaultValue={post.published_url ?? ""} className="h-8 flex-1 min-w-36 text-xs" />
                    </div>
                  </form>
                  <form
                    action={deleteSocialPostAction.bind(null, clientId, post.id)}
                    className="flex justify-end -mt-7"
                  >
                    <Button variant="ghost" size="sm" type="submit">✕</Button>
                  </form>
                </li>
              ))}
            </ul>

            <form action={addPost} className="space-y-2 border-t pt-3">
              <Textarea name="copy" placeholder="New post copy" rows={2} className="text-xs" />
              <div className="flex gap-2 flex-wrap">
                <select name="platform" defaultValue="facebook" className={selectClass}>
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <select name="status" defaultValue="idea" className={selectClass}>
                  {SOCIAL_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <Input name="scheduled_at" type="datetime-local" className="h-8 w-48 text-xs" />
                <Input name="asset_url" placeholder="Asset link" className="h-8 flex-1 min-w-36 text-xs" />
                <Button type="submit" size="sm">Log post</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
