import { newOAuthFlowId } from '@/lib/auth/oauth-flows'

/**
 * Optional public routing hint for deployments sharing a registered callback.
 * The random flow ID, PKCE and initiator checks remain the authentication gates.
 * Dots cannot occur in an unprefixed base64url ID or collide with connector states.
 */
export function newSkvOAuthState(): string {
  const namespace = process.env.SKATTEVERKET_OAUTH_STATE_NAMESPACE
  if (!namespace) return newOAuthFlowId()
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) {
    throw new Error('Invalid SKATTEVERKET_OAUTH_STATE_NAMESPACE')
  }
  return `instance.${namespace}.${newOAuthFlowId()}`
}
