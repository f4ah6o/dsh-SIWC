import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { exchangeAuthorizationCode } from '../src/oauth.js'

const issuer = 'https://auth.openai.com'
const clientId = 'client-for-test'
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function signedIdentity(nonce: string | undefined): Promise<{ readonly token: string; readonly jwks: unknown }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = await exportJWK(publicKey)
  const token = await new SignJWT({
    ...(nonce === undefined ? {} : { nonce }),
    email: 'person@example.com',
    email_verified: true,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject('verified-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
  return {
    token,
    jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'ES256', use: 'sig' }] },
  }
}

async function exchange(nonce: string | undefined): Promise<void> {
  const identity = await signedIdentity(nonce)
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
        refresh_token: 'refresh-token',
        id_token: identity.token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: scopes,
      })
    }
    if (url === `${issuer}/.well-known/jwks.json`) return jsonResponse(identity.jwks)
    throw new Error(`unexpected OAuth URL: ${url}`)
  }
  await exchangeAuthorizationCode({
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
    await expect(exchange('expected-nonce')).resolves.toBeUndefined()
    await expect(exchange('different-nonce')).rejects.toThrow(/another sign-in request/u)
    await expect(exchange(undefined)).rejects.toThrow(/another sign-in request/u)
  })
})
