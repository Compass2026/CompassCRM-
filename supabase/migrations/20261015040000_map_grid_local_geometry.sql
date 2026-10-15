-- Dense 1/2/5-mile layout metadata. Additive: null means the profile's points
-- were hand-placed (the broad pilot). map_grid_start already freezes to_jsonb(profile),
-- so new runs carry geometry and old run JSON is never rewritten.

-- Strictly true or false, never null: a CHECK passes on UNKNOWN, so every
-- required key is tested with IS DISTINCT FROM and the function ends in true
-- only when all of them hold. SQL NULL geometry (legacy profiles) is valid.
create function public.map_grid_geometry_valid(g jsonb, point_count integer)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare t jsonb; previous numeric := 0; i integer := 0;
begin
  if g is null then return true; end if;
  if jsonb_typeof(g) is distinct from 'object'
     or g->>'version' is distinct from 'local-multiscale-v1'
     or jsonb_typeof(g->'center'->'lat') is distinct from 'number'
     or jsonb_typeof(g->'center'->'lng') is distinct from 'number'
     or jsonb_typeof(g->'tiers') is distinct from 'array'
     or jsonb_typeof(g->'radii_miles') is distinct from 'array'
     or jsonb_typeof(g->'default_radius_miles') is distinct from 'number'
     or jsonb_typeof(g->'point_count') is distinct from 'number' then
    return false;
  end if;
  if abs((g->'center'->>'lat')::numeric) > 85 or abs((g->'center'->>'lng')::numeric) > 180
     or jsonb_array_length(g->'tiers') not between 1 and 5
     or jsonb_array_length(g->'radii_miles') <> jsonb_array_length(g->'tiers')
     or (g->>'point_count')::numeric is distinct from point_count then
    return false;
  end if;
  for t in select value from jsonb_array_elements(g->'tiers') loop
    if jsonb_typeof(t->'max_miles') is distinct from 'number'
       or jsonb_typeof(t->'spacing_miles') is distinct from 'number'
       or (t->>'spacing_miles')::numeric <= 0
       or (t->>'spacing_miles')::numeric > (t->>'max_miles')::numeric
       or (t->>'max_miles')::numeric <= previous
       or (g->'radii_miles'->i) is distinct from (t->'max_miles') then
      return false;
    end if;
    previous := (t->>'max_miles')::numeric;
    i := i + 1;
  end loop;
  return (g->'radii_miles') @> jsonb_build_array(g->'default_radius_miles');
end $$;

alter table public.map_grid_profiles
  add column geometry jsonb
  check (public.map_grid_geometry_valid(geometry, jsonb_array_length(points)));
