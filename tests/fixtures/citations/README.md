# Citation import fixtures (SAMPLE DATA)

Fictional, generic CSV files for tests and local demos only. They are **not**
a BrightLocal export or any provider's format, and must never be imported into
production. Every business, phone (555) and domain (`example.test`) is made up.
The `Login password` column exists to prove credential-like columns are
refused.

A provider-specific mapping (BrightLocal or another) is added only once a real
export sample has been reviewed.

`synthetic-brightlocal-campaign.csv` follows the real BrightLocal Citation
Builder campaign export **contract**: the nine columns in order, 15 directory
rows (8 Live, 1 Updated, 2 Submitted, 1 Unavailable, 3 blank) and the
single-cell "Aggregator/Network" footer. The business, URLs, ids and phone
digits are synthetic. Its Notes deliberately carry FAKE credentials and a FAKE
tokenized verification link, to prove the Notes column is never imported and
that content screening rejects them. No real customer export is committed;
the real pilot file stays outside the repository.
