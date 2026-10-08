import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createDeveloperMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import type { ChatGptAdapterHost } from '../src/adapter-contract.js'
import { ChatGptResponsesAdapter } from '../src/responses.js'
import { OFFICIAL_OPENAI_MODELS, toOpenAiModelInfo, toOpenAiResolvedModelInfo } from '../src/models.js'
import type { ChatGptAccountId } from '../src/types.js'

const provider = 'chatgpt'
const officialModel = OFFICIAL_OPENAI_MODELS[0]
if (officialModel === undefined) throw new Error('official model fixture is missing')
const model = toOpenAiResolvedModelInfo(provider, officialModel)

function hostFor(
  accountSignal = new AbortController().signal,
  accountId: ChatGptAccountId = 'account-test' as ChatGptAccountId,
): ChatGptAdapterHost {
  return {
    listModels: async () => [toOpenAiModelInfo(provider, officialModel)],
    resolveModel: async () => model,
    prepareCall: async () => ({
      accountId,
      accessToken: 'exchanged-access-token',
      accountSignal,
      model,
      requestTimeoutMs: 30_000,
    }),
    readImage: async ref => ({ ref, data: Uint8Array.from([1, 2]) }),
  }
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider,
    model: officialModel.id,
    messages: [
      createSystemMessage('Follow the system instruction.'),
      { role: 'user', content: [{ type: 'text', text: 'Describe this image.' }] },
    ],
    system: 'One-shot system instruction.',
    tools: [{ name: 'lookup', description: 'Find a record.', parameters: { type: 'object' } }],
    ...overrides,
  }
}

function completedTextEvents(text: string): readonly unknown[] {
  const output = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      sequence_number: 1,
      item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
      delta: text,
    },
    { type: 'response.output_item.done', output_index: 0, sequence_number: 3, item: output },
    {
      type: 'response.completed',
      sequence_number: 4,
      response: {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [output],
        model: officialModel.id,
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 3 },
          total_tokens: 17,
        },
      },
    },
  ]
}

function completedReasoningEvents(): readonly unknown[] {
  const reasoning = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Plan.' }],
    encrypted_content: 'opaque-encrypted-reasoning',
    status: 'completed',
  }
  const message = {
    id: 'msg_reasoning',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
  }
  return [
    { type: 'response.output_item.done', output_index: 0, sequence_number: 1, item: reasoning },
    { type: 'response.output_item.done', output_index: 1, sequence_number: 2, item: message },
    {
      type: 'response.completed',
      sequence_number: 3,
      response: {
        id: 'resp_reasoning',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [reasoning, message],
        model: officialModel.id,
        usage: null,
      },
    },
  ]
}

function eventFetch(
  events: readonly unknown[],
  onRequest?: (request: Request, body: Record<string, unknown>) => void,
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const body = await request.clone().json() as Record<string, unknown>
    onRequest?.(request, body)
    const stream = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_123' },
    })
  }
}

async function collect(adapter: ChatGptResponsesAdapter, request: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

describe('ChatGPT Responses adapter', () => {
  it('sends full history with SIWC-safe request fields and maps completed stream data', async () => {
    const imageRef = {
      attachmentId: AttachmentId('image-test'),
      mediaType: 'image/png',
      bytes: 2,
      width: 1,
      height: 1,
    } as const
    let capturedBody: Record<string, unknown> | undefined
    let capturedUrl: string | undefined
    let capturedAuthorization: string | null = null
    let capturedUserAgent: string | null = null
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Hello.'), (request, body) => {
        capturedBody = body
        capturedUrl = request.url
        capturedAuthorization = request.headers.get('authorization')
        capturedUserAgent = request.headers.get('user-agent')
      }),
    })

    const chunks = await collect(adapter, options({
      messages: [
        createSystemMessage('Follow the system instruction.'),
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image', attachment: imageRef },
          ],
        },
      ],
    }))

    expect(capturedUrl).toBe('https://api.openai.com/v1/responses')
    expect(capturedAuthorization).toBe('Bearer exchanged-access-token')
    expect(capturedUserAgent).toContain('deepseek-harness')
    expect(capturedBody).toMatchObject({
      model: officialModel.id,
      store: false,
      stream: true,
      instructions: 'One-shot system instruction.',
    })
    expect(capturedBody).not.toHaveProperty('max_output_tokens')
    expect(capturedBody).not.toHaveProperty('temperature')
    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input[0]).toMatchObject({ type: 'additional_tools', role: 'developer' })
    expect(input[1]).toMatchObject({ type: 'message', role: 'developer' })
    expect(input[2]).toMatchObject({ type: 'message', role: 'user' })
    expect(input[2]?.content).toContainEqual({ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQI=' })
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'block-start', 'text-delta', 'block-end', 'usage', 'finish',
    ])
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({
      block: { type: 'text', text: 'Hello.' },
    })
    expect(chunks.find(chunk => chunk.type === 'usage')).toMatchObject({
      usage: { inputTokens: 9, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5, totalTokens: 17, reasoningTokens: 3 },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { requestId: 'req_123', id: 'resp_1', model: officialModel.id } },
    })
  })

  it.each([
    ['maxTokens', { maxTokens: 10 }],
    ['temperature', { temperature: 0 }],
  ] as const)('rejects explicit %s before transport', async (_name, override) => {
    let requests = 0
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch([], () => { requests += 1 }),
    })

    await expect(collect(adapter, options(override))).rejects.toMatchObject({ code: 'UNSUPPORTED_PARAMETER' })
    expect(requests).toBe(0)
  })

  it.each([
    ['session-title', 64],
    ['compaction', 65_536],
  ] as const)('omits max_output_tokens for the DSH %s auxiliary call', async (purpose, maxTokens) => {
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => { capturedBody = body }),
    })

    await collect(adapter, options({ purpose, maxTokens }))

    expect(capturedBody).not.toHaveProperty('max_output_tokens')
  })

  it('replays the exact completed encrypted reasoning item with its assistant response', async () => {
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedReasoningEvents(), (_request, body) => { bodies.push(body) }),
    })
    const prior = await assistantFromResponse(adapter)

    await collect(adapter, options({
      messages: [
        createSystemMessage('Follow the system instruction.'),
        { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
        prior,
        { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      ],
    }))

    const secondInput = bodies[1]?.input as Array<Record<string, unknown>>
    expect(secondInput).toContainEqual({
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Plan.' }],
      encrypted_content: 'opaque-encrypted-reasoning',
      status: 'completed',
    })
    expect(secondInput.slice(-3)).toEqual([
      {
        id: 'rs_1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Plan.' }],
        encrypted_content: 'opaque-encrypted-reasoning',
        status: 'completed',
      },
      {
        id: 'msg_reasoning',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Answer.', annotations: [] }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    ])
  })

  it('does not replay encrypted reasoning after the active account changes', async () => {
    let accountId = 'account-test' as ChatGptAccountId
    const baseHost = hostFor()
    const host: ChatGptAdapterHost = {
      ...baseHost,
      prepareCall: async (requestedModel, signal) => ({
        ...await baseHost.prepareCall(requestedModel, signal),
        accountId,
      }),
    }
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGptResponsesAdapter(host, {
      fetch: eventFetch(completedReasoningEvents(), (_request, body) => { bodies.push(body) }),
    })
    const prior = await assistantFromResponse(adapter)
    accountId = 'account-other' as ChatGptAccountId

    await collect(adapter, options({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
        prior,
        { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      ],
    }))

    expect(JSON.stringify(bodies[1]?.input)).not.toContain('opaque-encrypted-reasoning')
  })

  it('does not replay encrypted reasoning through a different provider registration route', async () => {
    const firstAdapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(completedReasoningEvents()) })
    const prior = await assistantFromResponse(firstAdapter)
    const bodies: Record<string, unknown>[] = []
    const secondAdapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => { bodies.push(body) }),
    })

    await collect(secondAdapter, options({
      provider: 'chatgpt-other',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'First question.' }] },
        prior,
        { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      ],
    }))

    expect(JSON.stringify(bodies[0]?.input)).not.toContain('opaque-encrypted-reasoning')
  })

  it('keeps historical tool additions in input order', async () => {
    const baselineTool = { name: 'base_lookup', description: 'Look up a base record.', parameters: { type: 'object' } }
    const addedTool = { name: 'extra_lookup', description: 'Look up an extra record.', parameters: { type: 'object' } }
    const update = createDeveloperMessage({
      source: { kind: 'system-prompt' },
      content: [{ type: 'tool-addition', toolName: addedTool.name }],
    })
    let capturedBody: Record<string, unknown> | undefined
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: eventFetch(completedTextEvents('Done.'), (_request, body) => { capturedBody = body }),
    })

    await collect(adapter, options({
      messages: [createSystemMessage('Context.'), { role: 'user', content: [{ type: 'text', text: 'Go.' }] }, update],
      tools: [baselineTool, addedTool],
      toolHistory: { tools: [baselineTool], updates: [{ messageId: update.id, additions: [addedTool] }] },
    }))

    const input = capturedBody?.input as Array<Record<string, unknown>>
    expect(input.filter(item => item.type === 'additional_tools').map(item => item.tools)).toEqual([
      [{ type: 'function', name: baselineTool.name, description: baselineTool.description, parameters: baselineTool.parameters, strict: false }],
      [{ type: 'function', name: addedTool.name, description: addedTool.description, parameters: addedTool.parameters, strict: false }],
    ])
    expect(input.map(item => item.type)).toEqual(['additional_tools', 'message', 'message', 'additional_tools'])
  })

  it('maps function-call argument events to a DSH tool-call block', async () => {
    const output = {
      id: 'fc_item_1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"term":"moon"}',
    }
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { ...output, status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: output.id,
        output_index: 0,
        sequence_number: 2,
        delta: '{"term":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: output.id,
        output_index: 0,
        sequence_number: 3,
        delta: '"moon"}',
      },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 4, item: output },
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          id: 'resp_tools',
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          output: [output],
          model: officialModel.id,
          usage: null,
        },
      },
    ]
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(events) })

    const chunks = await collect(adapter, options())
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'tool-call-delta',
      id: 'call_1',
      name: 'lookup',
      argumentsDelta: '',
    }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', argumentsDelta: '{"term":' }))
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end',
      block: { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"term":"moon"}' },
    }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('keeps the exact SIWC subscription limit code and request id', async () => {
    const failed = {
      type: 'response.failed',
      sequence_number: 1,
      response: {
        id: 'resp_failed',
        object: 'response',
        created_at: 1,
        status: 'failed',
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          type: 'invalid_request_error',
          message: 'The subscription sharing limit was reached.',
          param: null,
        },
        incomplete_details: null,
        output: [],
        model: officialModel.id,
        usage: null,
      },
    }
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch([failed]) })

    await expect(collect(adapter, options())).rejects.toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
      failure: { requestId: 'req_123' },
    })
  })

  it('does not infer a subscription limit from HTTP 402 alone', async () => {
    const adapter = new ChatGptResponsesAdapter(hostFor(), {
      fetch: async () => new Response(JSON.stringify({ error: { message: 'Account request refused', code: null } }), {
        status: 402,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_402' },
      }),
    })

    const error = await collect(adapter, options()).catch(value => value)
    expect(error).toMatchObject({
      code: 'OPENAI_RESPONSES_ERROR',
      failure: { status: 402, requestId: 'req_402' },
    })
    expect(error).toHaveProperty('message', expect.stringContaining('Account request refused'))
  })

  it('requires response.completed for success', async () => {
    const partial = completedTextEvents('Hello.').slice(0, 3)
    const adapter = new ChatGptResponsesAdapter(hostFor(), { fetch: eventFetch(partial) })

    await expect(collect(adapter, options())).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('aborts an in-flight request when the host revokes the account grant', async () => {
    const controller = new AbortController()
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const adapter = new ChatGptResponsesAdapter(hostFor(controller.signal), {
      fetch: async (_input, init) => {
        notifyStarted?.()
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    const pending = collect(adapter, options())
    await started
    controller.abort(new Error('account signed out'))

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('advertises the seven exact official model capabilities without an output-token default', () => {
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.id)).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.contextWindow)).toEqual(Array(7).fill(1_050_000))
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.maxOutputTokens)).toEqual(Array(7).fill(128_000))
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.inputModalities)).toEqual(Array(7).fill(['text', 'image']))
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.reasoningEfforts.map(String))).toEqual([
      ['low', 'medium', 'high', 'xhigh', 'max'],
      ['low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    ])
    expect(OFFICIAL_OPENAI_MODELS.map(item => item.defaultReasoningEffort === undefined ? undefined : String(item.defaultReasoningEffort))).toEqual([
      undefined, 'medium', 'medium', 'medium', 'medium', 'medium', 'medium',
    ])
    expect(OFFICIAL_OPENAI_MODELS.map(item => {
      const resolved = toOpenAiResolvedModelInfo(provider, item)
      return resolved.reasoning?.defaultEffort === undefined ? undefined : String(resolved.reasoning.defaultEffort)
    })).toEqual([undefined, 'medium', 'medium', 'medium', 'medium', 'medium', 'medium'])
    expect(OFFICIAL_OPENAI_MODELS.every(item => !('defaultMaxTokens' in toOpenAiResolvedModelInfo(provider, item)))).toBe(true)
    expect(model.context?.contextWindow).toBe(1_050_000)
    expect(model.toolUpdate).toBe('addition-only')
    expect(model).not.toHaveProperty('defaultMaxTokens')
  })

  it('binds host catalog models to the adapter provider route', async () => {
    const adapter = new ChatGptResponsesAdapter({
      ...hostFor(),
      listModels: async () => [{ provider: 'host-placeholder', id: officialModel.id, name: officialModel.name }],
    })

    await expect(adapter.listModels(provider)).resolves.toEqual([
      { provider, id: officialModel.id, name: officialModel.name },
    ])
  })

  it('refuses exact routes without a known context cap', async () => {
    const unconfigured: LlmResolvedModelInfo = { provider, id: 'unconfigured-model', name: 'Unknown model' }
    const adapter = new ChatGptResponsesAdapter({
      ...hostFor(),
      resolveModel: async () => unconfigured,
    })

    await expect(adapter.resolveModel(provider, unconfigured.id)).rejects.toMatchObject({
      code: 'MODEL_CONTEXT_REQUIRED',
    })
  })
})

async function assistantFromResponse(adapter: ChatGptResponsesAdapter) {
  const chunks = await collect(adapter, options())
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.message({ provider, model: officialModel.id, replayState: assembler.replayState })
}
