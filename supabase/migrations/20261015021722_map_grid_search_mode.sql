-- Keep historical run JSON immutable. Absent mode in old runs means true.
alter table public.map_grid_profiles
  add column search_this_area boolean not null default true;
