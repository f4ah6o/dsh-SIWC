import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { exchangeAuthorizationCode } from '../src/oauth.js'
import type { OAuthCompletion } from '../src/oauth.js'

const issuer = 'https://auth.openai.com'
const clientId = 'client-for-test'
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

interface IdentityOptions {
  readonly issuer?: string
  readonly audience?: string
  readonly subject?: string | null
  readonly expiresAt?: number
  readonly badSignature?: boolean
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function signedIdentity(
  nonce: string | undefined,
  options: IdentityOptions = {},
): Promise<{ readonly token: string; readonly jwks: unknown }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = await exportJWK(publicKey)
  const signingKey = options.badSignature === true ? (await generateKeyPair('ES256')).privateKey : privateKey
  let builder = new SignJWT({
    ...(nonce === undefined ? {} : { nonce }),
    email: 'person@example.com',
    email_verified: true,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? clientId)
    .setIssuedAt()
    .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300)
  if (options.subject !== null) builder = builder.setSubject(options.subject ?? 'verified-subject')
  const token = await builder.sign(signingKey)
  return {
    token,
    jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] },
  }
}

async function exchange(
  nonce: string | undefined,
  scope = scopes,
  includeRefreshToken = true,
  identityOptions: IdentityOptions = {},
): Promise<OAuthCompletion> {
  const identity = await signedIdentity(nonce, identityOptions)
  const fetcher: typeof fetch = async input => {
    const url = String(input)
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
      })
    }
    if (url === `${issuer}/api/accounts/oauth/token`) {
      return jsonResponse({
        access_token: 'access-token',
        id_token: identity.token,
        ...(includeRefreshToken ? { refresh_token: 'refresh-token' } : {}),
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
      })
    }
    if (url === `${issuer}/.well-known/jwks.json`) return jsonResponse(identity.jwks)
    throw new Error(`unexpected OAuth URL: ${url}`)
  }
  return await exchangeAuthorizationCode({
    code: 'authorization-code',
    clientId,
    verifier: 'a'.repeat(43),
    redirectUri: 'http://127.0.0.1:43123/auth/callback',
    nonce: 'expected-nonce',
    requestTimeoutMs: 5_000,
    fetcher,
  })
}

describe('Sign in with ChatGPT identity verification', () => {
  it('accepts the signed ID token only when the verified nonce matches this sign-in', async () => {
    await expect(exchange('expected-nonce')).resolves.toMatchObject({ status: 'connected' })
    await expect(exchange('different-nonce')).rejects.toThrow(/another sign-in request/u)
    await expect(exchange(undefined)).rejects.toThrow(/another sign-in request/u)
  })

  it.each([
    { reason: 'issuer', options: { issuer: 'https://attacker.example' } },
    { reason: 'audience', options: { audience: 'another-client' } },
    { reason: 'expiry', options: { expiresAt: Math.floor(Date.now() / 1_000) - 1 } },
    { reason: 'subject', options: { subject: '' } },
    { reason: 'signature', options: { badSignature: true } },
  ])('rejects a signed ID token with invalid $reason claims', async ({ options }) => {
    await expect(exchange('expected-nonce', scopes, true, options)).rejects.toThrow()
  })

  it('retains only a verified registration when plan scopes or renewal are missing', async () => {
    const missingDirectPermission = scopes.replace(' chatgpt.tokens.use.direct', '')
    const limited = await exchange('expected-nonce', missingDirectPermission)
    expect(limited).toMatchObject({
      status: 'needs-sign-in',
      registration: { clientId, subject: 'verified-subject', email: 'person@example.com' },
      missingScopes: ['chatgpt.tokens.use.direct'],
    })
    expect(JSON.stringify(limited)).not.toContain('access-token')
    expect(JSON.stringify(limited)).not.toContain('refresh-token')

    const noRefresh = await exchange('expected-nonce', scopes, false)
    expect(noRefresh).toMatchObject({
      status: 'needs-sign-in',
      registration: { clientId, subject: 'verified-subject' },
      missingScopes: [],
    })
    expect(JSON.stringify(noRefresh)).not.toContain('access-token')
  })
})
