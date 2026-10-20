# Prospect SEO & Competitor Report — Compass Marketing Advisors

Compass-branded. The Found It Marketing edition, with its own brand and no
Compass references, is `prospect-seo-report-found-it.md`.

The sales version of the client SEO report prompt. The client report shows a
customer what is working. This one is for a **prospect** before they sign: it
measures where they stand against the local competitors who are taking their
searches, puts a number on the demand they are not capturing, and lays out the
plan Compass would run. Everything is measured; nothing is invented to make the
pitch land.

Paste everything below the line into a new Claude Code session after filling
in the PROSPECT CONFIG block. It produces two print-ready PDFs for the prospect
and one internal brief for the person running the meeting.

**Credentials are never pasted into this prompt.** Set `DATAFORSEO_LOGIN` /
`DATAFORSEO_PASSWORD` as secrets of the Claude Code environment (or in a
gitignored `.env` in the session), and use the Data for SEO connector where it
covers an endpoint.

This prompt is a pre-sale tool. It writes nothing to the Compass CRM: no
client row, no keywords, no tasks. If the prospect signs, onboarding starts
from the New client dialog as usual.

---

## PROSPECT CONFIG — fill this in before sending

```
Business name (exactly as on Google):  <e.g. Upward Development LLC>
Website domain (or "none"):            <e.g. upwarddevelopment.us>
City, State:                           <e.g. Lake Charles, Louisiana>
State (for volume lookups):            <e.g. Louisiana>
Services sold:                         <e.g. dirt work, land clearing, excavation,
                                        house pads, culverts, metal buildings>
Surrounding towns they serve:          <e.g. Sulphur, Moss Bluff, Westlake, DeRidder,
                                        Vinton, Iowa, Jennings, Kinder, DeQuincy>
Competitors they named (optional):     <e.g. "Bayou Dirt Works", "Gulf Coast Site Prep">
Prepared for (person, optional):       <e.g. Jordan Smith, Owner>
Agency name for the byline:            Compass Marketing Advisors
Contact for the call to action:        <name · phone · email · booking link>
Services Compass will propose:         <default: SEO, Google Business Profile, Website
                                        Management, Blog Posts, GBP Posts, Social Media,
                                        Monthly Reporting, Client Portal>
Proof points we may cite (optional):   <only real results, with the client's
                                        permission, e.g. "Lucas Construction: …">
Offer / terms to state (optional):     <e.g. "month-to-month, no setup fee" — leave
                                        blank to state no terms>
Report date:                           <e.g. October 2026>
Include AI-assistant check (yes/no):   <yes>
```

---

## THE TASK

Produce two print-ready PDFs for the prospect above and one internal Markdown
brief, using the DataForSEO API. Do all of the research first, then build the
documents. Work from measured data only — never estimate a number you did not
pull, and never turn a measurement into a revenue promise.

### API access

DataForSEO, HTTP Basic auth against `https://api.dataforseo.com/v3`, using
`DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` from the environment. If they are
not set, stop and ask for them; never ask for them to be pasted into chat, and
never write them into a file that is not gitignored (confirm `.env` is ignored
before writing one; never commit it). Header:
`Authorization: Basic <base64 of login:password>`.

Verify with `GET /v3/appendix/user_data` — a 200 returns the account balance.
A 401 means the portal password was used instead of the API password.

**Budget.** A prospect run with four competitors costs more than a client
report — expect roughly **$2–4**. Record the balance before you start and after
you finish, and put the actual spend in the internal brief. If the run is about
to pass **$6**, stop and ask before continuing.

The Data for SEO connector (`mcp__Data_for_SEO__*`) covers Labs, organic SERP,
backlinks, on-page / Lighthouse and the AI endpoints. It does **not** cover the
Maps SERP or `my_business_info` — call those over HTTP.

### Endpoint quirks — these cost hours if rediscovered

- **Labs endpoints ignore state-level locations.** `dataforseo_labs/*` with
  `location_name: "Louisiana,United States"` returns **zero rows with a 200 OK
  and no error**. Always pass `location_code: 2840` (United States) to Labs.
- **Google Ads volume does accept state names.**
  `keywords_data/google_ads/search_volume/live` with
  `location_name: "<State>,United States"` works. Discover and score with Labs
  at US level, then get real local volumes from Google Ads at state level.
- **Map pack results depend entirely on where the searcher stands.** Running
  the keywords from the city centre will show a business absent everywhere and
  look like a broken profile. Measure from the business's own coordinates, and
  run the grid (step 4) to show how the result moves.
- **Organic SERP needs a city location code.** Look the city up with
  `serp/google/locations/us` (or the connector's `serp_locations`) and pass its
  `location_code`; if the city is not listed, use the state and say so.
- **Backlinks is a separate DataForSEO subscription.** A `40204` status means
  the account has no access — record "not measured" and move on; do not
  substitute a Labs number.
- **Reviews are task-based.** `business_data/google/reviews/task_post` returns
  a task id; poll `tasks_ready` / `task_get`. Allow a few minutes.
- **Directories crowd the results.** Yelp, Angi, HomeAdvisor, Thumbtack, BBB,
  Houzz, Nextdoor, Porch, Facebook and similar are not competitors. Exclude
  them from competitor selection (step 2); note in the brief when one holds a
  top organic spot.

### Step 1 — Find the prospect and its profile

```
POST serp/google/maps/live/advanced
  { keyword: "<business name>", location_coordinate: "<city lat>,<city lng>,13z",
    language_code: "en", depth: 10 }
```
Take `latitude` / `longitude` from the matching result — **these coordinates
drive steps 2 and 4.** If no listing matches, try the phone number and the name
with the city; if there is still none, the prospect has no Business Profile.
That is the headline finding — say so and measure from the city centre, stating
that on the page.

```
POST business_data/google/my_business_info/live
  { keyword: "<business name>", location_coordinate: "<business lat>,<lng>,13z" }
```
Record: `is_claimed`, `rating.value`, `rating.votes_count`,
`rating_distribution`, `category`, `additional_categories`, `services[]`,
`total_photos`, `work_time`, `url`, `description`, `place_id`, `cid`.

### Step 2 — Identify the real competitors

The competitors are whoever the prospect's customers see instead of them, not
whoever the prospect thinks of.

1. Run the map pack for each core term (`<service> near me` for the main
   services, plus `<service> <city>` for the top two) **from the prospect's
   pin**, `depth: 20`. Tally every business that appears in positions 1–3.
2. Drop the prospect, directories and lead-gen listings, and any business whose
   category does not sell the prospect's services.
3. Take the **top 3–5 by top-three appearances**. Always add each competitor
   the prospect named, even if it never appears — "named by you; not in the top
   three for any term we measured" is itself a finding.
4. A national franchise or chain that holds the pack stays in; label it.
5. For each competitor record: name, `place_id`, coordinates, website domain,
   primary category, and how many of the measured terms it holds a top-three
   spot for.

Optional supplement: `dataforseo_labs/google/competitors_domain/live`
(`location_code: 2840`) on the prospect's domain. It is US-wide and noisy; use
it only to catch a local competitor the map pack missed.

### Step 3 — Keywords

1. **Discover**: `dataforseo_labs/google/keyword_ideas/live`,
   `location_code: 2840`, seeded in small groups from the services list,
   `filters: [["keyword_info.search_volume", ">", 30]]`.
2. **Filter hard.** Raw ideas return heavy noise (unit conversions, unrelated
   trades, famous buildings). Keep only terms naming a service the prospect
   actually sells.
3. **Build candidates**: each service alone and with `near me`, `contractor`,
   `company`, `cost`, `services`, plus each service paired with each town.
4. **Measure**: `keywords_data/google_ads/search_volume/live`,
   `location_name: "<State>,United States"` — up to 700 keywords per call.
   Keep those with volume > 0.
5. **Difficulty**: `dataforseo_labs/google/bulk_keyword_difficulty/live`,
   `location_code: 2840`.
6. **Score**: `value = volume × cpc`, then `score = value / (1 + difficulty/10)`.
   The top 10 by score are the **money keywords**.
7. **Cut to exactly 50** for the sheet — drop the lowest-value terms. A sheet
   titled "50 terms" must contain 50 rows.

### Step 4 — Rankings: the prospect against the competitors

Every call here returns the whole result list, so record **every tracked
business's** position from the same response — the competitor comparison costs
no extra calls.

**Map pack, from the prospect's pin** — the headline numbers:
```
POST serp/google/maps/live/advanced
  { keyword: "<term>", location_coordinate: "<business lat>,<lng>,13z", depth: 100 }
```
Run for the money keywords that are local-intent (`near me`, `<service> <town>`,
`contractor`, `company`) plus the step 2 core terms. For each term record the
prospect's position (or "not in the top 100"), each competitor's position, and
the name, category and review count of whoever holds 1–3.

**Visibility grid** — run 3 of the strongest keywords from ~9 coordinates: the
prospect's pin, a point 5 km out, the city centre, and each surrounding town.
At every point record the prospect's position and each competitor's. Derive
**grid share** per business: the share of (point × keyword) cells where it is in
the top three. This shows how far each profile carries and is usually the most
persuasive single finding — "at 6 of 9 points, <Competitor> shows up and you
don't."

**Organic, local** — for the 10 money keywords:
```
POST serp/google/organic/live/advanced
  { keyword: "<term>", location_code: <city code>, language_code: "en", depth: 100 }
```
Record the prospect's and each competitor's organic position, whether a local
pack shows, and whether ads or Local Services Ads appear above it (record the
fact only; no ad-spend claims).

**Organic footprint** (context): `dataforseo_labs/google/ranked_keywords/live`
for the prospect and each competitor domain, `location_name: "United States"`,
`limit: 200`. Keep only terms naming a service. Watch for domains ranking on
competitors' brand names — common, and worth nothing.

### Step 5 — Competitor deep-dive

For the prospect and each competitor:

- **Business Profile**: `my_business_info` (fields as step 1). Build the side-by-
  side: claimed, rating, reviews, primary + additional categories (count),
  services listed (count), photos, hours present, website linked, description
  present.
- **Review momentum** (optional; task-based): `business_data/google/reviews/
  task_post`, `depth: 100`, `sort_by: "newest"`. Count reviews in the last 90
  days and the share with an owner reply. Skip if time or budget is short and
  say so.
- **Domain strength**: `dataforseo_labs/google/domain_rank_overview/live`
  (`location_code: 2840`) — organic keyword count and estimated traffic value.
  Label traffic as "DataForSEO estimate"; it is modelled, not measured.
- **Links**: `backlinks/summary/live` — referring domains and rank.
- **Keyword gap**: terms from the 50-term sheet where a competitor ranks in the
  organic top 20 (step 4 SERP or `ranked_keywords`) and the prospect is not in
  the top 100. These are the clearest "here is what you are missing" rows.
- **Website basics** for the prospect and the two strongest competitors:
  `on_page/lighthouse/live/json` (mobile; performance, SEO, accessibility, best
  practices) and `on_page/instant_pages` on the home page (title, meta
  description, H1, HTTPS, LocalBusiness schema, load time). Report only what
  the tool returned.

If the prospect has no website, skip their domain checks and make "no website
to rank" a finding; still measure the competitors.

### Step 6 — What AI assistants recommend (optional, config)

Ask ChatGPT through `ai_optimization/chat_gpt/llm_scraper/live/advanced` (the
connector's `ai_optimization_chat_gpt_scraper`) three plain questions a customer
would ask — "Who is the best <service> company in <city>?", "<service> near
<town>", "Who should I call for <service> in <city>?" — and record which
businesses each answer names, in order. It is a point-in-time sample: answers
vary between runs and users, so present it as "what one assistant said on
<date>", never as a ranking.

### Step 7 — Compute the gap numbers

Define every headline number exactly, over terms you actually measured:

- **Lost terms** — measured map pack terms where at least one competitor is in
  the top three and the prospect is not. Show as "N of M".
- **Lost searches** — the sum of state monthly search volume over the lost
  terms. Say "searches a month in <State>"; never call them customers or leads.
- **Advertiser value** — the sum of `volume × cpc` over the lost terms: "what
  advertisers pay Google each month for clicks on these searches". Terms with no
  CPC count as 0 and the note says so.
- **Grid share** — per business, from step 4.
- **Biggest single gap** — the lost term with the highest advertiser value, and
  who holds it.

Do not convert any of these into revenue, jobs or ROI. If the meeting needs
that, it is a conversation using the prospect's own numbers — put the talking
point in the internal brief, not on the page.

### Step 8 — Build the PDFs

Author each as a standalone HTML file, then render with headless Chromium.

**Fonts.** Chromium cannot reach Google Fonts here — TLS handshakes fail
through the proxy and it silently falls back to system fonts. `curl` does work.
So: fetch the Google Fonts CSS with a browser User-Agent, `curl` each `.woff2`
it references, base64 them into `@font-face` `data:` URIs, and inline that CSS.
Fonts: **Inter** 400/500/600/700 (Compass's typeface; headings 700, body 400,
emphasis 500/600) and **IBM Plex Mono** 600 for eyebrows and figure labels.

**Palette** — Compass's navy / royal / orange
(`docs/design-system.md`). The prospect is always royal; competitors are
always the muted grey, so the eye finds the prospect on every chart:
```
--ground #F3F6FB   --surface #FFFFFF   --raised #EDF3FD
--ink #0B162A      --ink-mid #33425C   --ink-mute #4A5A74
--rule #D3DEEE     --rule-soft #E6EDF7
--prospect #1A3F84  --prospect-soft #DCE8FA     (the prospect's bars and rows)
--competitor #7D8AA0                             (competitor bars, never text)
--mark #E85D04      (header strip, small marks — never text or a fill behind text)
--good #2E7049      --gap #B54708                (working / missing labels)
```
Checked: every text token is ≥ 5:1 on `--ground` and `--surface`; `--prospect`
and `--competitor` are ≥ 3.2:1 on both and clearly apart from each other in
lightness, so they survive greyscale printing. Never encode working / missing
by colour alone — pair it with a word or a symbol.

**Look** — the Compass house style, so it reads like the CRM and the client
reports: a light-blue ground, white cards with 16 px rounded corners and a
1 px `--rule` ring, a 6 px orange strip across the top of page 1, eyebrows in
royal uppercase IBM Plex Mono, headlines in navy Inter 700, KPI figures large
in navy with the label above. Generous white space; no dark panels.

**Print CSS:**
```css
@page { size: Letter; margin: 0.55in 0.5in; }
* { print-color-adjust: exact !important; -webkit-print-color-adjust: exact !important; }
section, .card, table, tr { break-inside: avoid; }
thead { display: table-header-group; }
```
Drop box-shadows for print — they band badly.

**Render:**
```bash
find /opt/pw-browsers -name chrome -path '*chrome-linux*'   # locate the binary
<chrome> --headless --disable-gpu --no-sandbox \
  --virtual-time-budget=15000 --no-pdf-header-footer \
  --print-to-pdf=<out>.pdf file:///<absolute path>.html
```
Screenshot every page of the HTML and look at it before rendering. Verify the
page size is 8.5 × 11 in. (Scanning the PDF for `/BaseFont` under-reports — font
names sit in compressed streams. Trust the screenshot.)

Name the files `<Prospect> — Local Search Opportunity — <Month YYYY>.pdf` and
`<Prospect> — Keyword & Competitor Sheet — <Month YYYY>.pdf`.

---

## DELIVERABLE 1 — Local Search Opportunity report (for the prospect)

Six to eight pages. Page 1 must work on its own — most prospects read only it.

**Page 1 — the summary.** Eyebrow ("Local search opportunity review"), a
headline stating the biggest measured gap in plain words ("Three competitors
take the map pack for 'excavation near me' — you're not in the top 20"), a
two-sentence lede, then Prepared for / Prepared by / Date / Market. Three KPI
tiles: **lost terms** (N of M), **lost searches** a month, **advertiser value**
a month. One line naming who is winning most often. The call to action at the
foot of the page.

Then:

1. **What's already working** — the honest positives (rating, a term they hold,
   a complete profile field). Starting here earns the right to show the gaps.
2. **Who's showing up instead of you** — the map pack table: term, your
   position, who holds 1–3 (name and review count). Lost rows marked with a word,
   not just colour.
3. **How far each profile reaches** — the visibility grid: a dot map or a
   table of points by distance, the prospect vs the strongest competitor, and a
   grid-share bar chart (prospect `--prospect`, competitors `--competitor`,
   values labelled directly).
4. **Reputation** — horizontal bar chart of review counts and ratings, the
   prospect highlighted; review momentum (last 90 days, reply rate) if
   measured.
5. **Profile and website, side by side** — a matrix: rows are the checks
   (claimed, categories, services, photos, hours, description, website, mobile
   speed, page title / H1, LocalBusiness schema, referring domains), columns are
   the prospect and each competitor, cells are values or ✓ / — with words.
6. **Searches you're not capturing** — the money keywords with searches, cost
   per click, difficulty, your position and who holds it now; then the keyword
   gap count ("<Competitor> ranks for 14 of your 50 terms; you rank for 3").
7. **What AI assistants say** (if run) — the businesses each answer named, the
   date, and the point-in-time caveat.
8. **The plan** — a table: each gap → the Compass work that addresses it → what
   the prospect will see us measure (weekly rank checks on their tracked
   keywords, map grid scans, the monthly report, the client portal). Map only
   to the services in "Services Compass will propose". When no Compass service
   addresses a gap (often reviews), say plainly what the owner can do
   themselves — honesty here is persuasive.
9. **Why Compass** — short and concrete: how we work (every claim on their
   site and posts comes from a sourced or confirmed fact; a person approves
   before anything publishes; the same measurements in this report are re-run
   every month so progress is visible), the proof points from config only, and
   the terms from config only. No logos, testimonials or results that were not
   supplied.
10. **Next step** — one call to action with the contact from config.
11. **Footer** — method, data source (DataForSEO; Google Ads volumes for
    <State>), the measurement date, and the location caveat: "Map positions
    were measured from <point> on <date>; they change with where the searcher
    stands."

## DELIVERABLE 2 — Keyword & competitor sheet (for the prospect)

Same masthead and palette so the two pair. Then:

1. **The ten worth going after first** — rank, term, searches, cost per click,
   difficulty, who holds it now, and one line on why each earns its place.
2. **Competitor scorecard** — one row per business: rating, reviews, primary
   category, photos, terms held in the top three, grid share, organic keyword
   count, referring domains. The prospect's row tinted `--prospect-soft`.
3. **All 50 by service** — grouped tables: term, searches, cost per click,
   difficulty, your map position (where measured), your organic position (where
   measured), current leader. Money keywords numbered and tinted. State on the
   page that difficulty is 0–100, that a dash under cost per click means too few
   advertisers bid for Google to report a price — not that the term lacks
   intent — and that a blank position means the term was not measured, while
   "—" means measured and not found.
4. **Footer** — method and data source.

## DELIVERABLE 3 — Internal sales brief (never sent to the prospect)

A Markdown file next to the PDFs, plus its summary in chat:

- The numbers behind every headline, with the terms they were computed over.
- The three strongest talking points, each tied to a page of the report.
- The prospect's weak spots stated plainly, including anything softened or
  left off the PDFs and why.
- Data gaps: anything not measured (no backlinks access, no profile found,
  reviews skipped, a city not in the location list) and how it affects the
  story.
- Likely objections ("we get enough work from referrals", "we tried SEO
  before", "a directory sends us leads") with honest answers drawn from the
  data.
- If the meeting needs a revenue conversation: the formula to work through
  *with the prospect's own* job value and close rate — never a figure we
  supply.
- The recommended scope from "Services Compass will propose", and what would
  be measured at 30 / 60 / 90 days.
- DataForSEO balance before and after, and the actual spend.

---

## ACCURACY RULES — these matter more than the design

- **Scope every comparison to what the data supports.** "<Competitor> has more
  reviews than you" is checkable. "The most trusted roofer in town" is not.
  "Ranks above you for 7 of the 9 terms we measured" beats "dominates the
  market". Verify before writing the claim.
- **Every map pack and grid figure carries the location caveat.** Positions are
  real but measured from specific points on a specific date.
- **Gaps are stated as measured facts, never as fear.** "Not in the top 20 for
  'excavation near me' from your shop" — yes. "You're losing $40,000 a month" —
  no. Advertiser value is what advertisers pay for clicks, not the prospect's
  lost revenue.
- **No guarantees.** Never promise a ranking, a position, a number of leads or
  a timeline to page one. Say what we will do and what we will measure.
- **Competitors get public facts only.** Name them, report their numbers, never
  characterise their quality, honesty or service, and never imply a relationship
  with them. Do not disparage the prospect's current website builder or agency.
- **Report what you actually measured.** If a pull returns nothing, say so and
  investigate rather than filling the gap with a plausible number. Estimates the
  API itself models (Labs traffic) are labelled as estimates.
- **Claim only what Compass delivers.** The plan and "Why Compass" map to the
  services listed in config; proof points and terms come only from config.
- **Lead with what is working, then show the gaps.** A prospect who feels
  attacked stops reading.
- Flag in the internal brief anything you left out of the prospect documents,
  so whoever runs the meeting knows where the gaps are.
