// GeoNames cities500 extract (US populated places), CC BY 4.0 —
// https://www.geonames.org. Tuples: [name, state, lat, lng, population].
import rawCities from "@/data/us-cities.json";
import { haversineMiles } from "@/lib/geo";

type CityTuple = [string, string, number, number, number];
const cities = rawCities as CityTuple[];

export type UsCity = {
  name: string;
  state: string;
  lat: number;
  lng: number;
  population: number;
};

export function citiesWithinRadius(
  lat: number,
  lng: number,
  radiusMiles: number,
  limit = 60
): (UsCity & { distance_miles: number })[] {
  // Cheap bounding-box prefilter before the haversine pass.
  const latDelta = radiusMiles / 69;
  const lngDelta = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180) || 1);
  return cities
    .filter(
      ([, , cLat, cLng]) =>
        Math.abs(cLat - lat) <= latDelta && Math.abs(cLng - lng) <= lngDelta
    )
    .map(([name, state, cLat, cLng, population]) => ({
      name,
      state,
      lat: cLat,
      lng: cLng,
      population,
      distance_miles:
        Math.round(haversineMiles(lat, lng, cLat, cLng) * 10) / 10,
    }))
    .filter((c) => c.distance_miles <= radiusMiles)
    .sort((a, b) => a.distance_miles - b.distance_miles)
    .slice(0, limit);
}

export function searchCitiesByName(query: string, limit = 5): UsCity[] {
  const q = query.trim().toLowerCase();
  // Accept "city st" / "city, st" forms.
  const match = q.match(/^(.*?)[,\s]+([a-z]{2})$/);
  const name = match ? match[1].trim() : q;
  const state = match ? match[2].toUpperCase() : null;
  return cities
    .filter(
      ([cName, cState]) =>
        cName.toLowerCase().startsWith(name) && (!state || cState === state)
    )
    .slice(0, limit)
    .map(([cName, cState, lat, lng, population]) => ({
      name: cName,
      state: cState,
      lat,
      lng,
      population,
    }));
}
