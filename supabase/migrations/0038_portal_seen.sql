-- Portal: stamp when a client actually looked (Sept 17 2026).
--
-- portal_users is team-writable only, so a portal user cannot update their own
-- row. This is the one write they may do, and it touches nothing else: the
-- Overview tab shows "invited" until a contact signs in, then "active".

create or replace function portal_seen() returns void
language sql security definer set search_path = public as $$
  update portal_users
  set last_seen_at = now()
  where auth_user_id = auth.uid() and is_active;
$$;
revoke execute on function portal_seen() from public, anon;
grant execute on function portal_seen() to authenticated;
comment on function portal_seen() is
  'Stamps last_seen_at for the signed-in portal user. The portal layout calls it; it can touch no other row.';
