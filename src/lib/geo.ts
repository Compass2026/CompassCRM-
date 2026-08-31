export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8; // earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pick a grid that spans the requested radius from center: the outermost
// row/column sits at ~radius miles, so spacing = 2r / (size - 1).
export function gridForRadius(radiusMiles: number): {
  grid_size: number;
  spacing_miles: number;
} {
  const grid_size = radiusMiles <= 2.5 ? 5 : radiusMiles <= 7 ? 7 : 9;
  const spacing = (2 * radiusMiles) / (grid_size - 1);
  return { grid_size, spacing_miles: Math.round(spacing * 10) / 10 };
}
