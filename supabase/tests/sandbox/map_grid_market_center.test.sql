-- Market-centered geometry: labelled market centers are valid, everything ambiguous is refused,
-- and geometry without center_kind (every profile so far) still means business.
do $$
declare
  b jsonb := '{"version":"local-multiscale-v1","center":{"lat":37.69,"lng":-97.34},"tiers":[{"max_miles":5,"spacing_miles":1}],"radii_miles":[5],"default_radius_miles":5,"point_count":2}';
  m jsonb := b || '{"center_kind":"market","center_label":"Wichita, KS market center"}';
  bad jsonb;
begin
  if public.map_grid_geometry_valid(b, 2) is not true then raise exception 'legacy business geometry refused'; end if;
  if public.map_grid_geometry_valid(b || '{"center_kind":"business"}', 2) is not true then raise exception 'explicit business refused'; end if;
  if public.map_grid_geometry_valid(m, 2) is not true then raise exception 'labelled market center refused'; end if;
  foreach bad in array array[
    b || '{"center_kind":"market"}',
    b || '{"center_kind":"storefront","center_label":"x"}',
    b || '{"center_kind":5}',
    m || '{"center_label":""}',
    m || '{"center_label":"   "}',
    m || jsonb_build_object('center_label', repeat('x', 81)),
    m || '{"center_label":7}'] loop
    if public.map_grid_geometry_valid(bad, 2) is not false then
      raise exception 'market geometry validator did not refuse %', bad;
    end if;
  end loop;
end $$;
