-- Stripe refreshes hosted invoice/PDF URLs even when billing data is unchanged.
-- Keep the newest links in the mirror, but fingerprint only their availability.
-- Adding/removing a link still counts; token rotation alone does not.
-- CREATE OR REPLACE preserves the existing owner and execute grants.
create or replace function public.billing_row_digest(r jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
  select md5((
    (r - array['id', 'created_at', 'updated_at', 'stripe_synced_at',
               'subscription_id', 'invoice_id', 'hosted_invoice_url', 'invoice_pdf'])
    || case when r ? 'hosted_invoice_url'
         then jsonb_build_object('hosted_invoice_url', coalesce(r ->> 'hosted_invoice_url', '') <> '')
         else '{}'::jsonb end
    || case when r ? 'invoice_pdf'
         then jsonb_build_object('invoice_pdf', coalesce(r ->> 'invoice_pdf', '') <> '')
         else '{}'::jsonb end
  )::text)
$$;

-- Focused regression checks. No client records or Stripe objects are modified.
do $$
declare
  original jsonb := '{"stripe_invoice_id":"in_FingerprintFixture","status":"paid","total_cents":250000,"amount_paid_cents":250000,"hosted_invoice_url":"https://invoice.stripe.com/old","invoice_pdf":"https://pay.stripe.com/old"}';
  rotated jsonb;
  field text;
begin
  rotated := original || '{"hosted_invoice_url":"https://invoice.stripe.com/new","invoice_pdf":"https://pay.stripe.com/new","stripe_synced_at":"2026-10-07T14:00:00Z"}'::jsonb;
  if billing_row_digest(original) is distinct from billing_row_digest(rotated) then
    raise exception 'Rotating invoice links must not count as a billing repair';
  end if;
  foreach field in array array['hosted_invoice_url', 'invoice_pdf'] loop
    if billing_row_digest(original) = billing_row_digest(original || jsonb_build_object(field, null)) then
      raise exception 'Removing % must still be detected', field;
    end if;
  end loop;
  foreach field in array array['total_cents', 'amount_paid_cents'] loop
    if billing_row_digest(original) = billing_row_digest(original || jsonb_build_object(field, 249999)) then
      raise exception 'A change to % must still be detected', field;
    end if;
  end loop;
  if billing_row_digest(original) = billing_row_digest(original || '{"status":"open"}'::jsonb) then
    raise exception 'A change to invoice status must still be detected';
  end if;
  if billing_row_digest('{"stripe_line_item_id":"il_Fixture","amount_cents":250000}'::jsonb)
     = billing_row_digest('{"stripe_line_item_id":"il_Fixture","amount_cents":249999}'::jsonb) then
    raise exception 'A change to invoice line amount must still be detected';
  end if;
end $$;
