// =============================================================================
// StageFlow — verify that every Supabase service the app depends on is alive.
// =============================================================================
//
//   npm run services:check
//   npm run services:check -- --with-auth
//   npm run services:check -- --smtp-test you@real-address.com
//
// Reads .env.local through `node --env-file`. Never prints key values.
//
// Default mode is READ ONLY: it probes the Auth API, PostgREST, the service-role
// key and the private storage bucket. --with-auth performs one real
// signup-equivalent (admin-created, confirmed) + sign-in + sign-out cycle and
// removes the temporary account afterwards. --smtp-test sends ONE real
// confirmation e-mail through Supabase Auth and then removes that account too.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').trim()

const argv = process.argv.slice(2)
const withAuth = argv.includes('--with-auth')
const smtpIndex = argv.indexOf('--smtp-test')
const smtpEmail = smtpIndex >= 0 ? argv[smtpIndex + 1] : null
const emailDomainIndex = argv.indexOf('--test-email-domain')
const testEmailDomain = emailDomainIndex >= 0 ? argv[emailDomainIndex + 1] : 'stageflow.local'

const results = []
const record = (name, ok, detail, { fatal = true } = {}) => {
  results.push({ name, ok, detail, fatal })
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name.padEnd(30)} ${detail}`)
}
const note = (name, detail) => console.log(`[INFO] ${name.padEnd(30)} ${detail}`)

const timeout = (ms = 12_000) => AbortSignal.timeout(ms)
const apiHeaders = (key) => ({ apikey: key, Authorization: `Bearer ${key}` })

async function probe(path, key) {
  const res = await fetch(`${url}${path}`, { headers: apiHeaders(key), signal: timeout() })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

function describeError(err) {
  const message = err instanceof Error ? err.message : String(err)
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'host unreachable (project paused/deleted, or no network)'
  }
  return message
}

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const configOk = Boolean(
  url && anonKey && serviceKey &&
  !/your-project|your-anon|your-service|example\.com/i.test(`${url}${anonKey}${serviceKey}`),
)
record(
  'Environment',
  configOk,
  configOk ? `backend=${new URL(url).host} · site=${siteUrl}` : 'fill in .env.local (see .env.example)',
)

if (!configOk) {
  console.log('\nStop: the environment is not usable.')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2. Auth API + settings (SMTP / confirmation behaviour)
// ---------------------------------------------------------------------------
let authSettings = null
try {
  const health = await probe('/auth/v1/health', anonKey)
  record('Auth API', health.status === 200, `HTTP ${health.status}`)
  const settings = await probe('/auth/v1/settings', anonKey)
  authSettings = settings.body
  record('Auth settings readable', settings.status === 200, `HTTP ${settings.status}`)
  if (settings.status === 200 && authSettings && typeof authSettings === 'object') {
    const confirm = authSettings.mailer_autoconfirm === false
    note('E-mail confirmation', confirm
      ? 'ON - signup requires the OTP / confirmation e-mail (built-in Supabase mailer)'
      : 'OFF - signup logs in immediately, no e-mail is sent')
    note('Signup enabled', authSettings.disable_signup === false ? 'yes' : 'NO (dashboard setting)')
  }
} catch (err) {
  record('Auth API', false, describeError(err))
}

// ---------------------------------------------------------------------------
// 3. Database schema (PostgREST)
// ---------------------------------------------------------------------------
try {
  const res = await probe('/rest/v1/profiles?select=id&limit=1', anonKey)
  const missing = res.status === 404 ||
    (typeof res.body === 'object' && res.body?.code === 'PGRST205')
  record('Database migrations', res.status === 200, missing
    ? 'tables missing - apply supabase/migrations/0001..0013'
    : `HTTP ${res.status} (public.profiles reachable)`)
} catch (err) {
  record('Database migrations', false, describeError(err))
}

// ---------------------------------------------------------------------------
// 4. Service-role key (needed for uploads + audit)
// ---------------------------------------------------------------------------
const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
try {
  const { error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  record('Service-role key', !error, error ? error.message : 'Admin API accepted')
} catch (err) {
  record('Service-role key', false, describeError(err))
}

// ---------------------------------------------------------------------------
// 5. Private storage bucket
// ---------------------------------------------------------------------------
try {
  const res = await probe('/storage/v1/bucket', serviceKey)
  const buckets = Array.isArray(res.body) ? res.body : []
  const bucket = buckets.find((b) => b.id === 'application-documents')
  record('Private documents bucket', Boolean(bucket) && bucket.public === false,
    !bucket ? 'missing - run migration 0004'
      : bucket.public === false ? 'present, public=false' : 'INSECURE: bucket is public')
} catch (err) {
  record('Private documents bucket', false, describeError(err))
}

// ---------------------------------------------------------------------------
// 6. Optional: real sign-in cycle (no e-mail sent)
// ---------------------------------------------------------------------------
if (withAuth) {
  const password = `Smoke-${randomBytes(12).toString('hex')}!1`
  const email = `smoke-${randomBytes(6).toString('hex')}@${testEmailDomain}`
  let createdId = null
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { first_name: 'Smoke', last_name: 'Test' },
    })
    if (error) throw error
    createdId = data.user.id
    record('Account provisioning', true, `${email} (confirmed, no mail sent)`)

    const anon = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password })
    if (signInError) throw signInError
    record('Sign in', Boolean(session.session?.access_token), 'session issued')

    const { data: profile, error: profileError } = await anon
      .from('profiles')
      .select('id')
      .eq('id', createdId)
      .maybeSingle()
    record('Trigger + RLS', !profileError && profile?.id === createdId,
      !profileError && profile?.id === createdId
        ? 'profile row created by handle_new_user and readable by its owner'
        : `profile missing (${profileError?.message ?? 'RLS blocked'})`)

    const { data: role } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', createdId)
      .maybeSingle()
    record('Default role', role?.role === 'stagiaire', role?.role ?? 'no role row')

    const { error: signOutError } = await anon.auth.signOut()
    record('Sign out', !signOutError, signOutError?.message ?? 'session cleared')
  } catch (err) {
    record('Auth round-trip', false, describeError(err))
    note('Hint', `if the address was rejected, retry with --test-email-domain <domain>`)
  } finally {
    if (createdId) {
      const { error } = await admin.auth.admin.deleteUser(createdId)
      record('Cleanup', !error, error ? error.message : 'temporary account removed')
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Optional: one real confirmation e-mail through Supabase SMTP
// ---------------------------------------------------------------------------
if (smtpEmail) {
  const password = `Smoke-${randomBytes(12).toString('hex')}!1`
  const anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  try {
    const { data, error } = await anon.auth.signUp({
      email: smtpEmail,
      password,
      options: { emailRedirectTo: `${siteUrl}/auth/callback` },
    })
    if (error) {
      record('SMTP confirmation e-mail', false, `${error.status ?? ''} ${error.message}`)
      if (/rate limit|email/i.test(error.message)) {
        note('Hint', 'Supabase built-in mailer is rate limited (~a few messages/hour). Retry later or configure custom SMTP.')
      }
    } else {
      const queued = Boolean(data.user && !data.session)
      record('SMTP confirmation e-mail', queued,
        queued ? `queued for ${smtpEmail} - check the inbox (and spam)` : 'signed in directly - e-mail confirmations are OFF')
      note('Redirect URL', `${siteUrl}/auth/callback must be in the Supabase redirect allow-list`)
    }
  } catch (err) {
    record('SMTP confirmation e-mail', false, describeError(err))
  } finally {
    try {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const match = list?.users?.find((u) => u.email?.toLowerCase() === smtpEmail.toLowerCase())
      if (match) {
        await admin.auth.admin.deleteUser(match.id)
        note('Cleanup', `test account ${smtpEmail} removed`)
      }
    } catch { /* non-fatal: never mask the real result */ }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const failures = results.filter((r) => !r.ok && r.fatal)
console.log(`\n${results.length - failures.length}/${results.length} checks passed.`)
if (failures.length > 0) {
  console.log('Failing: ' + failures.map((f) => f.name).join(', '))
  console.log('Fix the items above, then run this command again.')
  process.exit(1)
}
console.log('Backend is ready. Start the app with: npm run dev')
