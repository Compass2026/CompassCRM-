# GBP pilot: approval-day runbook (Lucas Construction)

What to do once Google approves Business Profile API access: merge PR #62,
deploy its three Edge Functions, connect Google for Business Profile only,
select Lucas Construction's profile, check it can be read, and **stop before
any write**.

Written Sept 24 2026 against PR #62 head `533f7b9` on `main` `673855d`.

> **Re-verify every operational value at execution time.** The commits,
> function versions, case number, project, quotas, account names and expected
> outputs below were true when this was written. Check each one against the
> live system before acting on it, and stop if anything differs.

## Reference (re-verify before use)

| Item | Value when written |
| --- | --- |
| Google support case (API access application) | `9-0457000041837` (Google's estimate: 7–10 business days) |
| Google Cloud project | `compass-client-platform` |
| Project number | `308261457231` |
| Organization | `compassmarketing.ai` |
| Business Profile agency organization / business group | Compass Marketing / Compass Managed Clients |
| Pilot profile | Lucas Construction and Roofing (inside the group, verified) |
| OAuth client | the existing `gsc-sync` Web application, audience Internal |
| Redirect URI the code needs | `https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/google-connect` |
| Data Access scopes | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/business.manage` |
| Supabase project | `iokcopiyzajigvhwexhe` |
| App (production) | `https://compass-crm-ten.vercel.app` |
| PR | #62, branch `claude/festive-hopper-p01r6x` |
| Rollback baseline | `main` `673855d`; `google-connect` v2, `google-ops` v4, `post-publisher` v1 |

State when written: Account Management API and Business Information API
enabled; Account Management quota **0**; Google My Business API (v4) not
available pending approval; Worker Google Ops OFF; publisher
`{"enabled":false,"clients":[]}`; no `GOOGLE_OPS_REFRESH_TOKEN`; no client
has a `gbp_location`; 0 posts; 0 publisher runs.

**Production `google-connect` v2 still asks for Business Profile, Analytics
and Gmail. Nobody presses Connect until step 9 below has passed.**

## 0. When Google's approval arrives (Tom, before any merge)

1. **The approval email** refers to case `9-0457000041837` and project
   `compass-client-platform` / `308261457231`.
2. **Quotas.** APIs & Services → **My Business Account Management API** →
   Quotas & System Limits: "Requests per minute" should change from **0 to a
   non-zero value** (usually 300). Check **My Business Business Information
   API** the same way. Still 0 means access isn't active yet: wait, don't
   merge.
3. **Google My Business API.** It should now appear in the API Library.
   **Enable it** and confirm its quota is non-zero. It serves the v4 posts
   list used in step 15, and later publishing.
4. **No drift in Google Auth Platform.**
   - Audience still **Internal**.
   - Data Access still exactly `openid`, `userinfo.email`, `business.manage`
     (don't add scopes).
   - The `google-connect` redirect URI is still listed on the `gsc-sync` Web
     client.
   - Leave the OAuth Playground redirect URI alone for now; it's probably how
     the Search Console token was minted.
5. **Business Profile side.** Lucas Construction and Roofing is still
   verified and inside Compass Marketing › Compass Managed Clients, and the
   account Tom will connect with can see it in Business Profile Manager.

Only when all five pass, start at step 1.

## A. Final pre-merge checks

1. Fetch `main`. Confirm the PR #62 head and `main` are the commits you
   expect (`533f7b9` / `673855d` when written).
   - If `main` has moved: merge `main` into the PR branch (no rebase), re-run
     every check below, push, and wait for `validate` to pass.
   - Checks: `npm test`, `npm run test:publisher`, `npm run lint` (0 errors),
     `npx tsc --noEmit`, an Edge Function typecheck of `google-connect`,
     `google-ops`, `post-publisher`, `gsc-sync` and `_shared`, and
     `npm run build`.
2. On GitHub, PR #62 shows `mergeable_state: clean`, `validate` passed on the
   current head, and no unresolved review threads.
3. Record the rollback baseline: the current `main` commit and the deployed
   versions of `google-connect`, `google-ops` and `post-publisher`
   (`list_edge_functions`).
4. **Safety snapshot.** Run it (Supabase SQL editor or MCP) and keep the
   output:

   ```sql
   select jsonb_build_object(
     'worker_google_ops', (select value from app_settings where key='worker_google_ops'),
     'publisher',         (select value from app_settings where key='publisher'),
     'google_ops',        (select value from app_settings where key='google_ops'),
     'google_secrets',    (select jsonb_agg(name order by name) from vault.secrets where name ~ '^(GSC_|GOOGLE_|GA4_)'),
     'gsc_token_updated', (select updated_at from vault.secrets where name='GSC_REFRESH_TOKEN'),
     'gbp_locations_set', (select count(*) from clients where gbp_location is not null),
     'posts',             (select count(*) from social_posts),
     'publisher_runs',    (select count(*) from publisher_runs));
   ```

   Expected:
   - `worker_google_ops` null (OFF);
   - publisher `{"enabled":false,"clients":[]}`;
   - `google_ops` null;
   - secrets are only `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`,
     `GSC_REFRESH_TOKEN` (**no `GOOGLE_OPS_REFRESH_TOKEN`**);
   - `gbp_locations_set` 0, posts 0, publisher runs 0.

   Note `gsc_token_updated`; step 11 compares against it. Never select
   secret values, only names and timestamps.

## B. Merge

5. Merge PR #62 with **"Create a merge commit"**, the same way as #60 and
   #61. Record the merge commit as **M**.
   - Vercel then deploys the app from `main`; confirm the `compass-crm`
     production deployment for M is READY.
   - Between the merge and step 6, the live Settings page talks to the old
     `google-connect`. **Nobody presses Connect.**

## C. Deploy the three functions together, immediately, from M

6. Deploy with the Supabase MCP `deploy_edge_function` (as for PR #61), using
   file contents exactly as they are at M:

| Function | Files | Entrypoint | `verify_jwt` | Version after (was) |
| --- | --- | --- | --- | --- |
| `google-connect` | `index.ts`, `handler.ts` | `index.ts` | **false** | v3 (v2) |
| `google-ops` | `supabase/functions/google-ops/index.ts`, `supabase/functions/google-ops/handler.ts`, `supabase/functions/_shared/worker-google.ts` (full repo paths, because it imports `_shared`) | `supabase/functions/google-ops/index.ts` | true | v5 (v4) |
| `post-publisher` | `index.ts`, `handler.ts`, `channel.ts`, `google.ts`, `store.ts` | `index.ts` | true | v2 (v1) |

- **`google-connect` must keep `verify_jwt = false`.** Google's redirect
  carries no JWT; the HMAC-signed, ten-minute state authorizes the callback,
  and every POST mode checks a team JWT itself.
- Do **not** redeploy `gsc-sync`; this PR doesn't change it.

## D. Post-deploy verification

7. **Code check.**
   - `list_edge_functions`: the three new versions, and `verify_jwt` false /
     true / true.
   - For each function, `get_edge_function`: the sha256 of every served file
     equals `git show M:<path> | sha256sum`. Any mismatch: stop, redeploy.
8. **Behaviour check without Google** (no token exists yet):
   - `post-publisher` tick (cron header) answers 200 with `enabled: false`.
   - `google-ops` `gbp_posts` answers 410.
   - `google-ops` `gbp_apply` for Lucas through the cron door answers 403
     `worker_google_ops_off`.
   - `google-connect` GET with a junk `state` answers 400.
   - Settings shows **Connect Business Profile** and the new **Business
     Profile location per client** section.
9. **Safety snapshot again** (the step 4 query): identical to the baseline,
   still no `GOOGLE_OPS_REFRESH_TOKEN`.

## E. Read-only connection

10. **Connect.**
    - Tom signs in at `https://compass-crm-ten.vercel.app` and goes to
      Settings › Google hands › **Connect Business Profile**.
    - He chooses the Workspace account that belongs to the Compass Marketing
      Business Profile organization and can see the Compass Managed Clients
      group.
    - Google's consent screen for "Compass Client Platform" should list only
      three things: the email address, OpenID, and "See, edit, create, and
      delete your Google business listings".
    - **If Analytics or Gmail appears, press Cancel.** That means the old
      function is still live.
    - Otherwise press Allow. He should land back on
      `/settings?google=connected`.
11. **Confirm the scopes.**
    - Settings shows badges for `openid`, `userinfo.email` and
      `business.manage`, with nothing in red.
    - In SQL:

      ```sql
      select value->'email', value->'scopes', value->'missing_scopes'
      from app_settings where key = 'google_ops';
      ```

      Expect exactly `openid`, `https://www.googleapis.com/auth/userinfo.email`
      and `https://www.googleapis.com/auth/business.manage`, with
      `missing_scopes` empty.
    - Vault now also has `GOOGLE_OPS_REFRESH_TOKEN` (check the name only,
      never the value).
    - `GSC_REFRESH_TOKEN`'s `updated_at` is unchanged from step 4.
    - The code refuses to store a token granted anything more than these
      three; a `google=error` banner naming extra scopes means nothing was
      stored.
12. **List.**
    - Under **Business Profile location per client**, choose Lucas
      Construction, then **List Business Profile locations**.
    - Expect "Lucas Construction and Roofing" with ✓ phone (636-459-9328),
      probably ✓ website, ✗ exact name (the client is "Lucas Construction"),
      and no "not verified" badge.
    - The listing must say it's complete. A quota or 403 error means approval
      isn't active yet: stop.
    - If Lucas appears under two accounts (the organization and the Compass
      Managed Clients group), the location ID is the same in both. Pick the
      entry under the Compass Managed Clients group account.
    - Hints never select anything, and listing writes nothing.
13. **Select.**
    - Tick "This is Lucas Construction's own profile", then **Use for Lucas
      Construction**.
    - Expect: "Lucas Construction → Lucas Construction and Roofing
      (accounts/…/locations/…) saved. Verified with Google; posts list
      readable."
    - Before saving, the function re-read the location, confirmed it sits
      under that account, and checked the name hadn't changed. It only saves
      while `clients.gbp_location` is empty.
14. **Verify what was stored.**

    ```sql
    select name, gbp_location, gbp_location ~ '^accounts/\d+/locations/\d+$' as canonical
    from clients where gbp_location is not null;
    ```

    Expect exactly one row: Lucas, `canonical = true`, the value Tom picked.
15. **Posts-list check.** The step 13 message must say "posts list
    readable". This call lists posts and creates nothing.
    - If it says "not readable": the location is still correctly saved, but
      the Google My Business API isn't live. Stop and fix that in Cloud
      before any publishing work.
    - Selecting the same location again doesn't re-run this check. That's
      why step 0.3 enables the API before selecting.

## F. Stop point: before any write

16. Run the step 4 query one last time. Expected:
    - worker switch null (OFF);
    - publisher `{"enabled":false,"clients":[]}`;
    - 0 posts, 0 publisher runs;
    - exactly one `gbp_location` (Lucas).

**Stop here.** Don't turn on Worker Google Ops, don't enable the publisher,
don't add Lucas to the pilot list, don't run `gbp_apply` or `gbp_qa`, and
don't create a post. The next step (drafting and approving the Roof
Replacement post, then enabling the publisher for Lucas only) needs its own
explicit approval.

## Rollback

- **Bad deploy (before connecting):** redeploy the three functions from the
  rollback baseline (`673855d` when written) with their previous settings
  (`google-connect` `verify_jwt = false`; the other two true), then re-run
  steps 7–9 against that commit.
- **Unwanted or wrong token:**
  - delete `GOOGLE_OPS_REFRESH_TOKEN` from Vault and the `google_ops` row
    from `app_settings`;
  - do **not** revoke the app at myaccount.google.com/permissions: it's the
    same OAuth app as Search Console, so revoking could also end
    `GSC_REFRESH_TOKEN`.
- **Wrong location:** with Tom's approval, clear it with a deliberate update
  (`update clients set gbp_location = null where id = '<client id>';`), then
  select again through Settings. Nothing clears or replaces it
  automatically.
- **The app:** revert the merge commit on `main` (Vercel redeploys), then
  roll the functions back as above.

## Safety rules this PR provides (re-check if the code changes)

- Connect Business Profile requests `openid email business.manage` only, with
  `include_granted_scopes=false` and offline access.
- A token granted anything broader is not stored.
- Search Console keeps its own `GSC_REFRESH_TOKEN`; nothing here writes it.
- `gbp_select` is the only writer of `clients.gbp_location`. It verifies with
  Google first and never overwrites.
- `google-ops` `gbp_locate` only suggests (`GBP_LOCATION_REQUIRED` +
  `suggestions`). `gbp_apply` and `gbp_qa` stop the same way when no
  location is selected.
- The publisher never searches for a location. With none selected it blocks
  with `GBP_LOCATION_REQUIRED` and opens a `publisher_select_location` task.
- OAuth return URLs are limited to `https://compass-crm-ten.vercel.app` and
  `http://localhost:3000`.
- Connecting, listing and selecting make no Google write and never change the
  Worker Google Ops or publisher settings.
