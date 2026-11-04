'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { requireRole, fail, failSafe, ok } from '@/lib/auth/rate-limit'
import { emailRedirectUrl } from '@/lib/auth/origin'
import { adminInviteSchema } from '@/lib/validation/support'
import type { ActionResult } from '@/lib/auth/types'

export async function inviteAdmin(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole('admin')
  if (!session.ok) return session.result
  const parsed = adminInviteSchema.safeParse(input)
  if (!parsed.success) return fail('Veuillez corriger les informations du nouvel administrateur.')
  const admin = createAdminClient()
  if (!admin) return fail('La configuration serveur ne permet pas de gérer les invitations.')

  try {
    const redirectTo = await emailRedirectUrl('/auth/callback?next=/admin/tableau-de-bord')
    const { data, error } = await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
      data: { first_name: parsed.data.firstName, last_name: parsed.data.lastName },
      redirectTo,
    })
    if (error || !data.user) return failSafe(error, 'L’invitation n’a pas pu être envoyée.')

    const { error: roleError } = await admin.from('user_roles').upsert({
      user_id: data.user.id,
      role: 'admin',
      granted_by: session.user.id,
    })
    if (roleError) return failSafe(roleError, 'L’invitation a été créée, mais le rôle n’a pas pu être enregistré.')
    revalidatePath('/admin/utilisateurs')
    return ok(null, 'Invitation administrateur envoyée par e-mail.')
  } catch (error) {
    return failSafe(error, 'L’invitation n’a pas pu être envoyée.')
  }
}
