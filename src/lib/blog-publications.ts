import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "./database.types";
export type BlogPublication = {
  id: string; client_id: string; draft_id: string; draft_version: number;
  status: string; scheduled_at: string; published_url: string | null; last_error: string | null;
  release_hash: string; snapshot: Json; released_by: string; released_at: string;
  lease_token: string | null; lease_expires_at: string | null; commit_sha: string | null;
  published_at: string | null; evidence: Json | null;
};
// Schema additions on the integration branch, until types are regenerated from
// the deployed migration. This wraps the same signed-in client and its RLS.
type BlogSchema = { public: {
  Tables: { blog_publications: {Row:BlogPublication;Insert:never;Update:never;Relationships:[]} };
  Views: Record<never,never>;
  Functions: {
    blog_publication_queue: {Args:{p_draft_id:string;p_version:number;p_scheduled_at?:string};Returns:string};
    blog_publication_cancel: {Args:{p_id:string};Returns:undefined};
  };
  Enums: Record<never,never>; CompositeTypes: Record<never,never>;
}};
export const blogClient = (client: unknown) => client as SupabaseClient<BlogSchema>;

export type BlogPublicationSummary = Pick<BlogPublication, "id"|"draft_version"|"status"|"scheduled_at"|"published_url"|"last_error">;
