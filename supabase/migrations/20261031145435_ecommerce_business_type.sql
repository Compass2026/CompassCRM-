-- Online stores use a shipping market; this does not establish GBP eligibility.
alter type public.business_type add value if not exists 'ecommerce';
