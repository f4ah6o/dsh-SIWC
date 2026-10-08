/** ChatGPT Sign in with ChatGPT adapter for the OpenAI Responses API. */

import {
  APIError,
  OpenAI,
  type ClientOptions,
} from 'openai'
import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseInput,
  ResponseInputContent,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses'
import {
  attributionHeaders,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  RequestMessage,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { fileHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ChatGptAdapterHost, ChatGptPreparedCall } from './adapter-contract.js'

/** OpenAI API base URL for OAuth tokens exchanged through Sign in with ChatGPT. */
export const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1'

/** Dependencies replaceable by tests without changing the upstream request API. */
export interface ChatGptResponsesAdapterOptions {
  /** Optional SDK transport for deterministic request tests. */
  fetch?: ClientOptions['fetch']
}

interface StreamBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning' | 'tool-call'
  text: string
  toolCallId?: ReturnType<typeof ToolCallId>
  toolName?: string
  arguments?: string
  started: boolean
  closed: boolean
}

interface ReplayScope {
  readonly provider: string
  readonly model: string
  readonly accountId: string
}

type ResponsesReasoningEffort = NonNullable<NonNullable<ResponseCreateParamsStreaming['reasoning']>['effort']>

/** Stream OpenAI Responses calls through one host-pinned account and token. */
export class ChatGptResponsesAdapter extends LlmAdapter {
  private readonly host: ChatGptAdapterHost
  private readonly fetch?: ClientOptions['fetch']

  /** @param host - account/token/model controller for one adapter registration. @param options - SDK transport overrides for tests. */
  constructor(host: ChatGptAdapterHost, options: ChatGptResponsesAdapterOptions = {}) {
    super()
    this.host = host
    this.fetch = options.fetch
  }

  /** @returns the host's account-admitted model catalog for this provider route. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.host.listModels()).map(model => ({ ...model, provider }))
  }

  /** @returns exact model metadata with a required known context capacity. */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return exactModel(provider, model, await this.host.resolveModel(model, signal))
  }

  /** Bind model metadata and credentials to the same host generation as streaming. */
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const prepared = await this.host.prepareCall(model, signal)
    const metadata = exactModel(provider, model, prepared.model)
    validatePreparedCall(prepared)
    return {
      model: metadata,
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => this.streamPrepared(options, prepared),
    }
  }

  /** Resolve the current prepared credentials for direct adapter calls. */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    assertSupportedOptions(options)
    const prepared = await this.host.prepareCall(options.model, options.signal)
    yield* this.streamPrepared(options, prepared)
  }

  private async *streamPrepared(
    options: GenerateOptions,
    prepared: ChatGptPreparedCall,
  ): AsyncGenerator<StreamChunk> {
    assertSupportedOptions(options)
    validatePreparedCall(prepared)
    const model = exactModel(options.provider, options.model, prepared.model)
    assertReasoningEffort(options, model)
    const signal = options.signal === undefined
      ? prepared.accountSignal
      : AbortSignal.any([prepared.accountSignal, options.signal])
    if (signal.aborted) {
      throw new LlmError('ChatGPT account request was aborted', 'ABORTED', { cause: signal.reason })
    }
    let requestId: string | undefined
    try {
      const replayScope = {
        provider: options.provider,
        model: model.id,
        accountId: String(prepared.accountId),
      } satisfies ReplayScope
      const request = await createRequest(options, model, this.host, signal, replayScope)
      const sdk = new OpenAI({
        apiKey: prepared.accessToken,
        baseURL: OPENAI_RESPONSES_BASE_URL,
        maxRetries: 0,
        timeout: prepared.requestTimeoutMs,
        defaultHeaders: attributionHeaders(),
        ...(this.fetch === undefined ? {} : { fetch: this.fetch }),
      })
      const { data: events, request_id } = await sdk.responses.create(request, {
        signal,
      }).withResponse()
      requestId = request_id ?? undefined
      yield* translateEvents(events, requestId, replayScope)
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new LlmError('ChatGPT account request was aborted', 'ABORTED', {
          cause: signal.reason,
          ...(requestId === undefined ? {} : { requestId: ProviderRequestId(requestId) }),
        })
      }
      throw normalizeError(error, requestId)
    }
  }
}

function validatePreparedCall(prepared: ChatGptPreparedCall): void {
  if (prepared.accessToken.length === 0) {
    throw new LlmError('ChatGPT host prepared an empty Responses access token', 'INVALID_CREDENTIAL')
  }
  if (!Number.isFinite(prepared.requestTimeoutMs) || prepared.requestTimeoutMs <= 0) {
    throw new LlmError('ChatGPT host prepared an invalid request timeout', 'INVALID_REQUEST_TIMEOUT')
  }
}

function exactModel(provider: string, model: string, info: LlmResolvedModelInfo): LlmResolvedModelInfo {
  if (info.id !== model) {
    throw new LlmError(`ChatGPT host resolved "${info.id}" for requested model "${model}"`, 'MODEL_ID_MISMATCH')
  }
  const contextWindow = info.context?.contextWindow
  if (!Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0) {
    throw new LlmError(
      `ChatGPT model "${model}" needs an official or configured context-window limit`,
      'MODEL_CONTEXT_REQUIRED',
    )
  }
  const { defaultMaxTokens: _defaultMaxTokens, toolUpdate, ...resolved } = info
  return {
    ...resolved,
    provider,
    id: model,
    ...(toolUpdate === 'addition-only' ? { toolUpdate } : {}),
  }
}

function assertSupportedOptions(options: GenerateOptions): void {
  const auxiliaryPurpose = options.purpose === 'session-title' || options.purpose === 'compaction'
  if (options.maxTokens !== undefined && !auxiliaryPurpose) {
    throw new LlmError('Sign in with ChatGPT Responses does not accept GenerateOptions.maxTokens', 'UNSUPPORTED_PARAMETER')
  }
  if (options.temperature !== undefined) {
    throw new LlmError('Sign in with ChatGPT Responses does not accept GenerateOptions.temperature', 'UNSUPPORTED_PARAMETER')
  }
  if (options.stop !== undefined) {
    throw new LlmError('The Responses API does not accept GenerateOptions.stop', 'UNSUPPORTED_PARAMETER')
  }
}

function assertReasoningEffort(options: GenerateOptions, model: LlmResolvedModelInfo): void {
  if (options.reasoningEffort === undefined) return
  const selected = String(options.reasoningEffort)
  const supported = model.reasoning?.efforts.some(effort => effort.id === options.reasoningEffort) ?? false
  if (!supported) {
    throw new LlmError(
      `ChatGPT model "${model.id}" does not declare reasoning effort "${selected}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (!isResponsesReasoningEffort(selected)) {
    throw new LlmError(`OpenAI Responses does not accept reasoning effort "${selected}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }
}

function isResponsesReasoningEffort(value: string): value is ResponsesReasoningEffort {
  return value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
}

async function createRequest(
  options: GenerateOptions,
  model: LlmResolvedModelInfo,
  host: ChatGptAdapterHost,
  signal: AbortSignal,
  replayScope: ReplayScope,
): Promise<ResponseCreateParamsStreaming> {
  const { instructions, input } = await createInput(options, model, host, signal, replayScope)
  const effort = options.reasoningEffort
  return {
    model: model.id,
    input,
    store: false,
    stream: true,
    ...(instructions === undefined ? {} : { instructions }),
    ...(effort === undefined ? {} : { reasoning: { effort: responsesReasoningEffort(String(effort)) } }),
  }
}

function responsesReasoningEffort(value: string): ResponsesReasoningEffort {
  if (isResponsesReasoningEffort(value)) return value
  throw new LlmError(`OpenAI Responses does not accept reasoning effort "${value}"`, 'UNSUPPORTED_REASONING_EFFORT')
}

async function createInput(
  options: GenerateOptions,
  model: LlmResolvedModelInfo,
  host: ChatGptAdapterHost,
  signal: AbortSignal,
  replayScope: ReplayScope,
): Promise<{ instructions?: string; input: ResponseInput }> {
  const input: ResponseInput = []
  const history = options.toolHistory
  const supportsAdditionalTools = model.toolUpdate === 'addition-only'
  const hasCompleteToolHistory = supportsAdditionalTools && history !== undefined
    && !history.updates.some(update => !options.messages.some(message => message.role === 'developer' && message.id === update.messageId))
  const currentTools = new Map((options.tools ?? []).map(tool => [tool.name, tool]))
  const definitions = new Map<string, ToolSchema>()
  if (history !== undefined) {
    for (const tool of history.tools) definitions.set(tool.name, tool)
    for (const update of history.updates) {
      for (const tool of update.additions) definitions.set(tool.name, tool)
    }
  }
  for (const tool of options.tools ?? []) definitions.set(tool.name, tool)

  if (!hasCompleteToolHistory) {
    appendAdditionalTools(input, options.tools ?? [])
  } else {
    const baseline = (history?.tools ?? []).filter(tool => !tool.deferLoading && currentTools.has(tool.name))
    appendAdditionalTools(input, baseline)
  }

  for (const message of options.messages) {
    await appendMessage(input, message, host, signal, {
      currentTools,
      definitions,
      history,
      supportsAdditionalTools,
      hasCompleteToolHistory,
      replayScope,
    })
  }
  return { ...(options.system === undefined ? {} : { instructions: options.system }), input }
}

interface ToolInputState {
  readonly currentTools: ReadonlyMap<string, ToolSchema>
  readonly definitions: ReadonlyMap<string, ToolSchema>
  readonly history: GenerateOptions['toolHistory']
  readonly supportsAdditionalTools: boolean
  readonly hasCompleteToolHistory: boolean
  readonly replayScope: ReplayScope
}

async function appendMessage(
  input: ResponseInput,
  message: RequestMessage,
  host: ChatGptAdapterHost,
  signal: AbortSignal | undefined,
  toolState: ToolInputState,
): Promise<void> {
  if (message.role === 'assistant') {
    const replayItems = readReplayItems(message.source.replayState, message.source.provider, message.source.model, toolState.replayScope)
    if (replayItems !== undefined) {
      input.push(...replayItems)
      return
    }
  }

  if (message.role === 'tool') {
    const output = await blocksToInput(message.content, host, signal)
    const contents = message.isError ? [{ type: 'input_text' as const, text: 'Tool execution failed.' }, ...output] : output
    input.push({
      type: 'function_call_output',
      call_id: String(message.toolCallId),
      output: contents.length === 1 && contents[0]?.type === 'input_text'
        ? (contents[0].text ?? '')
        : contents,
    })
    return
  }

  const role = message.role === 'system' ? 'developer' : message.role
  let content: ResponseInputContent[] = []
  const flush = (): void => {
    if (content.length === 0) return
    input.push({ type: 'message', role, content })
    content = []
  }

  for (const block of message.content) {
    if (block.type === 'tool-call') {
      flush()
      input.push({
        type: 'function_call',
        call_id: String(block.id),
        name: block.name,
        arguments: block.arguments,
      })
      continue
    }
    if (block.type === 'tool-addition') {
      flush()
      if (toolState.supportsAdditionalTools && toolState.hasCompleteToolHistory && toolState.currentTools.has(block.toolName)) {
        const historical = toolState.history?.updates
          .find(update => update.messageId === message.id)?.additions
          .find(tool => tool.name === block.toolName)
        const definition = historical ?? toolState.definitions.get(block.toolName)
        if (definition !== undefined) appendAdditionalTools(input, [definition])
      }
      continue
    }
    if (block.type === 'tool-removal') continue
    content.push(...await blockToInput(block, host, signal))
  }

  flush()
  if (message.content.length === 0) input.push({ type: 'message', role, content: '' })
}

function appendAdditionalTools(input: ResponseInput, tools: readonly ToolSchema[]): void {
  if (tools.length === 0) return
  input.push({
    type: 'additional_tools',
    role: 'developer',
    tools: tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    })),
  })
}

async function blocksToInput(
  blocks: readonly ContentBlock[],
  host: ChatGptAdapterHost,
  signal?: AbortSignal,
): Promise<ResponseInputContent[]> {
  const result: ResponseInputContent[] = []
  for (const block of blocks) result.push(...await blockToInput(block, host, signal))
  return result
}

async function blockToInput(
  block: ContentBlock,
  host: ChatGptAdapterHost,
  signal?: AbortSignal,
): Promise<ResponseInputContent[]> {
  switch (block.type) {
    case 'text':
      return [{ type: 'input_text', text: block.text }]
    case 'reasoning':
      return [{ type: 'input_text', text: block.text }]
    case 'image': {
      if (block.offloaded) return [{ type: 'input_text', text: textOnlyImageText(block.attachment) }]
      const image = await host.readImage(block.attachment, signal)
      const data = Buffer.from(image.data).toString('base64')
      return [{
        type: 'input_image',
        detail: 'auto',
        image_url: `data:${image.ref.mediaType};base64,${data}`,
      }]
    }
    case 'file':
      return [{ type: 'input_text', text: fileHandleText(block.attachment, undefined) }]
    case 'tool-call':
      throw new LlmError('Tool result content cannot contain a tool call', 'UNSUPPORTED_CONTENT')
    case 'tool-addition':
    case 'tool-removal':
      throw new LlmError(`Tool result content cannot contain "${block.type}"`, 'UNSUPPORTED_CONTENT')
    default:
      throw new LlmError('OpenAI Responses cannot encode an unsupported content block', 'UNSUPPORTED_CONTENT')
  }
}

async function* translateEvents(
  events: AsyncIterable<ResponseStreamEvent>,
  requestId: string | undefined,
  replayScope: ReplayScope,
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<string, StreamBlock>()
  const blocksByItemId = new Map<string, StreamBlock>()
  let nextIndex = 0
  let completed = false
  const completedOutputItems = new Map<number, ResponseInputItem>()

  const start = (key: string, type: StreamBlock['type'], itemId?: string): StreamBlock => {
    let block = blocks.get(key)
    if (block !== undefined) return block
    block = { index: nextIndex++, type, text: '', started: false, closed: false }
    blocks.set(key, block)
    if (itemId !== undefined) blocksByItemId.set(itemId, block)
    return block
  }

  const close = (block: StreamBlock, final?: string): StreamChunk | undefined => {
    if (block.closed) return undefined
    block.closed = true
    if (block.type === 'text') {
      if (final !== undefined) block.text = final
      return { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
    }
    if (block.type === 'reasoning') {
      if (final !== undefined) block.text = final
      return { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
    }
    if (final !== undefined) block.arguments = final
    return {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: block.toolCallId ?? ToolCallId(`call-${block.index}`),
        name: block.toolName ?? '',
        arguments: block.arguments ?? '',
      },
    }
  }

  const fail = (detail: unknown, id = requestId): never => {
    throw normalizeError(detail, id)
  }

  for await (const event of events) {
    switch (event.type) {
      case 'response.output_item.added': {
        if (event.item.type !== 'function_call') break
        const itemId = event.item.id ?? event.item.call_id
        const block = start(`tool:${itemId}`, 'tool-call', itemId)
        block.toolCallId = ToolCallId(event.item.call_id)
        block.toolName = event.item.name
        block.arguments = ''
        block.started = true
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: block.index, id: block.toolCallId, name: block.toolName, argumentsDelta: '' }
        break
      }
      case 'response.output_text.delta': {
        const block = start(`text:${event.item_id}:${event.content_index}`, 'text', event.item_id)
        if (block.closed) break
        if (!block.started) {
          block.started = true
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += event.delta
        yield { type: 'text-delta', index: block.index, text: event.delta }
        break
      }
      case 'response.refusal.delta': {
        const block = start(`refusal:${event.item_id}:${event.content_index}`, 'text', event.item_id)
        if (block.closed) break
        if (!block.started) {
          block.started = true
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += event.delta
        yield { type: 'text-delta', index: block.index, text: event.delta }
        break
      }
      case 'response.reasoning_summary_text.delta': {
        const block = start(`summary:${event.item_id}:${event.summary_index}`, 'reasoning', event.item_id)
        if (block.closed) break
        if (!block.started) {
          block.started = true
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += event.delta
        yield { type: 'reasoning-delta', index: block.index, text: event.delta }
        break
      }
      case 'response.reasoning_text.delta': {
        const block = start(`reasoning:${event.item_id}:${event.content_index}`, 'reasoning', event.item_id)
        if (block.closed) break
        if (!block.started) {
          block.started = true
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += event.delta
        yield { type: 'reasoning-delta', index: block.index, text: event.delta }
        break
      }
      case 'response.function_call_arguments.delta': {
        const block = blocksByItemId.get(event.item_id)
        if (block === undefined || block.type !== 'tool-call' || block.closed) {
          throw new LlmError('OpenAI Responses sent tool arguments before the function item', 'MALFORMED_RESPONSE')
        }
        block.arguments = (block.arguments ?? '') + event.delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.toolCallId ?? ToolCallId(''),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'response.output_item.done': {
        const item = event.item
        const replayItem = replayableOutputItem(item)
        if (replayItem !== undefined) completedOutputItems.set(event.output_index, replayItem)
        if (item.type === 'function_call') {
          const itemId = item.id ?? item.call_id
          let block = blocksByItemId.get(itemId)
          if (block === undefined) {
            block = start(`tool:${itemId}`, 'tool-call', itemId)
            block.toolCallId = ToolCallId(item.call_id)
            block.toolName = item.name
            block.started = true
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: block.index, id: block.toolCallId, name: item.name, argumentsDelta: '' }
          }
          block.toolCallId = ToolCallId(item.call_id)
          block.toolName = item.name
          const end = close(block, item.arguments)
          if (end !== undefined) yield end
          break
        }
        if (item.type === 'message') {
          for (const [contentIndex, part] of (item.content ?? []).entries()) {
            if (part.type === 'output_text') {
              const block = blocks.get(`text:${item.id}:${contentIndex}`)
              if (block !== undefined) {
                if (!block.started) {
                  block.started = true
                  yield { type: 'block-start', index: block.index, blockType: 'text' }
                }
                const end = close(block, part.text)
                if (end !== undefined) yield end
              } else {
                const created = start(`text:${item.id}:${contentIndex}`, 'text', item.id)
                created.started = true
                yield { type: 'block-start', index: created.index, blockType: 'text' }
                const end = close(created, part.text)
                if (end !== undefined) yield end
              }
            } else if (part.type === 'refusal') {
              const block = blocks.get(`refusal:${item.id}:${contentIndex}`)
              if (block !== undefined) {
                if (!block.started) {
                  block.started = true
                  yield { type: 'block-start', index: block.index, blockType: 'text' }
                }
                const end = close(block, part.refusal)
                if (end !== undefined) yield end
              } else {
                const created = start(`refusal:${item.id}:${contentIndex}`, 'text', item.id)
                created.started = true
                yield { type: 'block-start', index: created.index, blockType: 'text' }
                const end = close(created, part.refusal)
                if (end !== undefined) yield end
              }
            }
          }
          break
        }
        if (item.type === 'reasoning') {
          for (const [summaryIndex, part] of item.summary.entries()) {
            if (part.type !== 'summary_text') continue
            const key = `summary:${item.id}:${summaryIndex}`
            const block = blocks.get(key) ?? start(key, 'reasoning', item.id)
            if (!block.started) {
              block.started = true
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            const end = close(block, part.text)
            if (end !== undefined) yield end
          }
          for (const [contentIndex, part] of (item.content ?? []).entries()) {
            if (part.type !== 'reasoning_text') continue
            const key = `reasoning:${item.id}:${contentIndex}`
            const block = blocks.get(key) ?? start(key, 'reasoning', item.id)
            if (!block.started) {
              block.started = true
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            const end = close(block, part.text)
            if (end !== undefined) yield end
          }
        }
        break
      }
      case 'response.completed': {
        if (event.response.status !== 'completed') {
          fail(new LlmError(`OpenAI Responses emitted completed with status "${event.response.status}"`, 'MALFORMED_RESPONSE'))
        }
        for (const block of blocks.values()) {
          const end = close(block)
          if (end !== undefined) yield end
        }
        if (blocks.size === 0) throw new LlmError(`OpenAI model "${replayScope.model}" returned no content`, 'EMPTY_RESPONSE')
        const replayItems = event.response.output.map((item, index) =>
          completedOutputItems.get(index) ?? replayableOutputItem(item))
        if (replayItems.length === 0 || replayItems.some(item => item === undefined)) {
          throw new LlmError('OpenAI Responses returned an output item that cannot be replayed with store:false', 'UNSUPPORTED_CONTENT')
        }
        const usage = mapUsage(event.response.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
        const hadToolCall = event.response.output.some(item => item.type === 'function_call')
        yield {
          type: 'finish',
          reason: hadToolCall ? { kind: 'tool-calls' } : { kind: 'stop' },
          replayState: {
            response: {
              adapter: 'openai-responses-v1',
              provider: replayScope.provider,
              accountId: replayScope.accountId,
              ...(requestId === undefined ? {} : { requestId }),
              id: event.response.id,
              model: event.response.model,
              status: event.response.status,
              output: replayItems,
            },
          },
        }
        completed = true
        return
      }
      case 'response.failed': {
        throw responseEventError(event.response.error ?? event, requestId)
      }
      case 'response.incomplete': {
        throw responseEventError(event.response.incomplete_details ?? event, requestId, 'INCOMPLETE_RESPONSE')
      }
      case 'error': {
        throw responseEventError(event, requestId)
      }
      default:
        break
    }
  }

  if (!completed) throw new LlmError('OpenAI Responses stream ended before response.completed', 'STREAM_CLOSED')
}

function replayableOutputItem(item: ResponseOutputItem): ResponseInputItem | undefined {
  if (item.type === 'message' || item.type === 'function_call' || item.type === 'reasoning') return item
  return undefined
}

function readReplayItems(
  replayState: unknown,
  provider: string,
  model: string,
  scope: ReplayScope,
): readonly ResponseInputItem[] | undefined {
  if (!isRecord(replayState) || !isRecord(replayState.response)) return undefined
  const response = replayState.response
  if (response.adapter !== 'openai-responses-v1'
    || response.provider !== scope.provider
    || provider !== scope.provider
    || response.accountId !== scope.accountId
    || response.model !== scope.model
    || model !== scope.model
    || !Array.isArray(response.output)
    || !response.output.every(isReplayInputItem)) return undefined
  return response.output
}

function isReplayInputItem(value: unknown): value is ResponseInputItem {
  if (!isRecord(value)) return false
  if (value.type === 'reasoning') return isReasoningInputItem(value)
  if (value.type === 'message') return isAssistantOutputMessage(value)
  if (value.type === 'function_call') {
    return typeof value.call_id === 'string'
      && typeof value.name === 'string'
      && typeof value.arguments === 'string'
      && optionalItemId(value.id)
      && optionalItemStatus(value.status)
  }
  return false
}

function isReasoningInputItem(value: Record<string, unknown>): boolean {
  return value.type === 'reasoning'
    && typeof value.id === 'string'
    && Array.isArray(value.summary)
    && value.summary.every(isReasoningSummary)
    && (value.content === undefined || (Array.isArray(value.content) && value.content.every(isReasoningContent)))
    && (value.encrypted_content === undefined || value.encrypted_content === null || typeof value.encrypted_content === 'string')
    && optionalItemStatus(value.status)
}

function isAssistantOutputMessage(value: Record<string, unknown>): boolean {
  return value.type === 'message'
    && value.role === 'assistant'
    && typeof value.id === 'string'
    && optionalItemStatus(value.status, false)
    && Array.isArray(value.content)
    && value.content.every(isOutputMessageContent)
}

function isReasoningSummary(value: unknown): boolean {
  return isRecord(value) && value.type === 'summary_text' && typeof value.text === 'string'
}

function isReasoningContent(value: unknown): boolean {
  return isRecord(value) && value.type === 'reasoning_text' && typeof value.text === 'string'
}

function isOutputMessageContent(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'output_text') return typeof value.text === 'string'
  return value.type === 'refusal' && typeof value.refusal === 'string'
}

function optionalItemStatus(value: unknown, nullable = true): boolean {
  return value === undefined || (nullable && value === null)
    || value === 'in_progress' || value === 'completed' || value === 'incomplete'
}

function optionalItemId(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mapUsage(usage: ResponseUsage | null | undefined): TokenUsage | undefined {
  if (usage === null || usage === undefined) return undefined
  const inputTokens = readCount(usage.input_tokens)
  const outputTokens = readCount(usage.output_tokens)
  const totalTokens = readCount(usage.total_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cachedTokens = readCount(usage.input_tokens_details.cached_tokens)
  const cacheWriteTokens = readCount(usage.input_tokens_details.cache_write_tokens)
  if (cachedTokens === undefined || cacheWriteTokens === undefined) return undefined
  const reasoningTokens = readCount(usage.output_tokens_details.reasoning_tokens)
  if (cachedTokens + cacheWriteTokens > inputTokens) return undefined
  const aggregateTokens = inputTokens + outputTokens
  const consistentTotal = totalTokens !== undefined
    && Number.isSafeInteger(aggregateTokens)
    && totalTokens === aggregateTokens
  return {
    inputTokens: inputTokens - cachedTokens - cacheWriteTokens,
    outputTokens,
    ...(consistentTotal ? { totalTokens } : {}),
    ...(cachedTokens === 0 ? {} : { cacheReadTokens: cachedTokens }),
    ...(cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined || reasoningTokens === 0 ? {} : { reasoningTokens }),
  }
}

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function normalizeError(error: unknown, fallbackRequestId?: string): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof APIError) {
    const detail = `${error.code ?? ''} ${error.type ?? ''} ${error.message}`
    const code = providerFailureCode(error.code ?? undefined, error.status, detail)
    const id = nonEmpty(error.requestID) ?? nonEmpty(fallbackRequestId)
    const retryAfter = error.headers?.get('retry-after')
    const delay = retryAfterMs(retryAfter)
    return new LlmError(error.message || 'OpenAI Responses request failed', code, {
      cause: error,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(id === undefined ? {} : { requestId: ProviderRequestId(id) }),
      ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
    })
  }
  const message = error instanceof Error && error.message !== ''
    ? error.message
    : 'OpenAI Responses stream failed'
  return new LlmError(message, 'OPENAI_RESPONSES_ERROR', {
    cause: error,
    ...(fallbackRequestId === undefined ? {} : { requestId: ProviderRequestId(fallbackRequestId) }),
  })
}

function responseEventError(
  detail: unknown,
  requestId: string | undefined,
  fallbackCode = 'OPENAI_RESPONSES_ERROR',
): LlmError {
  if (detail instanceof LlmError) return detail
  const parts: string[] = []
  let code: string | undefined
  let type: string | undefined
  if (typeof detail === 'object' && detail !== null) {
    if ('code' in detail && typeof detail.code === 'string') code = detail.code
    if ('type' in detail && typeof detail.type === 'string') type = detail.type
    if ('message' in detail && typeof detail.message === 'string' && detail.message.length > 0) parts.push(detail.message)
    if ('reason' in detail && typeof detail.reason === 'string' && detail.reason.length > 0) parts.push(detail.reason)
  } else if (typeof detail === 'string' && detail.length > 0) {
    parts.push(detail)
  }
  const message = parts.length === 0 ? 'OpenAI Responses stream failed' : parts.join(': ')
  const classified = providerFailureCode(code, undefined, `${code ?? ''} ${type ?? ''} ${message}`)
  const failureCode = classified === 'OPENAI_RESPONSES_ERROR' ? fallbackCode : classified
  return new LlmError(message, failureCode, {
    cause: detail,
    ...(requestId === undefined ? {} : { requestId: ProviderRequestId(requestId) }),
  })
}

function providerFailureCode(code: string | undefined, status: number | undefined, detail: string): string {
  if (code === 'subscription_sharing_usage_limit_exceeded') return code
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 400 || status === 413) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500) return 'SERVER'
  return 'OPENAI_RESPONSES_ERROR'
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function retryAfterMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const delay = /^\d+(?:\.\d+)?$/u.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}
