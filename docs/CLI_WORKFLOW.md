# CLI-first workflow (Supabase CLI + Vercel CLI)

Everything is driven by the two official CLIs, pinned so the behaviour is
reproducible:

| Tool | Version | Invoked as |
| --- | --- | --- |
| Supabase CLI | 3.0.0 | `npx --yes supabase@3.0.0 …` |
| Vercel CLI | 65.11.0 | `npx --yes vercel@65.11.0 …` |

They are **not** project dependencies, so `npm ci` on Vercel stays fast.

---

## 1. One-time: tokens

Both CLIs need a token in this non-interactive shell. `supabase login
--no-browser` and `vercel login` are interactive/browser flows and will hang
here; use tokens instead.

```bash
cp .env.cli.example .env.cli
```

| Variable | Where to get it | Needed for |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | <https://supabase.com/dashboard/account/tokens> → Generate new token | everything Supabase |
| `VERCEL_TOKEN` | <https://vercel.com/account/settings/tokens> → Create Token | deploy |
| `SUPABASE_DB_PASSWORD` | the password chosen when the project was created | `link` / `db push` |
| `VERCEL_PRODUCTION_URL` | optional; defaults to `https://<project>.vercel.app` | Site URL + redirects |
| `VERCEL_SCOPE` | team slug, only for team projects | `vercel link` |

`.env.cli` is gitignored — no token is committed or printed. The CLI also
accepts the standard `SUPABASE_ACCESS_TOKEN` / `VERCEL_TOKEN` environment
variables if you prefer exporting them.

---

## 2. Commands

```bash
npm run cli:dry-run     # print every CLI/API call, change nothing
npm run cli:setup       # full pipeline
npm run cli:migrate     # only Supabase: restore + migrations + auth config
npm run cli:deploy      # only Vercel: env vars + production deploy
npm run cli:setup -- --apply-migrations   # actually execute db push
npm run cli:setup -- --no-vercel         # skip the deploy phase
```

### What `cli:setup` runs

1. `supabase projects list --output-format json` — find the project and read its status.
2. `GET /v1/projects/{ref}` then, if paused, `POST /v1/projects/{ref}/restore`.
   The CLI has no `restore` subcommand, so this one call uses the Management
   API with the **same** access token. A free-tier restore takes a few minutes.
3. Poll `https://<ref>.supabase.co/auth/v1/health` until it returns 200.
4. `supabase link --project-ref <ref> --password …` and `supabase migration list --linked`.
5. `supabase db push --dry-run` (add `--apply-migrations` to execute).
6. `PATCH /v1/projects/{ref}/config/auth` — sets `site_url`, `uri_allow_list`,
   `disable_signup=false`, `mailer_autoconfirm=false`, OTP length/expiry, and
   custom SMTP only if `.env.cli` supplies credentials. Left unset → Supabase's
   built-in mailer (the current choice).
7. `supabase projects api-keys --remote=<ref> --reveal` → rewrites `.env.local`
   with the CLI-provided URL and keys.
8. `vercel whoami` → `vercel link` → `vercel env add … production` for the four
   app variables → `vercel --prod`.
9. `npm run services:check` to prove the result.

> **Why step 6 uses the API instead of `supabase config push`:**
> `supabase/config.toml` currently sets `[auth] site_url =
> "http://127.0.0.1:3000"` because it is used by the Docker-based local stack.
> Pushing that file to a hosted project would point every confirmation link at
> a loopback address. The script sends a precise patch instead. If you do want
> the CLI-native path, change `site_url` and `additional_redirect_urls` in
> `config.toml` to your deployed origin first, then run
> `npx supabase config push --remote=<ref> --yes`.

---

## 3. Manual equivalents

```bash
# --- Supabase -------------------------------------------------------------
export SUPABASE_ACCESS_TOKEN=sbp_...
npx --yes supabase@3.0.0 projects list --output-format json
npx --yes supabase@3.0.0 link --project-ref <ref> --password '<db-password>' --yes
npx --yes supabase@3.0.0 migration list --linked
npx --yes supabase@3.0.0 db push --linked --yes
npx --yes supabase@3.0.0 config diff --remote=<ref>
npx --yes supabase@3.0.0 projects api-keys --remote=<ref> --reveal

# restore a paused project (no CLI subcommand exists)
curl -X POST "https://api.supabase.com/v1/projects/<ref>/restore" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"

# --- Vercel ---------------------------------------------------------------
export VERCEL_TOKEN=...
npx --yes vercel@65.11.0 whoami
npx --yes vercel@65.11.0 link --yes
printf '%s' "$VALUE" | npx --yes vercel@65.11.0 env add NEXT_PUBLIC_SITE_URL production
npx --yes vercel@65.11.0 --prod --yes
```

---

## 4. Deploy without a Vercel account (temporary)

The CLI supports anonymous deployments:

```bash
npx --yes vercel@65.11.0 deploy --temporary --yes \
  --env NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
  --env NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-key>
```

`--env` injects runtime variables for that deployment. Only **publishable**
values belong here — never put `SUPABASE_SERVICE_ROLE_KEY` into an anonymous
deployment. The result is a real Vercel URL that can be claimed later with
`vercel claim`, but it is not attached to your account and it has no
service-role key (document uploads/audit degrade gracefully).

**Observed limitation — do not rely on this path.** Anonymous deployments
build locally. The build succeeds here (all 33 routes and serverless
functions are generated in `.vercel/output`), but the upload never completes:
`Anonymous deployments must declare a size for every file` (Vercel CLI
65.11.0 native), and `--archive` instead errors with `must upload prebuilt
output, not a source archive`. Next.js output tracing also pulls
`.env.local*` into the bundles, which conflicts with `.vercelignore` unless
those files are temporarily moved out. Five combinations were tried (with and
without `--archive`, env files moved, `.next/trace` cleared,
`env -u NODE_OPTIONS`) — all failed at upload.

**Use `npm run cli:setup` with a real `VERCEL_TOKEN` for a working
production deployment.** Anonymous mode is not a substitute.

---

## 5. SMTP via the CLI

Custom SMTP is optional. Fill `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` in `.env.cli` and the
script includes them in the auth-config patch. With all of them blank the
project keeps Supabase's built-in mailer (a few messages per hour, sender is
Supabase's address). No SMTP password is ever written to the repository.

After any change, verify end to end:

```bash
npm run services:check
npm run services:check -- --with-auth
npm run services:check -- --smtp-test you@real-address.com
```
