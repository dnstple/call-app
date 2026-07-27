# Deployment runbook — controlled pilot (frontend on Vercel)

Scope: how to deploy the Vite/React frontend to a production domain for the
**controlled pilot**, smoke-test it, and roll back. The database, Edge Functions
and secrets live in Supabase and are covered by `LAUNCH_RUNBOOK.md`; this runbook
is the frontend + configuration foundation only.

The app is Supabase-mode against **Stripe test mode**. Do **not** enable live
payments or a production email provider for the pilot.

---

## 0. Prerequisites (one-time)

- A Vercel project connected to this repository.
- The hosted pilot Supabase project already provisioned and migrated
  (see `LAUNCH_RUNBOOK.md`).
- A production domain (e.g. `app.apricoti.example`) ready to attach to Vercel.

## 1. Environment variables (Vercel → Project → Settings → Environment Variables)

Set these for the **Production** environment. Only `VITE_*` values are safe in
the browser; never add a secret here.

| Variable | Value | Notes |
|---|---|---|
| `VITE_DATA_SOURCE` | `supabase` | Switches the app off mock mode. |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` | Pilot project URL. |
| `VITE_SUPABASE_ANON_KEY` | anon public JWT (`eyJ…`) | Safe for the browser; **not** the service_role key. |
| `VITE_APP_URL` | `https://<your-domain>` | Must be https and not localhost; used for auth email redirects. |

The build **fails fast** (`src/config/validateEnv.ts`) if any of these are
missing/malformed in a production build, or if any `VITE_`-prefixed secret is
present — so a broken config never ships silently.

## 2. Supabase dashboard configuration (do this before the first real sign-in)

These are **dashboard** settings, not code:

1. **Auth → URL Configuration**
   - Site URL: `https://<your-domain>`
   - Additional Redirect URLs: add
     `https://<your-domain>/#/auth/callback` and
     `https://<your-domain>/#/reset-password`
     (the app uses HashRouter — the `/#/…` form matters).
2. **Auth → Email Templates** — confirm the confirmation + reset templates use
   the default `{{ .ConfirmationURL }}` and are branded acceptably for the pilot.
3. **Edge Function secret `APP_ORIGINS`** — set to the exact production origin,
   e.g. `APP_ORIGINS=https://<your-domain>` (comma-separate if more than one).
   `stripe-payments` fails closed without it in production.

## 3. Build & deploy

Vercel builds from `vercel.json` automatically:
- `buildCommand`: `npm run build` (`tsc -b && vite build`)
- `outputDirectory`: `dist`
- SPA rewrite → `/index.html`; hashed assets cached `immutable`; `index.html`
  served `no-cache` so a new deploy is picked up immediately.

Deploy by pushing the pilot branch (or "Promote to Production" from a preview).
Prefer promoting a **preview deployment you have already smoke-tested**.

Before promoting, run the secret-in-bundle scan locally (also suitable for CI):

```
npm run build:verify   # runs the production build, then scan-bundle-secrets.mjs
```

It exits non-zero if any secret was compiled into `dist/`. The usual cause is a
secret mistakenly given a `VITE_` prefix in `.env` — rename it without `VITE_`
and move it to a Supabase Function secret / Vault.

## 4. Smoke test (must pass before announcing)

On the production URL, in a fresh/incognito window:

1. **Loads clean** — the homepage renders; no "This deployment is misconfigured"
   screen; browser console has no env warning and no 404 for `/assets/*`.
2. **Deep-link hard refresh** — open `https://<your-domain>/#/login`, hard-refresh
   (Cmd/Ctrl-Shift-R); it still loads (no 404).
3. **Auth round-trip** — request a password reset / sign up; the email link
   points at `https://<your-domain>/#/…` (not localhost) and lands back in-app.
4. **One guarded RPC** — sign in as a seeded pilot account and load a page that
   reads from Supabase (e.g. Conversations); data loads, no CORS error.
5. **Calls** — only once LiveKit is configured (Block 2): open a booking's call
   lobby and confirm camera/mic permission prompts work.
6. **Controls safe** — no live Stripe, ceilings 0, no production email (unchanged
   from `LAUNCH_RUNBOOK.md`).

If any step fails, **do not announce** — roll back (§5) and fix.

## 5. Rollback

Vercel keeps every deployment immutable.

- **Fast path:** Vercel → Project → **Deployments** → pick the last known-good
  production deployment → **⋯ → Promote to Production** (or "Rollback"). This
  is instant and requires no rebuild.
- **Code path:** if the bad state is in git, revert the offending commit on the
  pilot branch and redeploy.
- **DNS:** the custom domain re-points to the promoted deployment automatically;
  no DNS change is needed for a rollback.
- Because `index.html` is `no-cache`, users pick up the rollback on their next
  navigation without a hard refresh.

Rollback does **not** touch the database or Edge Functions. If a bad frontend
also depended on a migration/function change, follow the database rollback
guidance in `INCIDENT_RUNBOOK.md` separately — never edit an applied migration.

## 6. Post-deploy checklist

- [ ] Env vars set (Production scope), build did not fail-fast.
- [ ] Auth Site URL + redirect allow-list + `APP_ORIGINS` set to the real domain.
- [ ] Smoke test §4 all green.
- [ ] `noindex` confirmed (view-source shows `<meta name="robots" content="noindex, nofollow">`).
- [ ] Rollback path tested once (promote a previous deployment, then re-promote).
