import { readFileSync } from 'fs'

const env = readFileSync('.env.local', 'utf8')
function val(key) {
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

const SERVICE = val('SUPABASE_SERVICE_ROLE_KEY')
const ANON = val('NEXT_PUBLIC_SUPABASE_ANON_KEY')
const SB = val('NEXT_PUBLIC_SUPABASE_URL')

if (!SERVICE || !SB) { console.error('Missing env'); process.exit(1) }

// Known user IDs from the user list
const targets = [
  { email: 'admin@stageflow.ma', id: '2e8a294a-564c-4c03-9502-2dada2050633', password: 'Admin@StageFlow2026', firstName: 'Admin', lastName: 'StageFlow' },
  { email: 'manager@stageflow.ma', id: '5839a4e9-6743-48f1-adaf-9bf357498c62', password: 'Manager@StageFlow2026', firstName: 'Manager', lastName: 'StageFlow' },
]

console.log('=== SETTING PASSWORDS + PROMOTING ===\n')

for (const t of targets) {
  // 1. Update password via Admin API
  const pwRes = await fetch(`${SB}/auth/v1/admin/users/${t.id}`, {
    method: 'PUT',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      password: t.password,
      email_confirm: true,
    }),
  })
  const pwJ = await pwRes.json()
  console.log(`${t.email}: password set=${pwRes.ok ? 'OK' : 'FAIL ' + (pwJ.message || '')}`)

  // 2. Update user metadata
  await fetch(`${SB}/auth/v1/admin/users/${t.id}`, {
    method: 'PUT',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_metadata: { first_name: t.firstName, last_name: t.lastName },
    }),
  })

  // 3. Ensure profile exists
  const profRes = await fetch(`${SB}/rest/v1/profiles?select=id,first_name,last_name&id=eq.${t.id}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  })
  const profJ = await profRes.json()
  if (!profJ || profJ.length === 0) {
    const insRes = await fetch(`${SB}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ id: t.id, first_name: t.firstName, last_name: t.lastName }),
    })
    console.log(`  profile: ${insRes.ok ? 'created' : 'failed'}`)
  } else {
    // Update name
    await fetch(`${SB}/rest/v1/profiles?id=eq.${t.id}`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ first_name: t.firstName, last_name: t.lastName }),
    })
    console.log(`  profile: updated ${profJ[0].first_name} -> ${t.firstName}`)
  }

  // 4. Promote to admin
  const roleRes = await fetch(`${SB}/rest/v1/user_roles`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      user_id: t.id,
      role: 'admin',
      granted_by: t.id,
      granted_at: new Date().toISOString(),
    }),
  })
  const roleJ = await roleRes.json()
  console.log(`  role: ${roleJ[0]?.role || 'FAIL'}`)
  console.log()
}

// 5. Test login for both
console.log('=== LOGIN TESTS ===\n')
for (const t of targets) {
  const loginRes = await fetch(`${SB}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: t.email, password: t.password }),
  })
  const loginJ = await loginRes.json()
  if (loginRes.ok && loginJ.access_token) {
    // Verify role
    const roleRes = await fetch(`${SB}/rest/v1/user_roles?select=role&user_id=eq.${loginJ.user.id}`, {
      headers: { apikey: ANON, Authorization: `Bearer ${loginJ.access_token}` },
    })
    const roleJ = await roleRes.json()
    console.log(`${t.email}: LOGIN OK | role=${roleJ[0]?.role || 'none'}`)
  } else {
    console.log(`${t.email}: LOGIN FAIL ${loginJ.message || loginJ.code}`)
  }
}

console.log('\n========================================')
console.log('  ADMIN ACCOUNTS READY')
console.log('========================================')
console.log('')
console.log('Admin:')
console.log('  Email:    admin@stageflow.ma')
console.log('  Password: Admin@StageFlow2026')
console.log('')
console.log('Manager:')
console.log('  Email:    manager@stageflow.ma')
console.log('  Password: Manager@StageFlow2026')
console.log('')
console.log('Login URL: https://stageflow-psi.vercel.app/connexion')
console.log('========================================')
