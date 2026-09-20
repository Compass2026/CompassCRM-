# Follow-ups

Deferred on purpose, in the order to take them up. Each line says what it
unblocks and what it costs.

## Needs Tom's decision or money

1. **BrightLocal spend.** Two things wait on a per-client credit cap:
   Citation Builder submissions (`citation_submit`) and the Local Rank
   Tracker + Local Search Grid reports (`brightlocal_lrt`, `brightlocal_lsg`).
   With a cap, a function like `google-ops` calls the BrightLocal API and the
   tasks stop landing on Tom. The trial key (1,000 lifetime requests) needs
   replacing first.
2. **Google ops token.** Settings › Google hands has the button: **Connect
   Google** signs in as the Compass Workspace account and stores
   `GOOGLE_OPS_REFRESH_TOKEN` in Vault; pick the Analytics account for
   `GA4_ACCOUNT_ID` on the same card; **Check access** shows which clients'
   Business Profile / Search Console the account can already reach. Before
   the first press: add the redirect URI the card shows to the OAuth app,
   enable the Business Profile, Analytics Admin and Gmail APIs on the Google
   Cloud project (and request Business Profile API access once). Then one
   `google_access` grant per client that shows *no*. Until then GBP apply,
   GA4 and drafts fall back to Tom's tasks. Once connected, set each
   client's GBP Setup and Tracking Setup stages to *Not started* on the
   Foundation tab so the worker applies the specs it already wrote.
2b. **Keyword lists to the 50-keyword shape.** DataForSEO credentials are
   in Vault (Sept 14) and `rank-sync` runs weekly. Lucas, Show Me
   Electrical and Ginger Huff have no city-tagged keywords, so their checks
   run at the home city: set their Keyword Research stages to *Not started*
   so the worker city-tags the lists (and tops Show Me Electrical up to 50).
3. **Stripe secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — billing
   is built and inert.
4. **Pensacola**: blend the `compass-astro` branch into `main` (Launch is
   blocked on it) and create the Search Console property.
5. **Delete `Compass2026/zz-sitepush-smoke`, `Compass2026/lucasconstruction`
   and `Compass2026/gingerhuffinteriors`** — the token cannot (admin rights).
5b. **Finish the Next.js builds** (Tom): Pensacola (locations + blog data
   files, canonicals), Show Me Electrical (full site), Ginger Huff, Show Me
   Design and Logic Solar (rebuild from Vite on the Lucas contract). Each
   one flips the Website Updates stage on for that client.
5c. **Website Updates stage — built Sept 14, first run Sept 15** (migration
   0035, site-push v8, Put it back, playbooks). Lucas's September run:
   two city refreshes live on lucasconstructionmo.com, two service pages
   in `Compass2026/lucas_construction` PR #9 (Tom merges; the preview
   needs a Vercel login). Still to do: put BHG on the contract
   (`content_paths` with `blog_format: markdown`, `blog_dir: content/blog`)
   once its blog entry shape is checked; Pensacola after its data files
   exist; the weekly blog cron only covers `active` clients, so Lucas
   (still `launching`) gets no blog task until it converges or Tom sets it
   active. Vercel deployment protection on previews: turn it off on the
   client projects if the client is to see a PR preview without a login.
5d. **Foundation v1 integration — built Sept 21, not activated.** Branch
   `claude/foundation-v1-crm-integration`: migration 0036 (work modes,
   build brief, `foundation_releases`), site-push v9 (branch of record,
   previews, archive mode), content adapters, worker playbook. Activation
   steps in `docs/compass-foundation-integration.md`. BHG Safety Partners
   is the first upgrade pilot (`docs/clients/bhg-safety-partners-upgrade-brief.md`).

## Worth building next

6. **Client domains on Vercel DNS** would remove the last DNS gate (Tom adds
   records at each registrar today).
7. **Photos**: a client upload link that lands in Drive `Media` so Polish
   can place them without Tom forwarding files.
8. **Social and Paid Ads pipelines** have no playbooks and no worker.
9. **Decision recording on approve / veto** and autonomy promotion
   (reconciliation step 8) — no hold steps exist, so low value today.
10. **Client portal** (Phase 5): read-only report, site and task views per
    client.
11. **Auth mail via Resend** so magic links stop rate-limiting.
12. **Brand board snapshot from the worker.** The Brand Build checklist item
    "Publish the board snapshot to Documents" needs Storage write access the
    worker session does not have, so it stays open on every new client. Add
    a `brand-snapshot` mode to an Edge Function (the app's publish action
    already renders the HTML) and let the worker call it.
