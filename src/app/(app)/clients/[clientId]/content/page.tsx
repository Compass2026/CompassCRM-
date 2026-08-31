import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  addContentPostAction,
  deleteContentPostAction,
  updateContentPostAction,
} from "@/app/tracker-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ownerLabels, owners } from "@/lib/labels";
import { cn } from "@/lib/utils";

const CONTENT_STATUSES = ["idea", "brief", "draft", "review", "published"] as const;
const selectClass =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs";

const statusStyles: Record<string, string> = {
  idea: "bg-zinc-100 text-zinc-600",
  brief: "bg-purple-100 text-purple-800",
  draft: "bg-blue-100 text-blue-800",
  review: "bg-amber-100 text-amber-800",
  published: "bg-green-100 text-green-800",
};

export default async function ContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { clientId } = await params;
  const { status: filter } = await searchParams;
  const supabase = await createClient();

  const [{ data: posts }, { data: keywords }, { data: plan }] =
    await Promise.all([
      supabase
        .from("content_posts")
        .select("*, keywords(id, keyword)")
        .eq("client_id", clientId)
        .order("due_date", { ascending: true, nullsFirst: false }),
      supabase
        .from("keywords")
        .select("id, keyword")
        .eq("client_id", clientId)
        .eq("is_active", true)
        .order("keyword"),
      supabase
        .from("plans")
        .select("blog_posts_per_month")
        .eq("client_id", clientId)
        .maybeSingle(),
    ]);

  const visible = filter
    ? (posts ?? []).filter((p) => p.status === filter)
    : posts ?? [];
  const thisMonth = new Date().toISOString().slice(0, 7);
  const publishedThisMonth = (posts ?? []).filter(
    (p) => p.status === "published" && p.published_at?.startsWith(thisMonth)
  ).length;

  const addPost = addContentPostAction.bind(null, clientId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={`/clients/${clientId}/content`}
          className={cn(
            "text-sm px-3 py-1 rounded-full border",
            !filter ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"
          )}
        >
          All
        </Link>
        {CONTENT_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/clients/${clientId}/content?status=${s}`}
            className={cn(
              "text-sm px-3 py-1 rounded-full border",
              filter === s
                ? "bg-primary text-primary-foreground border-primary"
                : "text-muted-foreground"
            )}
          >
            {s}
          </Link>
        ))}
        <span className="ml-auto text-sm text-muted-foreground">
          Published this month: <span className="font-medium text-foreground">{publishedThisMonth}</span>
          {plan?.blog_posts_per_month != null && ` / ${plan.blog_posts_per_month} planned`}
        </span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Blog tracker</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {visible.length === 0 && (
            <p className="text-sm text-muted-foreground">No posts{filter ? ` in ${filter}` : ""} yet.</p>
          )}
          <ul className="space-y-2">
            {visible.map((post) => (
              <li key={post.id} className="border rounded-md p-3">
                <form
                  action={updateContentPostAction.bind(null, clientId, post.id)}
                  className="space-y-2"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{post.title}</span>
                    <Badge variant="outline" className={cn("text-[10px]", statusStyles[post.status])}>
                      {post.status}
                    </Badge>
                    {post.published_at && (
                      <span className="text-xs text-muted-foreground">
                        published {post.published_at}
                      </span>
                    )}
                    <span className="ml-auto" />
                    <Button type="submit" variant="ghost" size="sm">Save</Button>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select name="status" defaultValue={post.status} className={selectClass}>
                      {CONTENT_STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    <select name="owner" defaultValue={post.owner} className={selectClass}>
                      {owners.map((o) => (
                        <option key={o} value={o}>{ownerLabels[o]}</option>
                      ))}
                    </select>
                    <select name="keyword_id" defaultValue={post.keyword_id ?? ""} className={cn(selectClass, "max-w-40")}>
                      <option value="">no keyword</option>
                      {(keywords ?? []).map((k) => (
                        <option key={k.id} value={k.id}>{k.keyword}</option>
                      ))}
                    </select>
                    <Input name="due_date" type="date" defaultValue={post.due_date ?? ""} className="h-8 w-36 text-xs" />
                    <Input name="url" placeholder="Published URL" defaultValue={post.url ?? ""} className="h-8 flex-1 min-w-40 text-xs" />
                    <Input name="word_count" type="number" placeholder="words" defaultValue={post.word_count ?? ""} className="h-8 w-20 text-xs" />
                  </div>
                </form>
                <form
                  action={deleteContentPostAction.bind(null, clientId, post.id)}
                  className="flex justify-end -mt-7"
                >
                  <Button variant="ghost" size="sm" type="submit">✕</Button>
                </form>
              </li>
            ))}
          </ul>

          <form action={addPost} className="flex gap-2 flex-wrap border-t pt-3">
            <Input name="title" placeholder="New post title / topic" required className="h-8 flex-1 min-w-56" />
            <select name="keyword_id" defaultValue="" className={selectClass}>
              <option value="">no keyword</option>
              {(keywords ?? []).map((k) => (
                <option key={k.id} value={k.id}>{k.keyword}</option>
              ))}
            </select>
            <select name="owner" defaultValue="CLAUDE_APPROVAL" className={selectClass}>
              {owners.map((o) => (
                <option key={o} value={o}>{ownerLabels[o]}</option>
              ))}
            </select>
            <Input name="due_date" type="date" className="h-8 w-36 text-xs" />
            <Button type="submit" size="sm">Add post</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
