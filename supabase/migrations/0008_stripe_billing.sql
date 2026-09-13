-- Phase 3 — Stripe billing plumbing.
-- Secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) live in Vault, not in
-- git, and are read by the stripe-webhook / stripe-billing Edge Functions
-- through get_secret(). Tables (stripe_customers, subscriptions, payments)
-- exist since 0001; this adds webhook idempotency, the open-invoice pay
-- link, and the daily past-due sweep.

-- Webhook idempotency: Stripe retries deliveries, so each event id is
-- recorded once and duplicates are acknowledged without re-processing.
create table stripe_events (
  id text primary key, -- Stripe event id (evt_...)
  type text not null,
  received_at timestamptz not null default now()
);
alter table stripe_events enable row level security;
create policy "team read stripe events" on stripe_events
  for select to authenticated using (true);

-- Hosted invoice URL for the invoice currently awaiting payment, so the
-- Billing tab can offer a "pay / resend" link. Set on subscription setup
-- and on invoice.payment_failed; superseded invoices just overwrite it.
alter table subscriptions add column latest_invoice_url text;

-- Daily sweep: any subscription past its period end (plus ACH-settlement
-- grace) that never saw invoice.paid goes past_due. 'processing' is left
-- alone — an ACH debit in flight either lands as invoice.paid or fails as
-- invoice.payment_failed, and both webhooks set the status themselves.
create or replace function mark_past_due_subscriptions() returns void
language sql security definer
set search_path = public
as $$
  update subscriptions
     set paid_status = 'past_due'
   where paid_status = 'open'
     and current_period_end is not null
     and current_period_end < now() - interval '3 days'
     and coalesce(status, 'active') not in ('canceled', 'paused');
$$;
revoke execute on function mark_past_due_subscriptions() from public, anon, authenticated;

select cron.schedule(
  'billing-daily-past-due',
  '30 6 * * *',
  $$select public.mark_past_due_subscriptions()$$
);
