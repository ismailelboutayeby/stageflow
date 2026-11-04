import { headers } from 'next/headers'

/**
 * Derives the origin of the current HTTP request from Next.js request headers.
 *
 * This is used to build `emailRedirectTo` URLs for Supabase Auth emails, so
 * that a confirmation link always points back to the site the user was
 * actually browsing when they signed up — never a hardcoded localhost.
 *
 * The `x-forwarded-*` headers are set by Vercel's edge network and are
 * trustworthy there. Locally, Next.js dev server populates `host`.
 */
export async function getRequestOrigin(): Promise<string> {
  const h = await headers()
  const protocol = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  return `${protocol}://${host}`
}

/**
 * Builds a full redirect URL for Supabase Auth emails using the live request
 * origin. Falls back to `NEXT_PUBLIC_SITE_URL` (then localhost) only when
 * headers are unavailable, which should never happen in a real request.
 */
export async function emailRedirectUrl(path: string): Promise<string> {
  const origin = await getRequestOrigin()
  return `${origin}${path}`
}
