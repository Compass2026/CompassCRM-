import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
export type BlogPublication = Database["public"]["Tables"]["blog_publications"]["Row"];
export type BlogPublicationSummary = Pick<BlogPublication, "id"|"draft_version"|"status"|"scheduled_at"|"published_url"|"last_error">;
// The caller's existing signed-in client; publication RPCs enforce team access.
export const blogClient = (client: SupabaseClient<Database>) => client;
