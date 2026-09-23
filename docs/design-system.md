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
| `--background` | `#f3f6fa` + two faint blue glows | the page ground |
| `--card` | `#ffffff` | every surface |
| `--foreground` | navy-900 `#0b162a` | text |
| `--muted-foreground` | `#56657d` | secondary text (≥ 5.4:1 on the ground) |
| `--primary` | navy-700 `#16294e` | buttons, active chips, checked boxes |
| `--accent` | `#e9eff9` | hover tint, avatar fill |
| `--border` / `--input` | `#e1e7ef` / `#d3dbe6` | hairlines, field borders |
| `--ring` | orange-500 `#e85d04` | focus ring |
| orange-500 → 400 | gradient | progress bars, the page-title mark |

Orange is never body text or a button fill: white on `#e85d04` and
`#e85d04` on white are about 3.4:1, which fails WCAG AA for normal text.
Status colors (green / blue / amber / red badges in `src/lib/labels.ts`) are
unchanged.

## Type

Inter for text, Space Grotesk for headings (`font-heading`), unchanged.
`page-title` is 24 px on phones and 30 px from `sm`, with the orange `kicker` mark.
`eyebrow` is the 11 px uppercase label above a figure.

## Surfaces and spacing

- `Card`: `rounded-2xl`, white, `ring-1 ring-border`, `shadow-card`,
  20 px padding (16 px for `size="sm"`).
- `surface` utility: the same look for containers that aren't a `Card`
  (task list, `<details>` panels).
- Shadows: `shadow-card`, `shadow-card-hover` (clickable cards lift 2 px),
  `shadow-float` (the header).
- Page rhythm: `space-y-8` between sections, `gap-4` in grids, 16 px side
  gutter on phones.

## Controls

- Buttons: default 36 px (`sm` 32, `lg` 40); primary navy with a soft
  shadow, outline white.
- Inputs, selects and textareas are white and 36 px tall.
- Navigation: a `navTrack` rail with `navItem` pills; the active pill is
  white and raised and carries `aria-current="page"`. It scrolls sideways
  on phones. Used by the header, the client tabs and the Tasks views.
- Filter chips: `chip(active)`, navy when on.

## Status

Finished in this slice: tokens and primitives (which reach every page), the
app header, the Dashboard, the client header and tabs, and the Tasks page
(views, chips, task list). Still pending: a page-by-page pass over the other
screens (see the PR).
