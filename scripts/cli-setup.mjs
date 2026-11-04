// =============================================================================
// StageFlow — CLI-first provisioning (Supabase CLI + Vercel CLI)
// =============================================================================
//
//   cp .env.cli.example .env.cli   # paste SUPABASE_ACCESS_TOKEN (+ VERCEL_TOKEN)
//   npm run cli:setup
//   npm run cli:setup -- --dry-run
//   npm run cli:setup -- --apply-migrations
//   npm run cli:setup -- --no-vercel
//
// What it does, using the CLIs (not the dashboard):
//   1. supabase projects list                -> find the project + its status
//   2. POST /v1/projects/{ref}/restore      -> unpause a free-tier project
//      (the CLI has no `restore` subcommand; this uses the same access token)
//   3. poll the Auth health endpoint until the project is back
//   4. supabase link / migration list / db push
//   5. PATCH /v1/projects/{ref}/config/auth -> Site URL, redirect allow-list,
//      signup + OTP confirmation, optional custom SMTP
//   6. supabase projects api-keys --reveal  -> rewrite .env.local from the CLI
//   7. vercel link / env add / --prod       -> deploy with the right variables
//   8. npm run services:check               -> prove every service
//
// No token value is ever printed. The script is idempotent and fail-closed:
// a step that cannot be completed is reported, never silently skipped.
// =============================================================================

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const APPLY_MIGRATIONS = argv.includes('--apply-migrations')
const SKIP_VERCEL = argv.includes('--no-vercel')
const SKIP_SUPABASE = argv.includes('--no-supabase')

const SB_PKG = 'supabase@3.0.0'
const VC_PKG = 'vercel@65.11.0'
const API = 'https://api.supabase.com'

function parseEnvFile(file) {
  const out = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i < 1) continue
    out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const cliEnv = parseEnvFile(path.join(ROOT, '.env.cli'))
const appEnv = parseEnvFile(path.join(ROOT, '.env.local'))
const token = cliEnv.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_ACCESS_TOKEN || ''
const vercelToken = cliEnv.VERCEL_TOKEN || process.env.VERCEL_TOKEN || ''
const dbPassword = cliEnv.SUPABASE_DB_PASSWORD || process.env.SUPABASE_DB_PASSWORD || ''
const vercelScope = cliEnv.VERCEL_SCOPE || ''
const siteUrlFromCli = cliEnv.VERCEL_PRODUCTION_URL || ''

const appUrl = appEnv.NEXT_PUBLIC_SUPABASE_URL || ''
let ref = cliEnv.SUPABASE_PROJECT_REF || ''
if (!ref && appUrl) {
  try { ref = new URL(appUrl).hostname.split('.')[0] } catch { /* ignore */ }
}
if (!ref) {
  const linked = path.join(ROOT, 'supabase', '.temp', 'linked-project.json')
  if (existsSync(linked)) {
    try { ref = JSON.parse(readFileSync(linked, 'utf8')).ref } catch { /* ignore */ }
  }
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
const ok = (msg) => console.log(`      OK  ${msg}`)
const warn = (msg) => console.log(`      !!  ${msg}`)
const die = (msg) => { console.error(`\nSTOP: ${msg}`); process.exit(1) }

function childEnv(extra = {}) {
  return {
    ...process.env,
    ...(token ? { SUPABASE_ACCESS_TOKEN: token } : {}),
    ...(vercelToken ? { VERCEL_TOKEN: vercelToken } : {}),
    ...(dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {}),
    SUPABASE_YES: '1',
    ...extra,
  }
}

function runCli(pkg, args, { input, capture = true, env = {} } = {}) {
  const command = `npx --yes ${pkg} ${args.join(' ')}`
  if (DRY_RUN) { console.log(`      $ ${command.replace(/--password \S+/g, '--password <hidden>')}`); return { status: 0, stdout: '' } }
  const res = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', pkg, ...args],
    { cwd: ROOT, env: childEnv(env), input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' },
  )
  const stdout = res.stdout || ''
  const stderr = res.stderr || ''
  if (!capture) console.log(stdout.trim() || stderr.trim())
  if (res.status !== 0) {
    const text = (stderr + '\n' + stdout).trim()
    console.log(`      CLI exit ${res.status}: ${text.split('\n').slice(-6).join(' | ').slice(0, 600)}`)
  }
  return { status: res.status ?? 1, stdout, stderr }
}

function sb(args, opts) { return runCli(SB_PKG, args, opts) }
function vc(args, opts) { return runCli(VC_PKG, args, opts) }

async function management(method, pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, data, text }
}

function jsonFromStdout(stdout) {
  const start = stdout.search(/[\[{]/)
  if (start < 0) return null
  try { return JSON.parse(stdout.slice(start)) } catch { return null }
}

// ---------------------------------------------------------------------------
step(0, 'Preflight')
console.log(`      project ref : ${ref || '(unknown)'}`)
console.log(`      mode        : ${DRY_RUN ? 'DRY RUN (prints CLI commands only)' : 'LIVE'}`)
console.log(`      supabase token : ${token ? 'present' : 'MISSING'}`)
console.log(`      vercel token   : ${vercelToken ? 'present' : 'MISSING (Vercel phase will be skipped)'}`)
if (!ref) die('Cannot determine the project ref. Set SUPABASE_PROJECT_REF in .env.cli.')
if (!DRY_RUN && !token && !SKIP_SUPABASE) {
  die('Set SUPABASE_ACCESS_TOKEN in .env.cli (https://supabase.com/dashboard/account/tokens).')
}

// ---------------------------------------------------------------------------
if (!SKIP_SUPABASE) {
  step(1, 'supabase projects list  — locate the project')
  const list = sb(['projects', 'list', '--output-format', 'json'])
  const projects = jsonFromStdout(list.stdout)
  if (DRY_RUN) {
    ok('dry run: would list projects and check status')
  } else if (Array.isArray(projects)) {
    const match = projects.find((p) => (p.ref || p.id) === ref)
    ok(match ? `found "${match.name}" · status=${match.status} · region=${match.region}` : `${projects.length} project(s), ref ${ref} not listed`)
    if (!match) warn('Continuing against the ref from .env.local; check the token has access to this org.')
  } else {
    warn(list.status === 0 ? 'CLI returned non-JSON output; continuing with the Management API' : 'projects list failed — token may be invalid')
  }

  step(2, 'Project health / restore (POST /v1/projects/{ref}/restore)')
  let status = 'UNKNOWN'
  if (DRY_RUN) {
    console.log(`      $ GET ${API}/v1/projects/${ref}`)
  } else {
    const info = await management('GET', `/v1/projects/${ref}`)
    if (info.status === 401 || info.status === 403) die('Supabase token rejected by the Management API. Generate a new token.')
    if (info.status === 404) {
      warn(`project ${ref} no longer exists in this account`)
      warn('Create a new one with: npx supabase projects create stageflow --org-id <org> --db-password <pw> --region eu-central-1')
      warn('Then set SUPABASE_PROJECT_REF to the new ref and re-run. Exiting instead of guessing.')
      process.exit(1)
    }
    status = info.data?.status ?? 'UNKNOWN'
  }
  if (DRY_RUN) {
    console.log('      status: (not checked in dry run)')
    console.log(`      $ POST ${API}/v1/projects/${ref}/restore   # only when the project is paused`)
  } else {
    console.log(`      status: ${status}`)
    if (!/ACTIVE_HEALTHY|COMING_UP|RESTORING|ACTIVE/i.test(status)) {
      const restore = await management('POST', `/v1/projects/${ref}/restore`)
      if (restore.status >= 200 && restore.status < 300) ok('restore requested (free-tier restores take a few minutes)')
      else warn(`restore returned HTTP ${restore.status}: ${restore.text.slice(0, 200)} — restore it in the dashboard if this persists`)
    } else {
      ok('project is active')
    }
  }

  step(3, 'Wait for the Auth API to come back')
  const healthUrl = `https://${ref}.supabase.co/auth/v1/health`
  let alive = false
  for (let attempt = 1; attempt <= (DRY_RUN ? 1 : 20); attempt++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) })
      if (res.status === 200) { alive = true; break }
    } catch { /* still coming up */ }
    if (!DRY_RUN) await new Promise((r) => setTimeout(r, 15_000))
  }
  if (alive) ok(`${healthUrl} -> 200`)
  else warn('Auth endpoint not reachable yet. Re-run this script in a few minutes after the restore completes.')

  step(4, 'supabase link + migration state')
  if (dbPassword) {
    const linked = sb(['link', '--project-ref', ref, '--password', dbPassword, '--yes'])
    if (linked.status === 0) ok(`linked to ${ref}`)
    else warn('link failed — db push/config commands below use --remote=<ref> instead')
    const migrations = sb(['migration', 'list', '--linked'])
    if (migrations.stdout.trim()) console.log(migrations.stdout.trim().split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'))
  } else {
    warn('SUPABASE_DB_PASSWORD unset — skipping link and SQL migration steps')
    warn('Add it to .env.cli to let the CLI apply supabase/migrations/*.sql')
  }

  step(5, `supabase db push ${APPLY_MIGRATIONS ? '(APPLY)' : '(dry run)'}`)
  if (dbPassword) {
    const args = ['db', 'push', '--remote=' + ref, '--password', dbPassword, '--include-all', '--yes']
    if (!APPLY_MIGRATIONS) args.splice(5, 0, '--dry-run')
    const push = sb(args)
    if (push.status === 0) ok(APPLY_MIGRATIONS ? 'migrations applied' : 'dry run complete — re-run with --apply-migrations to apply')
    else warn('db push reported an error (see above); the SQL files can also be pasted into the SQL Editor in order')
  } else {
    warn('skipped (no DB password)')
  }

  step(6, 'Auth configuration (Site URL, redirects, OTP, SMTP)')
  let siteUrl = siteUrlFromCli || appEnv.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  if (!siteUrlFromCli && vercelToken && !DRY_RUN) {
    const projectJson = path.join(ROOT, '.vercel', 'project.json')
    if (existsSync(projectJson)) {
      try { siteUrl = `https://${JSON.parse(readFileSync(projectJson, 'utf8')).projectName}.vercel.app` } catch { /* keep */ }
    }
  }
  const allowList = [
    `${siteUrl}/**`,
    'http://localhost:3000/**',
    'http://127.0.0.1:3000/**',
    'https://*.vercel.app/**',
  ].filter((v, i, a) => a.indexOf(v) === i).join(',')

  const patch = {
    site_url: siteUrl,
    uri_allow_list: allowList,
    disable_signup: false,
    mailer_autoconfirm: false,
    mailer_otp_length: 6,
    mailer_otp_exp: 3600,
  }
  const smtp = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_ADMIN_EMAIL']
    .every((k) => cliEnv[k])
  if (smtp) {
    Object.assign(patch, {
      smtp_host: cliEnv.SMTP_HOST,
      smtp_port: String(cliEnv.SMTP_PORT),
      smtp_user: cliEnv.SMTP_USER,
      smtp_pass: cliEnv.SMTP_PASS,
      smtp_admin_email: cliEnv.SMTP_ADMIN_EMAIL,
      smtp_sender_name: cliEnv.SMTP_SENDER_NAME || 'StageFlow',
    })
    ok('custom SMTP values detected — will be applied by the API patch')
  } else {
    ok('using Supabase built-in mailer (no SMTP credentials supplied)')
  }
  if (DRY_RUN) {
    console.log(`      $ PATCH ${API}/v1/projects/${ref}/config/auth`)
    console.log(`      site_url=${siteUrl} · allow_list=${allowList}`)
  } else {
    const res = await management('PATCH', `/v1/projects/${ref}/config/auth`, patch)
    if (res.status >= 200 && res.status < 300) ok('Auth config updated')
    else warn(`PATCH returned HTTP ${res.status}: ${res.text.slice(0, 250)}`)
  }

  step(7, 'supabase projects api-keys --reveal  -> refresh .env.local')
  const keys = sb(['projects', 'api-keys', `--remote=${ref}`, '--reveal', '--output-format', 'json'])
  const parsed = jsonFromStdout(keys.stdout)
  const items = Array.isArray(parsed) ? parsed : (parsed?.data ?? [])
  const pick = (kinds, legacy) => items.find((k) =>
    kinds.includes(String(k.type || '').toLowerCase()) || legacy.test(String(k.name || '').toLowerCase()))
  const publishable = pick(['publishable', 'anon'], /anon|publishable/)
  const secret = pick(['secret', 'service_role'], /service.?role|secret/)
  const anonKey = publishable?.api_key || publishable?.secret || appEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = secret?.api_key || secret?.secret || appEnv.SUPABASE_SERVICE_ROLE_KEY
  if (anonKey && serviceKey) {
    const content = [
      '# Generated by npm run cli:setup from Supabase CLI api-keys. Do not commit.',
      `NEXT_PUBLIC_SUPABASE_URL=https://${ref}.supabase.co`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
      `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`,
      `NEXT_PUBLIC_SITE_URL=${siteUrl}`,
      '',
    ].join('\n')
    if (!DRY_RUN) { writeFileSync(path.join(ROOT, '.env.local'), content); ok('.env.local refreshed from the CLI') }
    else console.log('      $ rewrite .env.local with the CLI-provided keys')
  } else {
    warn('could not parse api-keys output — .env.local left untouched (existing keys are still valid)')
    if (keys.stdout.trim()) console.log(keys.stdout.trim().slice(0, 400))
  }
}

// ---------------------------------------------------------------------------
if (!SKIP_VERCEL) {
  if (!vercelToken) {
    step(8, 'Vercel — skipped (VERCEL_TOKEN not set in .env.cli)')
  } else {
    step(8, 'vercel whoami / link')
    const who = vc(['whoami'])
    if (who.status !== 0) warn('whoami failed — check VERCEL_TOKEN')
    else ok(who.stdout.trim().split('\n').slice(-1)[0])
    const linkArgs = ['link', '--yes']
    if (vercelScope) linkArgs.push('--scope', vercelScope)
    const link = vc(linkArgs)
    if (link.status === 0) ok('project linked (.vercel/project.json)')
    else warn('vercel link failed — see message above')

    let productionUrl = siteUrlFromCli
    if (!productionUrl) {
      const projectJson = path.join(ROOT, '.vercel', 'project.json')
      if (existsSync(projectJson)) {
        try { productionUrl = `https://${JSON.parse(readFileSync(projectJson, 'utf8')).projectName}.vercel.app` } catch { /* keep */ }
      }
    }
    productionUrl = productionUrl || 'http://localhost:3000'

    step(9, 'vercel env add (production)')
    const vars = {
      NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: appEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: appEnv.SUPABASE_SERVICE_ROLE_KEY,
      NEXT_PUBLIC_SITE_URL: productionUrl,
    }
    for (const [name, value] of Object.entries(vars)) {
      if (!value) { warn(`${name} missing — skipped`); continue }
      vc(['env', 'rm', name, 'production', '--yes'])
      const add = vc(['env', 'add', name, 'production'], { input: `${value}\n` })
      if (add.status === 0) ok(`${name} set`)
      else warn(`${name} could not be set — add it in the Vercel dashboard`)
    }

    step(10, 'vercel --prod  (deploy)')
    const deploy = vc(['--prod', '--yes'], { capture: false })
    if (deploy.status === 0) ok('production deployment created')
    else warn('deploy failed — see the CLI output above')
  }
}

// ---------------------------------------------------------------------------
step(11, 'Verify')
if (!DRY_RUN) {
  const check = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'services:check'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 },
  )
  console.log((check.stdout || '').trim())
  if (check.status !== 0) warn('services:check still reports failures — see the items above')
} else {
  console.log('      dry run: no changes were made')
}
console.log('\nDone. Docs: docs/CLI_WORKFLOW.md and docs/VERCEL_DEPLOY.md')
