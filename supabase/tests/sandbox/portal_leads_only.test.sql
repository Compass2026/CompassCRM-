-- Two active portal contacts, direct view/RPC access and the billing runtime.
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
do $$ begin
  if not portal_has_reporting_access() then raise exception 'default scope changed'; end if;
  if (select count(*) from portal_reports)=0 then raise exception 'missing reporting fixture'; end if;
  if (select count(*) from portal_billing_summary_row())=0 then raise exception 'missing billing fixture'; end if;
end $$;
reset role;
update portal_users set access_scope='leads_only' where auth_user_id='00000000-0000-4000-a000-000000000011';
set local role authenticated;
do $$
declare v text; n int;
begin
  if portal_has_reporting_access() then raise exception 'lead contact has reporting'; end if;
  for v in select * from t.portal_views() loop
    execute format('select count(*) from public.%I',v) into n;
    if v in ('portal_client','portal_crm_lite','portal_inquiries','portal_inquiry_notes','portal_inquiry_events') then
      if n <> 1 then raise exception 'lead access lost or cross-client rows: % = %',v,n; end if;
    elsif n <> 0 then raise exception 'reporting leak: % = %',v,n;
    end if;
  end loop;
  if (select count(*) from portal_billing_summary_row())<>0 or
     (select count(*) from portal_entitlement_rows())<>0 then raise exception 'billing RPC leak'; end if;
  update portal_users set access_scope='full' where auth_user_id=auth.uid();
  get diagnostics n=row_count;
  if n<>0 or portal_has_reporting_access() then raise exception 'self scope escalation'; end if;
  if (select count(*) from clients)<>0 or (select count(*) from team_members)<>0 then raise exception 'agency access leak'; end if;
  perform crm_inquiry_add_note('00000000-0000-4000-f200-00000000000a','Scope test note');
end $$;
reset role;
set local role billing_sync;
do $$ begin
  if exists(select 1 from portal_users where auth_user_id='00000000-0000-4000-a000-000000000011') then raise exception 'billing runtime authorized lead contact'; end if;
  if not exists(select 1 from portal_users where auth_user_id='00000000-0000-4000-a000-000000000012') then raise exception 'billing runtime lost full contact'; end if;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000012","role":"authenticated"}', true);
do $$ begin
  if not portal_has_reporting_access() or (select count(*) from portal_reports)=0 then raise exception 'other contact lost reporting'; end if;
  if exists(select 1 from portal_inquiries where client_id='00000000-0000-4000-b000-00000000000a') then raise exception 'cross-client inquiry leak'; end if;
end $$;
reset role;
update portal_users set is_active=false where auth_user_id='00000000-0000-4000-a000-000000000011';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000011","role":"authenticated"}', true);
do $$ begin
  if portal_has_reporting_access() or exists(select 1 from portal_inquiries) then raise exception 'inactive contact retained access'; end if;
end $$;
rollback;
\echo 'leads-only scope: views, RPCs, self-escalation, inquiry notes, billing runtime, other client, and inactive contact passed'
