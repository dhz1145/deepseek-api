import type { ChatApiFormat } from './chatConfig.js'
import type {
  AssistantBlockParam,
  CreateMessageRequest,
  MessageParam,
  MessageUsage,
  StopReason,
  UserBlockParam,
} from './types.js'

type OpenAIFormat = Exclude<ChatApiFormat, 'messages'>

const userPart = (format: OpenAIFormat, block: UserBlockParam, deepSeek: boolean) => {
  if (block.type === 'text') {
    return { type: format === 'chat' ? 'text' : 'input_text', text: block.text }
  }
  const { source } = block
  if (source.type === 'file') {
    if (!deepSeek) {
      return null
    }
    const type = format === 'chat' ? 'file' : block.type === 'image' ? 'input_image' : 'input_file'
    return { type, file_id: source.file_id }
  }
  const url = `data:${source.media_type};base64,${source.data}`
  if (block.type === 'image') {
    return format === 'chat'
      ? { type: 'image_url', image_url: { url } }
      : { type: 'input_image', image_url: url, detail: 'auto' }
  }
  if (!('title' in block)) {
    return null
  }
  const file = { filename: block.title, file_data: url }
  return format === 'chat' ? { type: 'file', file } : { type: 'input_file', ...file }
}

/** Preserve the signed page item that DeepSeek needs to read this link again in later turns. */
const responseReadLinks = (blocks: AssistantBlockParam[]) => {
  const links = new Map(
    blocks.flatMap((block) =>
      block.type === 'server_tool_use' && block.input.action === 'read_link'
        ? [[block.id, block.input.url] as const]
        : []
    )
  )
  return blocks.flatMap((block) => {
    if (
      block.type !== 'web_fetch_tool_result' ||
      block.kind !== 'read_link' ||
      block.content.type !== 'web_fetch_result' ||
      !block.signature ||
      !links.has(block.tool_use_id)
    ) {
      return []
    }
    const { url, published_at, content } = block.content
    return [
      {
        type: 'web_search_call',
        id: block.tool_use_id,
        status: 'completed',
        kind: 'read_link',
        action: { type: 'open_page', url: links.get(block.tool_use_id) || url },
        ...(url ? { page: { url, title: content.title, published_at } } : {}),
        signature: block.signature,
      },
    ]
  })
}

export const openAIRequest = (
  format: OpenAIFormat,
  body: CreateMessageRequest,
  deepSeek: boolean,
  effort: string | undefined,
  optional: { summary?: boolean; sources?: boolean } = { summary: true, sources: true }
) => {
  type InputMessage = {
    role: MessageParam['role']
    content: string | NonNullable<ReturnType<typeof userPart>>[]
    prefix?: true
    reasoning_content?: string
    server_tool_calls?: unknown[]
  }
  const messages = body.messages.flatMap<
    InputMessage | ReturnType<typeof responseReadLinks>[number]
  >(({ role, content }, index) => {
    if (role === 'latest_reminder') {
      return deepSeek && format === 'chat' ? [{ role, content }] : []
    }
    if (typeof content === 'string') {
      return [{ role, content }]
    }
    if (role === 'assistant') {
      const links = format === 'responses' && deepSeek ? responseReadLinks(content) : []
      const text = content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
      if (format === 'chat' && deepSeek) {
        if (body.prefix && index === body.messages.length - 1) {
          const reasoning = content
            .flatMap((block) => (block.type === 'thinking' ? [block.thinking] : []))
            .join('')
          return [
            {
              role,
              content: text,
              prefix: true,
              ...(reasoning && body.thinking.type === 'enabled'
                ? { reasoning_content: reasoning }
                : {}),
            },
          ]
        }
        // The Chat Completions variant groups signed link calls inside the assistant message.
        const calls = responseReadLinks(content).map(({ action, ...link }, index) => ({
          ...link,
          index,
          type: 'deepseek_read_url',
          action: { ...action, type: 'read_link' },
        }))
        return text || calls.length
          ? [
              {
                role,
                content: text,
                ...(calls.length
                  ? { server_tool_calls: [{ index: 0, reasoning_content: '', calls }] }
                  : {}),
              },
            ]
          : []
      }
      return text ? [...links, { role, content: text }] : links
    }
    const parts = content
      .map((block) => userPart(format, block, deepSeek))
      .filter((part) => part !== null)
    return parts.length ? [{ role, content: parts }] : []
  })

  const common = {
    model: body.model,
    stream: true,
    ...(deepSeek
      ? {
          safety_check: body.safety_check,
          title: body.title,
          tools: body.tools?.map(({ type }) => ({ type })),
        }
      : {}),
  }
  const thinkingEnabled = body.thinking.type === 'enabled'
  const selectedEffort = thinkingEnabled ? effort : undefined
  const includeSummary = !deepSeek && thinkingEnabled && selectedEffort !== 'none' && optional.summary
  if (format === 'chat') {
    return {
      ...common,
      messages: body.system ? [{ role: 'system', content: body.system }, ...messages] : messages,
      ...(deepSeek
        ? {
            max_tokens: body.max_tokens,
            thinking: body.thinking,
            reasoning_effort: selectedEffort,
          }
        : {
            max_completion_tokens: body.max_tokens,
            reasoning_effort: selectedEffort,
            ...(body.tools?.some(({ type }) => type === 'deepseek_web_search')
              ? { web_search_options: {} }
              : {}),
          }),
    }
  }
  return {
    ...common,
    input: messages,
    instructions: body.system || undefined,
    max_output_tokens: body.max_tokens,
    reasoning:
      deepSeek && !thinkingEnabled
        ? { effort: 'none' }
        : selectedEffort || includeSummary
          ? { effort: selectedEffort, ...(includeSummary ? { summary: 'auto' } : {}) }
          : undefined,
    ...(!deepSeek && body.tools?.some(({ type }) => type === 'deepseek_web_search')
      ? {
          tools: [{ type: 'web_search' }],
          ...(optional.sources ? { include: ['web_search_call.action.sources'] } : {}),
        }
      : {}),
    store: false,
  }
}

export type OpenAIFrame = {
  text?: string
  thinking?: string
  stop?: StopReason
  done?: boolean
  usage?: MessageUsage
  title?: string
  error?: { message: string; code?: string }
}

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

export const asString = (value: unknown) => (typeof value === 'string' ? value : undefined)

const openAIUsage = (value: unknown, format: OpenAIFormat): MessageUsage | undefined => {
  const usage = record(value)
  const input = format === 'chat' ? usage.prompt_tokens : usage.input_tokens
  const output = format === 'chat' ? usage.completion_tokens : usage.output_tokens
  const details = format === 'chat' ? usage.prompt_tokens_details : usage.input_tokens_details
  const cached = record(details).cached_tokens
  if (typeof input !== 'number' || typeof output !== 'number') {
    return
  }
  const cache = typeof cached === 'number' ? cached : 0
  return {
    input_tokens: Math.max(0, input - cache),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cache,
    output_tokens: output,
  }
}

const stopReasons: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

export const firstChatChoice = (payload: Record<string, unknown>) =>
  record(Array.isArray(payload.choices) ? payload.choices[0] : null)

const readChatChunk = (payload: Record<string, unknown>): OpenAIFrame => {
  const choice = firstChatChoice(payload)
  const delta = record(choice.delta ?? choice.message)
  const finish = asString(choice.finish_reason)
  const error = record(payload.error)
  const message = asString(error.message)
  return {
    error: message ? { message, code: asString(error.code) } : undefined,
    text: asString(delta.content) ?? asString(delta.refusal),
    thinking: asString(delta.reasoning_content) ?? asString(delta.reasoning),
    stop: finish && Object.hasOwn(stopReasons, finish) ? stopReasons[finish] : undefined,
    usage: openAIUsage(payload.usage, 'chat'),
    title: asString(delta.title),
  }
}

const readResponseEvent = (payload: Record<string, unknown>): OpenAIFrame => {
  const response = record(payload.response)
  switch (payload.type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return { text: asString(payload.delta) }
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return { thinking: asString(payload.delta) }
    case 'response.completed':
      return {
        done: true,
        stop: 'end_turn',
        usage: openAIUsage(response.usage, 'responses'),
        title: asString(response.title),
      }
    case 'response.incomplete': {
      const reason = record(response.incomplete_details).reason
      return {
        done: true,
        stop: reason === 'content_filter' ? 'refusal' : 'max_tokens',
        usage: openAIUsage(response.usage, 'responses'),
        title: asString(response.title),
      }
    }
    case 'response.failed':
    case 'error': {
      const error = payload.type === 'error' ? payload : record(response.error)
      return {
        error: { message: asString(error.message) ?? '', code: asString(error.code) },
      }
    }
    default:
      return {}
  }
}

export const readOpenAIFrame = (format: OpenAIFormat, payload: unknown): OpenAIFrame =>
  format === 'chat' ? readChatChunk(record(payload)) : readResponseEvent(record(payload))
