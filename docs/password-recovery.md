# Password recovery (Sept 30 2026)

A teammate who forgot their password asks for a reset link on
`/login` › **Forgot password?**, opens the emailed link on any device, sets a
new password on `/update-password` and lands in Compass. Password sign-in and
the magic link are unchanged.

Rules and the whole flow: `src/lib/password-recovery.ts`. Code:
`src/app/login/forgot-password/`, `src/app/auth/confirm/route.ts`,
`src/app/update-password/`, `src/proxy.ts`.

## How it works

1. **Request.** `/login/forgot-password` calls
   `resetPasswordForEmail(email, { redirectTo: <this deployment>/auth/confirm })`.
   The page reads the same whether or not the address has an account; only a
   rate limit (429) is shown.
2. **Email.** The Reset Password template (below) links to
   `<redirectTo>?token_hash=…&type=recovery`.
3. **`/auth/confirm`** does **not** spend a recovery token. It checks its shape
   (hex, optionally `pkce_`-prefixed), stores it in an httpOnly cookie
   `compass_pw_reset` (path `/update-password`, one hour, `SameSite=Lax`,
   `Secure` on https) and redirects to `/update-password`. Opening the link, or
   a mail scanner fetching it, spends nothing.
4. **`/update-password`** shows the form only while that cookie holds a
   well-formed token; otherwise a signed-in visitor goes to `/` and anyone else
   to `/login`. The proxy lets signed-out visitors reach it, because reset
   links are often opened in a browser that is not signed in.
5. **Save** (server action): checks the new password (8–72 characters, both
   fields match) **before** spending anything; then deletes the cookie, spends
   the token with `verifyOtp({ type: "recovery", token_hash })`, and calls
   `updateUser({ password })`. Supabase Auth ends the account's other sessions
   when the password changes. Success → `/`, where the app layout sends a team
   member to the CRM and a portal contact to the portal.
   - Token expired, used or never issued → `/login?error=invalid_link`, which
     explains it and links to a new reset link.
   - Supabase refuses the password (`weak_password`, `same_password`, other)
     → the session the token opened is signed out and the user is sent to
     `/login/forgot-password?error=<code>` with our own message.

**The recovery state is the unspent one-time token**, checked by Supabase
Auth when it is spent. A signed-in session alone never opens the form or
saves a password; a forged cookie is just a token Supabase refuses; a token
cannot be spent twice, and a password change clears every outstanding token
for the account. (A session's `amr` claim cannot be used instead: Supabase
records a token-hash verification as `otp`, the same as a magic link.)

A link in the **default** template's form (Auth's own `/verify`, which lands
on `/auth/confirm?code=…` as a recovery session) is refused: `/auth/confirm`
signs that session out and shows `/login?error=reset_unavailable`. So resets
do not work until the template below is saved; nothing else is affected.

**Redirects.** `/auth/confirm` answers with root-relative `Location` headers
only. Its `?next=` (sign-in links only; a recovery link always goes to
`/update-password`) passes through `safeNextPath`: a same-origin path starting
with exactly one `/`, no backslash / whitespace / control character (raw or
percent-decoded), at most 2,048 characters, not an auth route (`/auth/…`,
`/login…`, `/update-password`), rebuilt from the parsed URL; anything else is
`/`.

## Supabase configuration (manual; nothing here changes it)

Supabase dashboard › project `compass-client-platform` › Authentication.

### URL Configuration

| Setting | Value |
| --- | --- |
| **Site URL** | `https://compass-crm-ten.vercel.app` (no trailing slash, no path) |
| **Redirect URLs** | `https://compass-crm-ten.vercel.app/**` |
| | `https://compass-crm-*-compassmarketin.vercel.app/**` (every Vercel preview of the `compass-crm` project) |
| | `http://localhost:3000/**` (optional, local `next dev`) |

- The preview pattern covers Vercel's branch and deployment URLs for the
  project in the `compassmarketin` team, e.g.
  `https://compass-crm-git-<branch>-compassmarketin.vercel.app`. In Supabase's
  glob a `*` does not match `.` or `/`, so the pattern cannot match another
  domain. Add any custom domain the app is later served on.
- A deployment missing from the list still works for resets: Supabase falls
  back to the Site URL, the link arrives at production's `/`, and the proxy
  forwards `?token_hash=…&type=recovery` to `/auth/confirm` — the reset
  completes on production instead of the preview. Magic links from an
  unlisted deployment likewise land on production.

### Email Templates › Reset Password

Subject: `Reset your Compass password`

Body — the exact content of `supabase/templates/recovery.html`:

```html
<h2>Reset your Compass password</h2>
<p>A password reset was requested for {{ .Email }} on the Compass Client Platform.</p>
<p><a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Choose a new password</a></p>
<p>The link works once, on any device, and expires in an hour. If you did not ask for this, ignore this email: your password has not changed.</p>
```

`{{ .RedirectTo }}` is the deployment the request came from
(`…/auth/confirm`), or the Site URL when that deployment is not on the list.
Leave the **Magic Link** template as it is: the magic link keeps using the
default `{{ .ConfirmationURL }}` flow.

### Also

- **Custom SMTP** (Auth › Emails › SMTP Settings; Resend,
  `send.compassmarketing.ai` is verified). The built-in mailer sends a couple
  of emails an hour for the whole project.
- **Email OTP expiration** (Auth › Providers › Email) is the link lifetime;
  the default one hour matches the cookie.
- **Minimum password length**: our form asks for 8. If the project's own
  minimum or character rules are stricter, Supabase refuses on save and the
  user is asked to request a new link, so keep them at or below 8 or raise
  `MIN_PASSWORD_LENGTH` to match.
- **Secure password change** / **Require current password** can stay off; if
  "require reauthentication" is turned on later, a fresh recovery session
  (under 24 hours old) is still exempt.

## Tests

- `npm test` — `tests/password-recovery.test.mjs`: the redirect rule against
  ~45 malicious values, token shape, password checks, messages, the `amr`
  reader.
- `npm run test:auth-ui` — `tests/auth-flows-ui.mjs`: a real Supabase Auth
  server (built from github.com/supabase/auth), the sandbox Postgres replay +
  PostgREST, a production build (`next build` + `next start`), an SMTP sink
  and Chromium, over three origins (production = Site URL, preview = on the
  Redirect URLs list, unlisted). Needs `GOTRUE_BIN`, `GOTRUE_MIGRATIONS` and
  (without Chrome) `CHROME_PATH`; see the file's header.
