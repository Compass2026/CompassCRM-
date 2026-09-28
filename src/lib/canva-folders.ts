// Canva folder ids on the client record (migration 0056). The Creative
// Engine will read a client's folders through client_canva_folders(); this
// is the typed side of that read. Nothing here calls Canva.
//
// The folder id is the integration key. A folder's name is a display label
// in Canva, can change there at any time, and is never stored or matched:
// "Show Me Used" sits inside Show Me Electrical's folder only because its id
// is recorded there.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Same rule as the clients_canva_*_format constraints in 0056.
export const CANVA_FOLDER_ID_PATTERN = "^FA[A-Za-z0-9_-]{6,62}$";
const CANVA_FOLDER_ID_RE = new RegExp(CANVA_FOLDER_ID_PATTERN);

export function isCanvaFolderId(value: unknown): value is string {
  return typeof value === "string" && CANVA_FOLDER_ID_RE.test(value);
}

export function canvaFolderUrl(folderId: string): string {
  if (!isCanvaFolderId(folderId)) throw new Error(`Not a Canva folder id: ${folderId}`);
  return `https://www.canva.com/folder/${folderId}`;
}

export type ClientCanvaFolders = {
  clientId: string;
  clientName: string;
  clientStatus: string;
  folderId: string | null;
  usedFolderId: string | null;
  // A primary folder on a client that is not offboarded.
  enabled: boolean;
};

type Row = Database["public"]["Functions"]["client_canva_folders"]["Returns"][number];

export function toClientCanvaFolders(row: Row): ClientCanvaFolders {
  const folderId = row.canva_folder_id ?? null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    clientStatus: row.client_status,
    folderId,
    usedFolderId: row.canva_used_folder_id ?? null,
    enabled: Boolean(row.canva_enabled) && folderId !== null,
  };
}

// One client's folders; null when the caller cannot see the client.
export async function loadClientCanvaFolders(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<{ folders: ClientCanvaFolders | null; error: string | null }> {
  const { data, error } = await supabase.rpc("client_canva_folders", { p_client_id: clientId });
  if (error) return { folders: null, error: error.message };
  const row = data?.[0];
  return { folders: row ? toClientCanvaFolders(row) : null, error: null };
}
