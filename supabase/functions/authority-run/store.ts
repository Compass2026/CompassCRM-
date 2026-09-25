// authority-run's only door to the database: supabase-js with the service
// role, so every call reaches Postgres through PostgREST as authenticator +
// service_role, the one session 0048's run functions admit. It reads through
// authority_input / authority_fingerprint and the team-readable
// authority_runs, and writes only through authority_begin_run and
// authority_record_run. It never writes a table directly.
import type { Inventory } from "../authority/inventory.ts";
import type { RecordPayload } from "./classify.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type Mode = "full" | "refresh";
export type BeginResult = { run_id: string } | { conflict: true; running_run_id: string | null };
export type LatestInventory = { run_id: string; inventory: Inventory | null } | null;
export type FailedPayload = { status: "failed"; error: string };

export function createStore(supabase: Client) {
  return {
    async secret(name: string): Promise<string | null> {
      const { data } = await supabase.rpc("get_secret", { secret_name: name });
      return (data as string | null) || null;
    },

    // "none": no or invalid JWT; null member: signed in but not on the team.
    async caller(jwt: string): Promise<"none" | { member: string | null }> {
      if (!jwt) return "none";
      const { data } = await supabase.auth.getUser(jwt);
      if (!data?.user) return "none";
      const { data: m } = await supabase.from("team_members").select("id").eq("auth_user_id", data.user.id).maybeSingle();
      return { member: m?.id ?? null };
    },

    async client(id: string): Promise<{ id: string; status: string } | null> {
      const { data, error } = await supabase.from("clients").select("id, status").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    // The latest completed run's observation, for a refresh.
    async latestInventory(clientId: string): Promise<LatestInventory> {
      const { data, error } = await supabase.from("authority_runs").select("id, inventory")
        .eq("client_id", clientId).eq("status", "completed").order("finished_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { run_id: data.id, inventory: (data.inventory as Inventory | null) ?? null } : null;
    },

    async begin(clientId: string, mode: Mode, via: "team" | "worker", by: string | null): Promise<BeginResult> {
      const { data, error } = await supabase.rpc("authority_begin_run",
        { p_client_id: clientId, p_mode: mode, p_requested_via: via, p_requested_by: by });
      if (error) {
        if (error.code === "55P03") {
          const { data: r } = await supabase.from("authority_runs").select("id").eq("client_id", clientId).eq("status", "running").maybeSingle();
          return { conflict: true, running_run_id: r?.id ?? null };
        }
        throw new Error(error.message);
      }
      return { run_id: data as string };
    },

    async fingerprint(clientId: string): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("authority_fingerprint", { p_client_id: clientId });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },

    async input(clientId: string): Promise<Record<string, unknown> | null> {
      const { data, error } = await supabase.rpc("authority_input", { p_client_id: clientId });
      if (error) throw new Error(error.message);
      return (data as Record<string, unknown> | null) ?? null;
    },

    async record(runId: string, p: RecordPayload | FailedPayload): Promise<Record<string, unknown>> {
      const { data, error } = await supabase.rpc("authority_record_run", { p_run_id: runId, p });
      if (error) throw new Error(error.message);
      return data as Record<string, unknown>;
    },
  };
}

export type Store = ReturnType<typeof createStore>;
