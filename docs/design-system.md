# Team CRM design system (Sept 23 2026)

The visual refresh of the team CRM: a cool, light ground with white
surfaces, navy structure and an orange accent. It replaces the cream "paper"
look. Tokens live in `src/app/globals.css`, primitives in
`src/components/ui/`, navigation states in `src/lib/nav-styles.ts`.
Screenshots (fictional data): `docs/screenshots/design-refresh/`, made by
`npm run design:preview` (no Supabase project needed).

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--background` | `#dfe8f5` light blue, two glows at the top | the page ground, deep enough that white cards stand off it |
| `--card` | `#ffffff` | every surface |
| `--foreground` | navy-900 `#0b162a` (the logo navy) | text, headings |
| `--muted-foreground` | `#4a5a74` | secondary text |
| `--primary` | royal-700 `#1a3f84` | active chips, checked boxes; buttons use a royal-500 → royal-700 gradient |
| royal-600 `#1f4b9c` | | labels (`eyebrow`), links, progress bars (royal-700 → 500) |
| royal-50 / royal-100 | `#edf3fd` / `#dce8fa` | the nav rail, icon chips, table headers, hover rows |
| `--border` / `--input` | `#d3deee` / `#c8d5e8` | hairlines, field borders |
| `--ring` | orange-500 `#e85d04` | focus ring |
| orange | | the logo needle, the page-title mark, "needs attention" icons |

Orange is never body text or a button fill: white on `#e85d04` and
`#e85d04` on white are about 3.4:1, which fails WCAG AA for normal text.
Status colors (green / blue / amber / red badges in `src/lib/labels.ts`) are
unchanged.

## Type

One typeface: Inter for text and headings (`font-heading` now maps to
Inter; Space Grotesk was dropped as hard to read). `page-title` is bold,
24 px on phones and 28 px from `sm`. `eyebrow` is the 12 px uppercase royal
label above a heading or a figure.

## Surfaces and spacing

- `Card`: `rounded-2xl`, white, `ring-1 ring-border`, `shadow-card`,
  20 px padding (16 px for `size="sm"`).
- `surface` utility: the same look for containers that aren't a `Card`
  (task list, `<details>` panels). `surface-tint` is the light-blue wash for
  a featured panel (the dashboard summary).
- Shadows: `shadow-card`, `shadow-card-hover` (clickable cards lift 2 px),
  `shadow-float` (the header).
- Page rhythm: `space-y-8` between sections, `gap-4` in grids, 16 px side
  gutter on phones.

## Controls

- Buttons: default 36 px (`sm` 32, `lg` 40); primary royal-to-navy with a soft
  shadow, outline white.
- Inputs, selects and textareas are white and 36 px tall.
- Navigation: a `navTrack` rail with `navItem` pills; the active pill is
  white and raised and carries `aria-current="page"`. It scrolls sideways
  on phones. Used by the header, the client tabs and the Tasks views.
- Filter chips: `chip(active)`, royal blue when on.

## Status

Finished in this slice: tokens and primitives (which reach every page), the
app header, the Dashboard, the client header and tabs, and the Tasks page
(views, chips, task list). Still pending: a page-by-page pass over the other
screens (see the PR).
