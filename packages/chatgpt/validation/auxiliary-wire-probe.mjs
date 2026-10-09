import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const consumerDir = resolve(process.env.DSH_CONSUMER_DIR ?? process.cwd())
const consumerRequire = createRequire(resolve(consumerDir, 'package.json'))
const consumerManifestPath = consumerRequire.resolve('@deepseek-ai/dsh/package.json')
const consumerManifest = JSON.parse(await readFile(consumerManifestPath, 'utf8'))
const supportedDshVersions = ['0.2.0-rc.2', '0.2.1-alpha.1']
assert.ok(supportedDshVersions.includes(consumerManifest.version), `Unsupported DSH consumer version: ${consumerManifest.version}`)

const pluginDir = process.env.DSH_PLUGIN_DIR ? resolve(process.env.DSH_PLUGIN_DIR) : consumerDir
const pluginRequire = createRequire(resolve(pluginDir, 'package.json'))
const pluginEntryPath = pluginRequire.resolve('@f12o/dsh-siwc')
const pluginPackageDir = resolve(dirname(pluginEntryPath), '..')
const pluginManifest = JSON.parse(await readFile(join(pluginPackageDir, 'package.json'), 'utf8'))
assert.equal(pluginManifest.name, '@f12o/dsh-siwc', `Unexpected plugin at ${pluginPackageDir}`)

const consumerModuleNames = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-session-title-llm',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-typert-protocol',
]
const consumerModuleUrls = new Map(consumerModuleNames.map((specifier) => [specifier, pathToFileURL(consumerRequire.resolve(specifier)).href]))
consumerModuleUrls.set('@deepseek-ai/cordis', pathToFileURL(consumerRequire.resolve('@deepseek-ai/cordis')).href)

registerHooks({
  resolve(specifier, context, nextResolve) {
    const consumerUrl = consumerModuleUrls.get(specifier)
    if (consumerUrl && context.conditions.includes('import') && specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: consumerUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const importConsumerPackage = (specifier) => import(consumerModuleUrls.get(specifier))
const importChatgptPlugin = () => import(pathToFileURL(pluginEntryPath).href)

const requiredScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
].join(' ')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' })
jwk.kid = 'local-only-kid'
jwk.alg = 'RS256'
jwk.use = 'sig'
jwk.key_ops = ['verify']

const responseRequests = []
let loginNonce
let responseMode = 'text'
const nativeFetch = globalThis.fetch

function jwtFor(nonce, clientId) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = b64({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const claims = b64({
    iss: 'https://auth.openai.com',
    aud: clientId,
    sub: 'scratch-only-subject',
    nonce,
    email: 'scratch@example.invalid',
    email_verified: true,
    iat: now,
    exp: now + 3600,
  })
  const content = `${header}.${claims}`
  const signature = sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')
  return `${content}.${signature}`
}

function responseSse(body) {
  const requestNumber = responseRequests.length - 1
  const responseId = `resp_scratch_${requestNumber}`
  const model = body.model
  const usage = {
    input_tokens: 31,
    input_tokens_details: { cached_tokens: 7, cache_write_tokens: 0 },
    output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 40,
  }
  const output = responseMode === 'tool'
    ? [{ id: `fc_${requestNumber}`, type: 'function_call', status: 'completed', call_id: `call_${requestNumber}`, name: 'lookup', arguments: '{"q":"scratch"}' }]
    : [{ id: `msg_${requestNumber}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], text: requestNumber === 0 ? 'Scratch title' : 'A compacted summary' }] }]
  const events = [{
    type: 'response.created',
    sequence_number: 0,
    response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] },
  }]
  if (responseMode === 'tool') {
    const item = output[0]
    events.push(
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', sequence_number: 2, output_index: 0, item_id: item.id, delta: '{"q":"scratch"}' },
      { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    )
  } else {
    const item = output[0]
    const text = item.content[0].text
    events.push(
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, item_id: item.id, content_index: 0, delta: text },
      { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    )
  }
  events.push({
    type: 'response.completed',
    sequence_number: events.length,
    response: {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output,
      usage,
    },
  })
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const fixture = createServer(async (request, response) => {
  if (request.url !== '/upstream') {
    response.writeHead(404).end()
    return
  }
  const originalUrl = request.headers['x-upstream-url']
  const original = new URL(String(originalUrl))
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const bodyText = Buffer.concat(chunks).toString('utf8')
  const record = { url: original.href, method: request.method, headers: request.headers, bodyText }
  if (original.pathname === '/.well-known/openid-configuration') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      issuer: 'https://auth.openai.com',
      jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
      revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
    }))
    return
  }
  if (original.pathname === '/.well-known/jwks.json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ keys: [jwk] }))
    return
  }
  if (original.pathname === '/api/accounts/oauth/token') {
    const form = new URLSearchParams(bodyText)
    const clientId = form.get('client_id')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      access_token: 'scratch-only-access-token',
      refresh_token: 'scratch-only-refresh-token',
      id_token: jwtFor(loginNonce, clientId),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: requiredScopes,
    }))
    return
  }
  if (original.pathname === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' }] }))
    return
  }
  if (original.pathname === '/v1/responses') {
    const body = JSON.parse(bodyText)
    responseRequests.push({ ...record, body })
    const sse = responseSse(body)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.end(sse)
    return
  }
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: 'unexpected fake upstream path' }))
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
const fixtureAddress = fixture.address()
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/upstream`
const fixtureOrigin = new URL(fixtureUrl).origin
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin === fixtureOrigin) return nativeFetch(input, init)
  if (url.hostname !== 'auth.openai.com' && url.hostname !== 'api.openai.com') {
    throw new Error(`Blocked unexpected network request to ${url.origin}`)
  }
  const headers = new Headers(request.headers)
  headers.set('x-upstream-url', url.href)
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer())
  return nativeFetch(fixtureUrl, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: request.signal,
  })
}

const scratchHome = await mkdtemp(join(tmpdir(), 'dsh-siwc-aux-wire-'))
const credentialPath = join(scratchHome, '.credentials.yaml')
let ctx
let fibers = []
try {
  const [{ Context }, { TypertRegistry }, { SessionProjectionRegistry }, { SessionStore, Session }, { TokenMeter }, { LlmRuntime, createUserMessage }, { LocalCredentialProvider }, { AuthorizationService }, { generateSessionTitleWithLlm, resolveSessionTitleLlmConfig }, { BasicCompactionEngine }, chatgpt] = await Promise.all([
    importConsumerPackage('@deepseek-ai/cordis'),
    importConsumerPackage('@deepseek-ai/dsh-typert-registry'),
    importConsumerPackage('@deepseek-ai/dsh-session-projection'),
    importConsumerPackage('@deepseek-ai/dsh-session'),
    importConsumerPackage('@deepseek-ai/dsh-token-meter'),
    importConsumerPackage('@deepseek-ai/dsh-llm'),
    importConsumerPackage('@deepseek-ai/dsh-credentials-local'),
    importConsumerPackage('@deepseek-ai/dsh-authorization'),
    importConsumerPackage('@deepseek-ai/dsh-session-title-llm'),
    importConsumerPackage('@deepseek-ai/dsh-compaction-basic'),
    importChatgptPlugin(),
  ])

  ctx = new Context()
  fibers.push(await ctx.plugin(TypertRegistry))
  fibers.push(await ctx.plugin(SessionProjectionRegistry))
  fibers.push(await ctx.plugin(LocalCredentialProvider, { path: credentialPath, watch: false }))
  fibers.push(await ctx.plugin(AuthorizationService))
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(SessionStore))
  fibers.push(await ctx.plugin(TokenMeter))
  const chatgptPlugin = {
    name: chatgpt.name,
    inject: chatgpt.inject,
    Config: chatgpt.Config,
    apply: chatgpt.apply,
  }
  fibers.push(await ctx.plugin(chatgptPlugin, {}))
  fibers.push(await ctx.plugin(BasicCompactionEngine, {
    auto: false,
    headroomTokens: 65_536,
    maxTokens: 65_536,
    summarizationProvider: 'chatgpt',
    summarizationModel: 'gpt-6-luna',
  }))

  const ticket = await ctx.chatgptController.beginLogin({})
  const authorizeUrl = new URL(ticket.authorizationUrl)
  assert.match(authorizeUrl.searchParams.get('ext_agent_host_id') ?? '', /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  loginNonce = authorizeUrl.searchParams.get('nonce')
  assert.ok(loginNonce)
  const callback = new URL(authorizeUrl.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', authorizeUrl.searchParams.get('state'))
  callback.searchParams.set('code', 'scratch-only-code')
  callback.searchParams.set('client_id', 'scratch-only-client-id')
  const callbackResponse = await nativeFetch(callback)
  assert.equal(callbackResponse.status, 200)
  // The callback response is sent only after the public Host stored the grant.
  const signedIn = await ctx.chatgptController.getState()
  assert.equal(signedIn.accounts.length, 1)
  assert.equal(signedIn.accounts[0].status, 'connected')

  const titleSession = Session.create('scratch-title-session')
  const titleUser = createUserMessage({ content: [{ type: 'text', text: 'Please summarize this scratch-only conversation.' }], source: { kind: 'user' } })
  const titleSeq = titleSession.append('user/message', titleUser, { surfaceOp: 'append' }).seq
  const titleRequest = {
    session: titleSession,
    messages: [{ seq: titleSeq, text: 'Please summarize this scratch-only conversation.' }],
    signal: new AbortController().signal,
  }
  const title = await generateSessionTitleWithLlm(ctx, resolveSessionTitleLlmConfig({
    targetWords: 6,
    targetCjkCharacters: 12,
    maxInputBytes: 4096,
    maxOutputTokens: 64,
    timeoutMs: 10_000,
    provider: 'chatgpt',
    model: 'gpt-6-luna',
  }), titleRequest, titleRequest.messages, 'scratch-title-provider')
  assert.equal(title.title, 'Scratch title')
  const titleWire = responseRequests.at(-1)?.body
  assert.equal(titleWire.model, 'gpt-6-luna')
  assert.equal(Object.hasOwn(titleWire, 'max_output_tokens'), false)
  const titleRecord = titleSession.snapshotEvents().find((event) => event.type === 'session/title-llm-request')
  assert.equal(titleRecord.data.maxTokens, 64)

  const compactSession = Session.create('scratch-compaction-session')
  compactSession.append('turn/start', { turn: 1 })
  const compactSource = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const compactText = 'This long scratch-only passage gives the actual compaction policy enough source material to replace with a shorter checkpoint. '.repeat(32)
  const compactSeqs = [
    compactSession.append('user/message', compactSource(compactText), { surfaceOp: 'append' }).seq,
    compactSession.append('user/message', compactSource(compactText), { surfaceOp: 'append' }).seq,
  ]
  const compactResult = await ctx.compaction.compactRegion(compactSeqs[0], compactSeqs[1], {
    session: compactSession,
    options: { provider: 'chatgpt', model: 'gpt-6-luna' },
  })
  assert.deepEqual(compactResult.shadowedSeqs, compactSeqs)
  const compactWire = responseRequests.at(-1)?.body
  assert.equal(compactWire.model, 'gpt-6-luna')
  assert.equal(Object.hasOwn(compactWire, 'max_output_tokens'), false)
  const summaryRecord = compactSession.snapshotEvents().find((event) => event.type === 'compaction/summary')
  assert.equal(summaryRecord.data.maxTokens, 65_536)
  assert.deepEqual(summaryRecord.data.usage, {
    inputTokens: 24,
    outputTokens: 9,
    totalTokens: 40,
    cacheReadTokens: 7,
    reasoningTokens: 2,
  })

  const beforeRejected = responseRequests.length
  const ordinary = await Array.fromAsync(ctx.llm.stream({
    provider: 'chatgpt',
    model: 'gpt-6-luna',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'ordinary request' }], source: { kind: 'user' } })],
    maxTokens: 1,
  }))
  assert.equal(responseRequests.length, beforeRejected)
  assert.equal(ordinary.at(-1)?.reason?.failure?.code, 'UNSUPPORTED_PARAMETER')

  responseMode = 'tool'
  const toolStream = await Array.fromAsync(ctx.llm.stream({
    provider: 'chatgpt',
    model: 'gpt-6-luna',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'call lookup' }], source: { kind: 'user' } })],
    tools: [{
      name: 'lookup',
      description: 'Return a scratch record.',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    }],
  }))
  const toolWire = responseRequests.at(-1)?.body
  assert.equal(Object.hasOwn(toolWire, 'max_output_tokens'), false)
  assert.equal(toolStream.at(-1)?.reason?.kind, 'tool-calls')
  assert.deepEqual(toolStream.filter((chunk) => chunk.type === 'usage').at(-1)?.usage, {
    inputTokens: 24,
    outputTokens: 9,
    totalTokens: 40,
    cacheReadTokens: 7,
    reasoningTokens: 2,
  })
  assert.ok(toolStream.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.arguments === '{"q":"scratch"}'))

  console.log(JSON.stringify({
    consumerVersion: consumerManifest.version,
    pluginPackageDir,
    title: { title: title.title, maxTokens: titleRecord.data.maxTokens, wireMaxOutputTokens: titleWire.max_output_tokens ?? null },
    compaction: { maxTokens: summaryRecord.data.maxTokens, usage: summaryRecord.data.usage, wireMaxOutputTokens: compactWire.max_output_tokens ?? null },
    normalCapRejectedBeforeHttp: ordinary.at(-1)?.reason?.failure?.code,
    toolCall: { finish: toolStream.at(-1)?.reason?.kind, usage: toolStream.filter((chunk) => chunk.type === 'usage').at(-1)?.usage },
    wireRequests: responseRequests.map(({ body }) => ({ model: body.model, max_output_tokens: body.max_output_tokens, stream: body.stream })),
  }, null, 2))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {})
  globalThis.fetch = nativeFetch
  await rm(scratchHome, { recursive: true, force: true })
  await new Promise((resolve) => fixture.close(resolve))
}
