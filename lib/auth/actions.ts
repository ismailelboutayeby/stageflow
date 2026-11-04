'use server'

import { redirect } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getSupabaseConfigIssue } from '@/lib/env'
import { getSessionUser, homeRouteForRole } from '@/lib/auth/session'
import { safeRedirectPath } from '@/lib/auth/redirect'
import { enforceRateLimit, failSafe, getClientIp, ok, fail } from '@/lib/auth/rate-limit'
import { emailRedirectUrl } from '@/lib/auth/origin'
import {
  mfaEnrollConfirmSchema,
  mfaUnenrollSchema,
  mfaVerifySchema,
  passwordUpdateSchema,
  signInSchema,
  signUpSchema,
  signupOtpSchema,
  passwordResetRequestSchema,
} from '@/lib/validation/schemas'
import type { ActionResult } from '@/lib/auth/types'

/**
 * Authentication server actions.
 *
 * Everything here delegates password hashing, token issuance and session
 * management to Supabase Auth. We never store, hash, log or transmit passwords
 * ourselves.
 */

/* -------------------------------------------------------------------------- */
/* Sign up — always a stagiaire                                                */
/* -------------------------------------------------------------------------- */

export async function signUpStagiaire(
  input: unknown,
): Promise<ActionResult<{ needsEmailConfirmation: boolean; email: string }>> {
  const parsed = signUpSchema.safeParse(input)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    return { ok: false, error: 'Veuillez corriger les champs signalés.', fieldErrors: flat.fieldErrors }
  }

  const data = parsed.data
  const ip = await getClientIp()

  // Fail before touching the network when the deployment has no usable
  // credentials. Otherwise the SDK produces an ENOTFOUND, which reaches the
  // user as a vague "creation failed" and hides the real (operator) problem.
  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)

  // Throttle by IP and by target address so one actor cannot enumerate accounts.
  const ipGate = await enforceRateLimit('signUp', `ip:${ip}`)
  if (!ipGate.allowed) return ipGate.result
  const emailGate = await enforceRateLimit('signUp', `email:${data.email}`)
  if (!emailGate.allowed) return emailGate.result

  try {
    const supabase = await createClient()

    const { data: result, error } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        // Only the trainee role is ever implied by public signup. There is no
        // `role` or `is_admin` key here, and the database trigger hard-codes
        // 'stagiaire' regardless of what arrives in this metadata.
        data: {
          first_name: data.firstName,
          last_name: data.lastName,
          phone: data.phone,
        },
        emailRedirectTo: await emailRedirectUrl('/auth/callback?next=/stagiaire/tableau-de-bord'),
      },
    })

    if (error) {
      // Deliberately generic: never reveal whether the address already exists.
      if (error.message.toLowerCase().includes('already registered')) {
        return {
          ok: false,
          error:
            'Si cette adresse n’est pas encore utilisée, un e-mail de confirmation vient de vous être envoyé.',
          fieldErrors: { email: ['Cette adresse e-mail ne peut pas être utilisée.'] },
        }
      }
      return failSafe(error, 'La création du compte a échoué. Veuillez réessayer.')
    }

    // With email confirmation enabled Supabase returns a user but no session.
    const needsEmailConfirmation = !result.session

    return ok(
      { needsEmailConfirmation, email: data.email },
      needsEmailConfirmation
        ? 'Compte créé. Vérifiez votre boîte e-mail pour confirmer votre adresse.'
        : 'Compte créé avec succès.',
    )
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Email confirmation OTP                                                     */
/* -------------------------------------------------------------------------- */

export async function verifySignupOtp(input: unknown): Promise<ActionResult<{ redirectTo: string }>> {
  const parsed = signupOtpSchema.safeParse(input)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    return { ok: false, error: 'Veuillez saisir le code reçu par e-mail.', fieldErrors: flat.fieldErrors }
  }

  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)

  const ip = await getClientIp()
  const gate = await enforceRateLimit('verifySignupOtp', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.code,
      type: 'signup',
    })

    if (error) return fail('Code incorrect ou expiré. Demandez un nouveau code puis réessayez.')

    const user = await getSessionUser()
    if (!user) return fail('Adresse confirmée. Connectez-vous pour accéder à votre espace.')

    return ok(
      { redirectTo: safeRedirectPath(undefined, homeRouteForRole(user.role)) },
      'Adresse e-mail confirmée. Bienvenue sur StageFlow.',
    )
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Sign in                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Successful first-factor (password) authentication. There are two terminal
 * shapes: a complete aal2 session for plain accounts, or a pending second
 * factor for accounts with a verified TOTP factor — GoTrue hands out an aal1
 * session either way, so the application performs the upgrade itself.
 */
export type SignInSuccess =
  | { requiresMfa: false; redirectTo: string }
  | { requiresMfa: true; factorId: string; challengeId: string }

export async function signIn(
  input: unknown,
  options?: { next?: string },
): Promise<ActionResult<SignInSuccess>> {
  const parsed = signInSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Identifiants invalides.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  const data = parsed.data
  const ip = await getClientIp()

  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)

  const gate = await enforceRateLimit('signIn', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()

    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    })

    if (error) {
      /*
       * `email_not_confirmed` is only returned by Supabase AFTER the password has
       * been verified, so surfacing it discloses nothing an attacker could not
       * already learn by knowing the password. Collapsing it into the generic
       * message — as this used to — left a confirmed-looking dead end for a user
       * who simply had not clicked the link yet.
       */
      const isUnconfirmed =
        error.code === 'email_not_confirmed' ||
        error.message.toLowerCase().includes('email not confirmed')

      if (isUnconfirmed) {
        return {
          ok: false,
          error:
            'Votre adresse e-mail n’est pas encore confirmée. Ouvrez le lien reçu par e-mail, puis reconnectez-vous. Vous pouvez demander un nouvel envoi depuis la page de vérification.',
        }
      }

      // One generic message for every other failure mode: no account
      // enumeration, no distinction between wrong password and unknown address.
      return {
        ok: false,
        error: 'Adresse e-mail ou mot de passe incorrect.',
        fieldErrors: {},
      }
    }

    /*
     * Second-factor gate, applied BEFORE any role resolution or redirect.
     * When the freshly granted aal1 session belongs to an account that also
     * owns a verified TOTP factor, the client receives a challenge descriptor
     * and shows the six-digit step — the session cookie alone must never be
     * enough to reach a protected page.
     */
    const challenge = await createLevel2Challenge(supabase)
    if (challenge) {
      return ok(
        { requiresMfa: true, factorId: challenge.factorId, challengeId: challenge.challengeId },
        'La double authentification est activée pour ce compte.',
      )
    }

    // Resolve the role from the database, never from the request.
    const user = await getSessionUser()
    if (!user) {
      return fail('Votre session n’a pas pu être établie. Veuillez réessayer.')
    }

    // Only a same-origin relative path is honoured. This uses the same helper as
    // the middleware rather than an ad-hoc check, so backslash and encoded
    // payloads are rejected identically everywhere.
    const redirectTo = safeRedirectPath(options?.next, homeRouteForRole(user.role))

    return ok({ requiresMfa: false, redirectTo }, 'Connexion réussie.')
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Sign-in second factor (TOTP)                                                */
/* -------------------------------------------------------------------------- */

type MfaChallenge = { factorId: string; challengeId: string }

/**
 * Maps GoTrue's MFA failures to the two French messages the UI needs: the code
 * was wrong, or the challenge lapsed and a fresh one must be issued. Anything
 * else collapses into the "code incorrect" case, which cannot leak anything
 * beyond what the correct/incorrect distinction already implies.
 */
function mapMfaVerifyError(error: { message?: string } | null): string {
  const message = (error?.message ?? '').toLowerCase()
  if (message.includes('challenge_expired') || message.includes('expired')) {
    return 'Cette vérification a expiré. Demandez un nouveau code puis réessayez.'
  }
  return 'Code incorrect. Vérifiez le code affiché par votre application d’authentification et réessayez.'
}

/**
 * Issues a fresh TOTP challenge when the current session still misses its
 * verified second factor.
 *
 * The factor identity is chosen SERVER-SIDE from the caller's own factor list
 * (GoTrue only ever returns the session owner's factors), so the client can
 * never point the challenge at an arbitrary account or factor. Returns null
 * when there is nothing to enforce: no verified factor, or already aal2.
 */
async function createLevel2Challenge(supabase: SupabaseClient): Promise<MfaChallenge | null> {
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (!aal || aal.nextLevel !== 'aal2' || aal.currentLevel === 'aal2') return null

  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors()
  if (listError || !factors) return null

  const factor = (factors.totp ?? []).find((f) => f.status === 'verified')
  if (!factor) return null

  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: factor.id,
  })
  if (challengeError || !challenge) return null

  return { factorId: factor.id, challengeId: challenge.id }
}

/**
 * Server-side challenge creation for the two screens that render the code form
 * outside the sign-in flow: `/connexion/verification` (session resumed after a
 * reload) and `/securite` (re-verification wall). Returns null — and callers
 * treat that as "route elsewhere" — when the session does not owe a code step.
 */
export async function issueMfaChallenge(): Promise<ActionResult<MfaChallenge | null>> {
  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)

  try {
    const supabase = await createClient()
    return ok(await createLevel2Challenge(supabase))
  } catch (error) {
    return failSafe(error)
  }
}

/** Completes the sign-in with the six-digit code from the authenticator app. */
export async function verifyMfa(
  input: unknown,
  options?: { next?: string },
): Promise<ActionResult<{ redirectTo: string }>> {
  const parsed = mfaVerifySchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Le code doit contenir exactement 6 chiffres.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)

  // Six digits are cheap to guess in bulk: a short sliding window per IP is
  // what keeps brute force out, on top of GoTrue's own throttling.
  const ip = await getClientIp()
  const gate = await enforceRateLimit('mfaVerify', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()

    const { error } = await supabase.auth.mfa.verify({
      factorId: parsed.data.factorId,
      challengeId: parsed.data.challengeId,
      code: parsed.data.code,
    })

    if (error) return fail(mapMfaVerifyError(error))

    // The upgraded session belongs to the browser that owns the cookies; the
    // role still comes from the database, never from the payload.
    const user = await getSessionUser()
    if (!user) {
      return fail('Votre session n’a pas pu être établie. Veuillez vous reconnecter.')
    }

    const redirectTo = safeRedirectPath(options?.next, homeRouteForRole(user.role))
    return ok({ redirectTo }, 'Vérification en deux étapes confirmée.')
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Sign out                                                                    */
/* -------------------------------------------------------------------------- */

export async function signOut(): Promise<never> {
  const supabase = await createClient()
  await supabase.auth.signOut({ scope: 'global' })
  redirect('/connexion?deconnexion=1')
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                              */
/* -------------------------------------------------------------------------- */

export async function requestPasswordReset(input: unknown): Promise<ActionResult<null>> {
  const parsed = passwordResetRequestSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'Adresse e-mail invalide.' }
  }

  const ip = await getClientIp()
  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)
  const gate = await enforceRateLimit('passwordReset', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()
    const siteUrl = await emailRedirectUrl('')

    await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${siteUrl}/auth/callback?next=/reinitialiser-mot-de-passe`,
    })

    // Always the same answer, regardless of whether the address exists.
    return ok(
      null,
      'Si un compte existe pour cette adresse, un lien de réinitialisation vient d’être envoyé.',
    )
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Password update (from the recovery link)                                    */
/* -------------------------------------------------------------------------- */

export async function updatePassword(input: unknown): Promise<ActionResult<null>> {
  const parsed = passwordUpdateSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Veuillez corriger les champs signalés.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  try {
    const supabase = await createClient()

    // Requires a valid session, which only exists after the recovery link was
    // exchanged. An unauthenticated caller cannot reach this path.
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) {
      return fail('Votre lien de réinitialisation a expiré. Veuillez en demander un nouveau.')
    }

    const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
    if (error) {
      return failSafe(error, 'La mise à jour du mot de passe a échoué.')
    }

    return ok(null, 'Votre mot de passe a été mis à jour.')
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Resend verification e-mail                                                  */
/* -------------------------------------------------------------------------- */

export async function resendVerificationEmail(email: string): Promise<ActionResult<null>> {
  const parsed = passwordResetRequestSchema.safeParse({ email })
  if (!parsed.success) return fail('Adresse e-mail invalide.')

  const ip = await getClientIp()
  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)
  const gate = await enforceRateLimit('resendVerification', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()
    const siteUrl = await emailRedirectUrl('')

    await supabase.auth.resend({
      type: 'signup',
      email: parsed.data.email,
      options: { emailRedirectTo: `${siteUrl}/auth/callback?next=/stagiaire/tableau-de-bord` },
    })

    return ok(null, 'Si ce compte attend une confirmation, un nouvel e-mail vient d’être envoyé.')
  } catch (error) {
    return failSafe(error)
  }
}

/* -------------------------------------------------------------------------- */
/* Two-factor enrolment and removal (/securite)                                */
/* -------------------------------------------------------------------------- */

/**
 * Refuses MFA management while the session still owes its code step. Without
 * this a hacked password alone could enrol (or silently replace) a second
 * factor — the lock is the whole point of the feature.
 */
async function gateMfaManagement(): Promise<ActionResult<never> | null> {
  const configIssue = getSupabaseConfigIssue()
  if (configIssue) return fail(configIssue)

  const user = await getSessionUser()
  if (!user) return fail('Votre session a expiré. Veuillez vous reconnecter.')

  const { getMfaState } = await import('@/lib/auth/session')
  const mfa = await getMfaState()
  if (mfa.enforced) {
    return fail('Vérifiez d’abord votre code d’authentification pour gérer ce paramètre.')
  }

  return null
}

/**
 * Step 1 of enrolment: create the factor and return its secret — never the
 * generated QR image, which weighs ~360 KB as an SVG and would bloat every
 * Server Action payload; the client renders its own QR from the secret.
 */
export async function startTotpEnroll(): Promise<
  ActionResult<{ factorId: string; secret: string; email: string | null }>
> {
  const blocked = await gateMfaManagement()
  if (blocked) return blocked

  const user = await getSessionUser()
  if (!user) return fail('Votre session a expiré. Veuillez vous reconnecter.')

  const ip = await getClientIp()
  const enrollGate = await enforceRateLimit('mfaEnroll', `ip:${ip}`)
  if (!enrollGate.allowed) return enrollGate.result

  try {
    const supabase = await createClient()

    // Housekeeping: abandoned enrolments (closed tab, lost app) leave unverified
    // secrets behind. Clean them up so the factor list stays meaningful.
    const { data: existing } = await supabase.auth.mfa.listFactors()
    for (const stale of existing?.totp ?? []) {
      if (stale.status !== 'verified') {
        await supabase.auth.mfa.unenroll({ factorId: stale.id })
      }
    }

    const { data: enrolled, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `Authentificateur — ${new Date().toLocaleDateString('fr-FR')}`,
    })

    if (error || !enrolled) {
      return failSafe(error, 'Impossible de commencer l’ajout. Veuillez réessayer.')
    }

    const secret = enrolled.totp?.secret
    if (!secret) {
      return fail('La clé de configuration n’a pas été générée. Veuillez réessayer.')
    }

    return ok(
      { factorId: enrolled.id, secret, email: user.email },
      'Scannez le QR code puis saisissez le code à 6 chiffres.',
    )
  } catch (error) {
    return failSafe(error)
  }
}

/**
 * Step 2 of enrolment: challenge + verify inline (the challenge never round
 * trips through the client). Success upgrades BOTH the factor to "verified"
 * and the session to aal2.
 */
export async function confirmTotpEnroll(
  input: unknown,
): Promise<ActionResult<{ verified: true }>> {
  const parsed = mfaEnrollConfirmSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Le code doit contenir exactement 6 chiffres.',
      fieldErrors: parsed.error.flatten().fieldErrors,
    }
  }

  const blocked = await gateMfaManagement()
  if (blocked) return blocked

  const ip = await getClientIp()
  const gate = await enforceRateLimit('mfaEnroll', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: parsed.data.factorId,
    })
    if (challengeError || !challenge) {
      return fail('Le facteur doit être configuré à nouveau. Recommencez l’ajout.')
    }

    const { error } = await supabase.auth.mfa.verify({
      factorId: parsed.data.factorId,
      challengeId: challenge.id,
      code: parsed.data.code,
    })
    if (error) return fail(mapMfaVerifyError(error))

    return ok({ verified: true }, 'La double authentification est désormais active.')
  } catch (error) {
    return failSafe(error)
  }
}

/**
 * Removes a factor. GoTrue only lists the session owner's factors, so the
 * incoming UUID cannot address someone else's — still, the verified-factor
 * path re-checks the AAL server-side: an attacker who "simply" has the
 * password (aal1) gets the re-verification wall, not the factor.
 */
export async function unenrollTotp(input: unknown): Promise<ActionResult<null>> {
  const parsed = mfaUnenrollSchema.safeParse(input)
  if (!parsed.success) return fail('Demande invalide.')

  const blocked = await gateMfaManagement()
  if (blocked) return blocked

  const ip = await getClientIp()
  const gate = await enforceRateLimit('mfaUnenroll', `ip:${ip}`)
  if (!gate.allowed) return gate.result

  try {
    const supabase = await createClient()

    const { data: factors } = await supabase.auth.mfa.listFactors()
    const factor = (factors?.totp ?? []).find((f) => f.id === parsed.data.factorId)
    if (!factor) return fail('Facteur introuvable.')

    if (factor.status === 'verified') {
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && aal.currentLevel !== 'aal2') {
        return fail('Vérifiez d’abord votre code d’authentification pour effectuer cette action.')
      }
    }

    const { error } = await supabase.auth.mfa.unenroll({ factorId: parsed.data.factorId })
    if (error) {
      return failSafe(error, 'La désactivation a échoué. Veuillez réessayer.')
    }

    return ok(null, 'La double authentification a été désactivée.')
  } catch (error) {
    return failSafe(error)
  }
}
