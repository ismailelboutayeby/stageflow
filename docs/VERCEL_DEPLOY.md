# Deploy StageFlow on Vercel + Supabase

StageFlow is a **Node.js / Next.js 15** app (Server Components, Server Actions,
cookies). It cannot be deployed as a static site. Vercel is the intended host;
Supabase provides Postgres, Auth, Storage and outbound e-mail.

> **Read this first — the #1 cause of "everything stopped working".**
> Supabase **free-tier projects are paused after 7 days without activity**. A
> paused project loses its `<ref>.supabase.co` DNS record, so the app returns
> `AuthRetryableFetchError: fetch failed` on every login/signup and
> `/etat-installation` reports the provider as unreachable. Unpause the project
> in the Supabase dashboard before debugging the code.

---

## 0. Current local configuration

`.env.local` is already wired to the hosted Supabase project
`khrdcrpdiqmlcecbybfo` (URL, publishable key and service-role key are real,
taken from `.env.local.cloud-backup`). It runs the app on
`http://localhost:3000`.

The earlier Docker-based local-stack config is preserved in
`.env.local.localstack-backup`. To go back to it:

```bash
cp .env.local.localstack-backup .env.local
npx supabase start          # requires Docker Desktop
```

To verify every service at any time:

```bash
npm run services:check                              # read-only probes
npm run services:check -- --with-auth               # + real sign-in round trip
npm run services:check -- --smtp-test you@mail.com  # + one real confirmation e-mail
```

---

## 1. Restore / prepare the Supabase project

1. Open <https://supabase.com/dashboard> → your project → **Restore / Unpause**.
   Wait until `https://<ref>.supabase.co/auth/v1/health` returns `200`.
2. **Settings → API**: copy the Project URL, the publishable (`anon`) key and
   the secret (`service_role`) key.
3. Apply the database schema. Either paste the files from
   `supabase/migrations/` into the SQL Editor **in numeric order**
   (`0001` → `0007`, `0012`, `0013`; skip `9999_dev_seed.sql`, it is dev-only),
   or, with the CLI linked:

   ```bash
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase db push
   ```

   > The existing project already has `0001`–`0007` plus the Phase 2/3
   > hardening patches applied. After a restore, check first:
   > `select tablename from pg_tables where schemaname='public';`
   > If `support_tickets`, `organizations` and `internship_offers` are absent,
   > run **only** `0012` and `0013` (they create the newer support / offers
   > screens' tables). `0012`/`0013` use plain `create policy`, so re-running
   > them on an already-migrated database would fail — apply once.

4. Confirm the private bucket exists and is **not** public:

   ```sql
   select id, public, file_size_limit from storage.buckets
   where id = 'application-documents';
   ```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full post-migration verification
queries and the RLS test suite.

---

## 2. Configure Supabase Auth (this is the SMTP step)

Dashboard → **Authentication**:

| Setting | Value |
| --- | --- |
| **URL Configuration → Site URL** | `https://<your-app>.vercel.app` |
| **Redirect URLs** | `https://<your-app>.vercel.app/**`, `http://localhost:3000/**` |
| **Email → Confirm email** | ON (the app verifies a 6-digit signup OTP) |
| **Email → Minimum password length** | 10 (the app's Zod schema requires 10 + upper/lower/digit) |
| **SMTP Settings** | Supabase built-in mailer (default), or your own provider |

With the **built-in mailer** nothing has to be configured: Supabase sends the
signup OTP and password-reset mail itself. Two limits to accept:

- a few messages per hour on the free tier (`429 email rate limit exceeded`);
- the sender is Supabase's own address, so messages can land in spam.

For production volume, switch to a custom SMTP provider (Resend, Brevo, Gmail
app password...) in **Authentication → SMTP Settings**. No SMTP password ever
lives in this repository — the app delegates all mail to Supabase Auth.

If you add a Vercel preview domain later, add its wildcard to the redirect
allow-list too, e.g. `https://stageflow-*.vercel.app/**`.

---

## 3. Create the first administrator

There is deliberately no in-app way to become an admin. Run this once in the
**SQL Editor** after the user has signed up at least once:

```sql
select promote_to_admin('admin@your-domain.com');
```

The target must sign out and back in for the role to be picked up.

---

## 4. Deploy to Vercel

> **Prefer the CLIs?** [CLI_WORKFLOW.md](CLI_WORKFLOW.md) automates all of this
> with `supabase` (project status, restore, migrations, API keys, auth config)
> and `vercel` (link, env vars, `--prod`). Put the two tokens in `.env.cli` and
> run `npm run cli:setup`. The manual steps below are the equivalent.

### Option A — Git import (recommended)

1. Push this repository to GitHub (the existing remote is
   `https://github.com/MarwaneLachhab/stageflow.git`; `main` is in sync).
2. Vercel → **Add New → Project** → import the repo.
   Framework is auto-detected as Next.js; `vercel.json` pins `npm ci` +
   `npm run build`.
3. Add the environment variables to **Production** (and Preview/Development
   as needed):

   | Variable | Value | Exposed to browser |
   | --- | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | yes (safe) |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable / anon key | yes (safe, RLS-protected) |
   | `SUPABASE_SERVICE_ROLE_KEY` | secret key | **never** — no `NEXT_PUBLIC_` prefix |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-app>.vercel.app` (no trailing slash) | yes |

   > The service-role key is only used server-side for audited document
   > uploads and audit rows. Prefixing it with `NEXT_PUBLIC_` would publish it
   > to every visitor and bypass every RLS policy.

4. Deploy.

### Option B — Vercel CLI

```bash
npm i -g vercel
vercel login
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add NEXT_PUBLIC_SITE_URL
vercel --prod
```

A Vercel account/token is required; it is not stored in this repository.

### Preview deployments

`NEXT_PUBLIC_SITE_URL` is a single value, so confirmation e-mails from a
Preview deployment redirect to the URL configured above unless you set a
separate value for the Preview environment and add that origin to Supabase's
redirect allow-list. This is expected, not a bug.

---

## 5. Post-deploy checklist

- `/` loads, `/inscription` creates an account and the OTP e-mail arrives.
- Confirm the OTP, then `/connexion` signs in and lands on
  `/stagiaire/tableau-de-bord`.
- `/etat-installation` reports every item as OK.
- `npm run services:check` (run locally against the same project) → all checks pass.
- `/admin/tableau-de-bord` works for the promoted admin and redirects a
  stagiaire away.
- Password reset delivers an e-mail and the callback returns to the site.

---

## 6. Operational notes

- **Backups are not automatic** on the free tier — enable them in the dashboard.
- **Rate limiting is in-memory per process** (see `lib/auth/rate-limit.ts`); on
  serverless it is per-instance, so it is a speed bump, not a hard quota.
- **Do not commit `.env.local`** (already in `.gitignore`).
- Keep the project active. If it gets paused again, restore it in the
  dashboard; no code change is needed.
