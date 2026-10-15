-- Dense 1/2/5-mile layout metadata. Additive: null means the profile's points
-- were hand-placed (the broad pilot). map_grid_start already freezes to_jsonb(profile),
-- so new runs carry geometry and old run JSON is never rewritten.
alter table public.map_grid_profiles
  add column geometry jsonb check (
    geometry is null or (
      jsonb_typeof(geometry) = 'object'
      and geometry->>'version' = 'local-multiscale-v1'
      and jsonb_typeof(geometry->'center'->'lat') = 'number'
      and jsonb_typeof(geometry->'center'->'lng') = 'number'
      and jsonb_typeof(geometry->'tiers') = 'array'
      and jsonb_array_length(geometry->'tiers') between 1 and 5
      and jsonb_typeof(geometry->'point_count') = 'number'
      and (geometry->>'point_count')::integer = jsonb_array_length(points)
    )
  );
