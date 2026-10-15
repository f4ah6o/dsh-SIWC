import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchangeAuthorizationCode, revokeRefreshToken } from '../src/oauth.js'
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

describe('renewable-session revocation', () => {
  afterEach(() => vi.useRealTimers())

  const endpoint = `${issuer}/api/accounts/oauth/revoke`
  const metadata = () => jsonResponse({
    issuer, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: endpoint,
  })
  const input = { clientId, refreshToken: 'synthetic-refresh-secret', requestTimeoutMs: 1_000 }

  it('confirms HTTP 200, including an already-invalid token, without parsing an empty body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response(null, { status: 200 }))
    await expect(revokeRefreshToken({ ...input, fetcher })).resolves.toEqual({ status: 'confirmed' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [url, options] = fetcher.mock.calls[1]!
    expect(url).toBe(endpoint)
    expect(options?.method).toBe('POST')
    expect(options?.redirect).toBe('manual')
    expect(options?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' })
    expect(Object.fromEntries(options?.body as URLSearchParams)).toEqual({
      token: input.refreshToken, client_id: clientId, token_type_hint: 'refresh_token',
    })
  })

  it.each([400, 401, 403, 429])('classifies HTTP %s rejection without retrying or exposing the response', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response('synthetic-refresh-secret', { status }))
    await expect(revokeRefreshToken({ ...input, fetcher })).resolves.toEqual({ status: 'unconfirmed', reason: 'request-rejected' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([204, 302])('does not mistake undocumented HTTP %s for confirmation', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response(null, { status }))
    await expect(revokeRefreshToken({ ...input, fetcher })).resolves.toEqual({ status: 'unconfirmed', reason: 'unexpected-response' })
  })

  it.each([
    { failure: '5xx', reason: 'service-unavailable', respond: () => Promise.resolve(new Response('synthetic-secret', { status: 503 })) },
    { failure: 'network error', reason: 'network-error', respond: () => Promise.reject(new Error('synthetic-refresh-secret')) },
    { failure: 'timeout', reason: 'request-timeout', respond: () => Promise.reject(new DOMException('synthetic-refresh-secret', 'TimeoutError')) },
    { failure: 'abort', reason: 'request-timeout', respond: () => Promise.reject(new DOMException('synthetic-refresh-secret', 'AbortError')) },
  ])('bounds the retry after $failure and returns only a safe reason', async ({ respond, reason }) => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('openid-configuration') ? metadata() : respond())
    const pending = revokeRefreshToken({ ...input, fetcher })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toEqual({ status: 'unconfirmed', reason })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('confirms a successful bounded retry after a temporary failure', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(new Response(null, { status: 200 }))
    const pending = revokeRefreshToken({ ...input, fetcher })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toEqual({ status: 'confirmed' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([
    { failure: 'unavailable discovery', discovery: () => Promise.reject(new Error('synthetic-refresh-secret')) },
    { failure: 'untrusted endpoint', discovery: () => Promise.resolve(jsonResponse({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: 'https://attacker.example/revoke' })) },
    { failure: 'invalid discovery', discovery: () => Promise.resolve(jsonResponse({ error: 'synthetic-refresh-secret' })) },
  ])('handles $failure without sending a token to an unverified endpoint', async ({ discovery }) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(discovery)
    await expect(revokeRefreshToken({ ...input, fetcher })).resolves.toEqual({ status: 'unconfirmed', reason: 'metadata-unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
