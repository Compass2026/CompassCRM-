"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { gridForRadius } from "@/lib/geo";
import { citiesWithinRadius, searchCitiesByName } from "@/lib/us-cities";
import type { Database } from "@/lib/database.types";

type Enums = Database["public"]["Enums"];

function str(form: FormData, key: string): string | null {
  const v = form.get(key);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function num(form: FormData, key: string): number | null {
  const v = str(form, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Keywords ───────────────────────────────────────────────────────────────
export async function addKeywordAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.from("keywords").insert({
    client_id: clientId,
    keyword: (str(form, "keyword") ?? "").toLowerCase(),
    target_url: str(form, "target_url"),
    priority: (str(form, "priority") as Enums["keyword_priority"]) ?? "p2",
    department: (str(form, "department") as Enums["department"]) ?? "seo",
  });
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

export async function updateKeywordAction(
  clientId: string,
  keywordId: string,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("keywords")
    .update({
      target_url: str(form, "target_url"),
      priority: (str(form, "priority") as Enums["keyword_priority"]) ?? undefined,
      is_active: form.get("is_active") === "on",
    })
    .eq("id", keywordId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

export async function deleteKeywordAction(clientId: string, keywordId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("keywords").delete().eq("id", keywordId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

// ── Locations ──────────────────────────────────────────────────────────────
export type LocationInput = {
  name: string;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  is_physical_location: boolean;
};

export async function addLocationsAction(
  clientId: string,
  locations: LocationInput[]
) {
  const supabase = await createClient();
  const { error } = await supabase.from("locations").insert(
    locations.map((l) => ({
      client_id: clientId,
      name: l.name,
      city: l.city,
      state: l.state,
      lat: l.lat,
      lng: l.lng,
      is_physical_location: l.is_physical_location,
    }))
  );
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

export async function updateLocationAction(
  clientId: string,
  locationId: string,
  form: FormData
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("locations")
    .update({
      name: str(form, "name") ?? undefined,
      is_physical_location: form.get("is_physical_location") === "on",
      is_active: form.get("is_active") === "on",
    })
    .eq("id", locationId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

export async function deleteLocationAction(clientId: string, locationId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("locations")
    .delete()
    .eq("id", locationId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

// ── Geo lookups (OpenStreetMap — server-side, no key needed) ───────────────
const OSM_HEADERS = {
  "User-Agent": "CompassClientPlatform/1.0 (internal agency tool)",
};

export type GeocodeResult = {
  display_name: string;
  name: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
};

export async function geocodeSearchAction(
  query: string
): Promise<GeocodeResult[]> {
  // Nominatim handles full addresses; the bundled GeoNames dataset is the
  // fallback (and usually the faster answer) for plain city names.
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: OSM_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const rows = (await res.json()) as {
        display_name: string;
        name: string;
        lat: string;
        lon: string;
        address?: Record<string, string>;
      }[];
      if (rows.length > 0) {
        return rows.map((r) => ({
          display_name: r.display_name,
          name: r.name || r.display_name.split(",")[0],
          city:
            r.address?.city ??
            r.address?.town ??
            r.address?.village ??
            r.name ??
            null,
          state: r.address?.state ?? null,
          lat: Number(r.lat),
          lng: Number(r.lon),
        }));
      }
    }
  } catch {
    // fall through to the local dataset
  }
  return searchCitiesByName(query).map((c) => ({
    display_name: `${c.name}, ${c.state}`,
    name: c.name,
    city: c.name,
    state: c.state,
    lat: c.lat,
    lng: c.lng,
  }));
}

export type NearbyCity = {
  name: string;
  state: string | null;
  lat: number;
  lng: number;
  distance_miles: number;
  place_type: string;
};

export async function nearbyCitiesAction(
  lat: number,
  lng: number,
  radiusMiles: number
): Promise<NearbyCity[]> {
  // Offline lookup against the bundled GeoNames dataset — no rate limits.
  return citiesWithinRadius(lat, lng, radiusMiles).map((c) => ({
    name: c.name,
    state: c.state,
    lat: c.lat,
    lng: c.lng,
    distance_miles: c.distance_miles,
    place_type:
      c.population >= 50000 ? "city" : c.population >= 5000 ? "town" : "village",
  }));
}

// ── Grid configs ───────────────────────────────────────────────────────────
export async function upsertGridConfigAction(
  clientId: string,
  locationId: string,
  form: FormData
) {
  const supabase = await createClient();

  // A radius input wins: derive grid size + spacing so the grid spans it.
  const radius = num(form, "radius_miles");
  let grid_size = num(form, "grid_size") ?? 7;
  let spacing_miles = num(form, "spacing_miles") ?? 1;
  if (radius && radius > 0) {
    const derived = gridForRadius(radius);
    grid_size = derived.grid_size;
    spacing_miles = derived.spacing_miles;
  }

  const { data: existing } = await supabase
    .from("grid_configs")
    .select("id")
    .eq("location_id", locationId)
    .maybeSingle();

  // Default the keyword set to every active keyword for the client.
  const { data: kws } = await supabase
    .from("keywords")
    .select("id")
    .eq("client_id", clientId)
    .eq("is_active", true);

  const payload = {
    location_id: locationId,
    grid_size,
    spacing_miles,
    center_lat: num(form, "center_lat"),
    center_lng: num(form, "center_lng"),
    keyword_ids: (kws ?? []).map((k) => k.id),
    is_active: true,
  };

  const { error } = existing
    ? await supabase.from("grid_configs").update(payload).eq("id", existing.id)
    : await supabase.from("grid_configs").insert(payload);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

export async function deleteGridConfigAction(
  clientId: string,
  gridConfigId: string
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("grid_configs")
    .delete()
    .eq("id", gridConfigId);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}

// ── BrightLocal sync (Edge Function) ───────────────────────────────────────
// Ingests the latest LRT + LSG results for this client's linked locations.
// Read-only against BrightLocal — never triggers billable report runs.
export async function runBrightLocalSyncAction(clientId: string) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/brightlocal-sync`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sync failed (${res.status}): ${text.slice(0, 200)}`);
  }
  revalidatePath(`/clients/${clientId}/keywords`);
}

// ── GSC sync (Edge Function) ───────────────────────────────────────────────
export async function runGscSyncAction(clientId: string) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/gsc-sync`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: clientId }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GSC sync failed (${res.status}): ${text.slice(0, 200)}`);
  }
  revalidatePath(`/clients/${clientId}/keywords`);
}

// Promote a discovered GSC query into the tracked keyword set and link its
// existing snapshots.
export async function addDiscoveredKeywordAction(
  clientId: string,
  query: string
) {
  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("keywords")
    .insert({
      client_id: clientId,
      keyword: query.toLowerCase(),
      department: "seo",
      priority: "p3",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await supabase
    .from("gsc_snapshots")
    .update({ keyword_id: created.id })
    .eq("client_id", clientId)
    .ilike("query", query);
  revalidatePath(`/clients/${clientId}/keywords`);
}

// ── CSV rank import (fallback until BrightLocal sync) ──────────────────────
// Expected columns: keyword, location, position, date[, type]
// type: organic (default) | map_pack. Blank/"-" position = not in top 100.
export async function importRankCsvAction(clientId: string, form: FormData) {
  const supabase = await createClient();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("No file");
  const text = await file.text();

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("CSV has no data rows");

  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iKeyword = col("keyword");
  const iLocation = col("location");
  const iPosition = col("position");
  const iDate = col("date");
  const iType = col("type");
  if (iKeyword < 0 || iLocation < 0 || iPosition < 0) {
    throw new Error("CSV needs keyword, location, position columns");
  }

  const [{ data: keywords }, { data: locations }] = await Promise.all([
    supabase.from("keywords").select("id, keyword").eq("client_id", clientId),
    supabase
      .from("locations")
      .select("id, name, city")
      .eq("client_id", clientId),
  ]);
  const kwByText = new Map(
    (keywords ?? []).map((k) => [k.keyword.toLowerCase(), k.id])
  );
  const locByName = new Map<string, string>();
  for (const l of locations ?? []) {
    locByName.set(l.name.toLowerCase(), l.id);
    if (l.city) locByName.set(l.city.toLowerCase(), l.id);
  }

  const rows: Database["public"]["Tables"]["rank_snapshots"]["Insert"][] = [];
  const skipped: string[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    const kwId = kwByText.get((cells[iKeyword] ?? "").toLowerCase());
    const locId = locByName.get((cells[iLocation] ?? "").toLowerCase());
    if (!kwId || !locId) {
      skipped.push(line);
      continue;
    }
    const posRaw = cells[iPosition];
    const position =
      posRaw && posRaw !== "-" && Number.isFinite(Number(posRaw))
        ? Number(posRaw)
        : null;
    const type =
      iType >= 0 && cells[iType]?.toLowerCase() === "map_pack"
        ? "map_pack"
        : "organic";
    const date = iDate >= 0 && cells[iDate] ? cells[iDate] : null;
    rows.push({
      keyword_id: kwId,
      location_id: locId,
      result_type: type,
      position,
      source: "csv",
      ...(date ? { recorded_at: new Date(date).toISOString() } : {}),
    });
  }

  if (rows.length === 0) {
    throw new Error(
      `No rows matched existing keywords/locations (${skipped.length} skipped)`
    );
  }
  const { error } = await supabase.from("rank_snapshots").insert(rows);
  if (error) throw new Error(error.message);
  revalidatePath(`/clients/${clientId}/keywords`);
}
