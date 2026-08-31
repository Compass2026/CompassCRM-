"use client";

import { useState, useTransition } from "react";
import {
  addLocationsAction,
  deleteLocationAction,
  geocodeSearchAction,
  nearbyCitiesAction,
  updateLocationAction,
  type GeocodeResult,
  type NearbyCity,
} from "@/app/rank-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export type LocationRow = {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  is_physical_location: boolean;
  is_active: boolean;
};

export function LocationsPanel({
  clientId,
  locations,
}: {
  clientId: string;
  locations: LocationRow[];
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [suggestFor, setSuggestFor] = useState<string | null>(null);
  const [radius, setRadius] = useState("5");
  const [nearby, setNearby] = useState<NearbyCity[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const existingNames = new Set(locations.map((l) => l.name.toLowerCase()));

  function search() {
    setError(null);
    startTransition(async () => {
      try {
        setResults(await geocodeSearchAction(query));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search failed");
      }
    });
  }

  function addResult(r: GeocodeResult, physical: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        await addLocationsAction(clientId, [
          {
            name: r.name,
            city: r.city,
            state: r.state,
            lat: r.lat,
            lng: r.lng,
            is_physical_location: physical,
          },
        ]);
        setResults(null);
        setQuery("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Add failed");
      }
    });
  }

  function suggest(loc: LocationRow) {
    if (loc.lat == null || loc.lng == null) {
      setError(`${loc.name} has no coordinates — re-add it via search.`);
      return;
    }
    setError(null);
    setSuggestFor(loc.id);
    setNearby(null);
    setChecked(new Set());
    startTransition(async () => {
      try {
        const cities = await nearbyCitiesAction(
          loc.lat!,
          loc.lng!,
          Number(radius) || 5
        );
        setNearby(cities.filter((c) => !existingNames.has(c.name.toLowerCase())));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Lookup failed");
      }
    });
  }

  function addSelected() {
    if (!nearby) return;
    const toAdd = nearby.filter((c) => checked.has(c.name));
    if (toAdd.length === 0) return;
    startTransition(async () => {
      try {
        await addLocationsAction(
          clientId,
          toAdd.map((c) => ({
            name: c.name,
            city: c.name,
            state: c.state,
            lat: c.lat,
            lng: c.lng,
            is_physical_location: false,
          }))
        );
        setNearby(null);
        setSuggestFor(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Add failed");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Tracked locations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Cities / service areas where ranks are checked. Mark a location as
          physical to enable its geo-grid.
        </p>

        <ul className="space-y-2">
          {locations.map((loc) => (
            <li key={loc.id} className="border rounded-md px-3 py-2 text-sm space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{loc.name}</span>
                {loc.state && (
                  <span className="text-muted-foreground text-xs">{loc.state}</span>
                )}
                {loc.is_physical_location && (
                  <Badge variant="secondary">physical · grid</Badge>
                )}
                {!loc.is_active && <Badge variant="outline">inactive</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => suggest(loc)}
                  >
                    Nearby cities
                  </Button>
                  <form
                    action={updateLocationAction.bind(null, clientId, loc.id)}
                    className="inline-flex items-center gap-2"
                  >
                    <input type="hidden" name="name" value={loc.name} />
                    <label className="text-xs text-muted-foreground flex items-center gap-1">
                      <input
                        type="checkbox"
                        name="is_physical_location"
                        defaultChecked={loc.is_physical_location}
                      />
                      physical
                    </label>
                    <label className="text-xs text-muted-foreground flex items-center gap-1">
                      <input type="checkbox" name="is_active" defaultChecked={loc.is_active} />
                      active
                    </label>
                    <Button variant="ghost" size="sm" type="submit">
                      Save
                    </Button>
                  </form>
                  <form action={deleteLocationAction.bind(null, clientId, loc.id)}>
                    <Button variant="ghost" size="sm" type="submit">
                      ✕
                    </Button>
                  </form>
                </span>
              </div>

              {suggestFor === loc.id && (
                <div className="border-t pt-2 space-y-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span>Cities within</span>
                    <Input
                      value={radius}
                      onChange={(e) => setRadius(e.target.value)}
                      className="h-7 w-16"
                      type="number"
                      min="1"
                      max="50"
                    />
                    <span>miles</span>
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => suggest(loc)}>
                      Refresh
                    </Button>
                  </div>
                  {pending && !nearby && (
                    <p className="text-xs text-muted-foreground">Searching…</p>
                  )}
                  {nearby && nearby.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No new towns found in that radius.
                    </p>
                  )}
                  {nearby && nearby.length > 0 && (
                    <>
                      <div className="grid grid-cols-2 gap-1">
                        {nearby.map((c) => (
                          <label key={`${c.name}-${c.lat}`} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={checked.has(c.name)}
                              onChange={(e) => {
                                const next = new Set(checked);
                                if (e.target.checked) next.add(c.name);
                                else next.delete(c.name);
                                setChecked(next);
                              }}
                            />
                            {c.name}
                            <span className="text-muted-foreground">
                              {c.distance_miles} mi · {c.place_type}
                            </span>
                          </label>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" disabled={pending || checked.size === 0} onClick={addSelected}>
                          Add {checked.size || ""} selected
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSuggestFor(null);
                            setNearby(null);
                          }}
                        >
                          Close
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
          {locations.length === 0 && (
            <p className="text-sm text-muted-foreground">No locations yet.</p>
          )}
        </ul>

        <div className="border-t pt-3 space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="Add a city or address (e.g. Pensacola FL)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
            <Button variant="outline" disabled={pending || query.length < 3} onClick={search}>
              Search
            </Button>
          </div>
          {results && (
            <ul className="space-y-1">
              {results.length === 0 && (
                <p className="text-xs text-muted-foreground">No matches.</p>
              )}
              {results.map((r) => (
                <li key={r.display_name} className="flex items-center gap-2 text-xs border rounded px-2 py-1.5">
                  <span className="flex-1 truncate">{r.display_name}</span>
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => addResult(r, false)}>
                    Track city
                  </Button>
                  <Button size="sm" disabled={pending} onClick={() => addResult(r, true)}>
                    Add as physical
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
