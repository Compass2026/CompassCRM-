-- Follow-up to the Lucas keyword-first pilot.
-- The original migration used literal "\\n" markers in the one revised
-- Christmas caption. Production was corrected immediately; this keeps fresh
-- environments convergent and is a no-op once real newlines are present.
do $fix$
declare
  v_client uuid;
begin
  select id into v_client
  from clients
  where website_url in ('https://lucasconstructionmo.com', 'https://www.lucasconstructionmo.com')
  order by created_at
  limit 1;

  if v_client is not null then
    perform set_config('compass.post_system','on',true);

    with target as (
      select distinct sp.id
      from social_posts sp
      join post_assets pa on pa.post_id=sp.id and pa.client_id=sp.client_id
      join brand_assets ba on ba.id=pa.brand_asset_id and ba.client_id=sp.client_id
      where sp.client_id=v_client
        and ba.label='xmas-09-schedule-early-for-the-holidays'
    )
    update social_posts sp
    set review_status='draft'
    from target t
    where sp.id=t.id
      and sp.review_status='in_review'
      and sp.publish_status='not_scheduled'
      and position(E'\\\\n' in sp.copy)>0;

    with target as (
      select distinct sp.id
      from social_posts sp
      join post_assets pa on pa.post_id=sp.id and pa.client_id=sp.client_id
      join brand_assets ba on ba.id=pa.brand_asset_id and ba.client_id=sp.client_id
      where sp.client_id=v_client
        and ba.label='xmas-09-schedule-early-for-the-holidays'
    )
    update social_posts sp
    set copy=replace(sp.copy,E'\\\\n',chr(10))
    from target t
    where sp.id=t.id
      and sp.review_status='draft'
      and position(E'\\\\n' in sp.copy)>0;

    with target as (
      select distinct sp.id
      from social_posts sp
      join post_assets pa on pa.post_id=sp.id and pa.client_id=sp.client_id
      join brand_assets ba on ba.id=pa.brand_asset_id and ba.client_id=sp.client_id
      where sp.client_id=v_client
        and ba.label='xmas-09-schedule-early-for-the-holidays'
    )
    update social_posts sp
    set review_status='in_review'
    from target t
    where sp.id=t.id
      and sp.review_status='draft';
  end if;
end
$fix$;
