-- Market-centered map grids (Oct 15 2026). A service-area business with no
-- public address (Logic Solar, Wichita) is sampled around a documented market
-- center instead of a business location. geometry.center_kind is 'business'
-- (absent = business, every geometry so far) or 'market'; a market center
-- carries center_label so the viewer measures from the scan center, never
-- "from the business". Same signature, so the existing CHECK uses it at once.
create or replace function public.map_grid_geometry_valid(g jsonb, point_count integer)
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
  -- Optional center description; a market center must say which market.
  if g ? 'center_kind' and (jsonb_typeof(g->'center_kind') is distinct from 'string'
       or g->>'center_kind' not in ('business', 'market')) then
    return false;
  end if;
  if g ? 'center_label' and (jsonb_typeof(g->'center_label') is distinct from 'string'
       or length(btrim(g->>'center_label')) = 0 or length(g->>'center_label') > 80) then
    return false;
  end if;
  if g->>'center_kind' = 'market' and not g ? 'center_label' then
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
