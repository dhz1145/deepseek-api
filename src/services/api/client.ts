import { throwIfAborted } from '../../utils/abort.js'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import { useSettings } from '../settings.js'
import {
  CHAT_API_PATHS,
  DEFAULT_CHAT_FORMAT,
  DEEP_THINK_EFFORT,
  type ChatApiFormat,
  type ChatConfig,
} from './chatConfig.js'
import { openAIRequest, readOpenAIFrame } from './openaiChat.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { fetchApi } from './transport.js'
import type {
  ApiErrorBody,
  ChatModel,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
export const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    readonly code?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      code = typeof body.error.code === 'string' ? body.error.code : undefined
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetchApi(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

export const getCustomApiBase = (apiKey: string): string | null => {
  const current = useSettings.getState()
  if (!apiKey || apiKey !== current.apiKey) {
    throw new ApiError('http', { key: 'apiKeyInvalid' }, 401)
  }
  return current.apiBaseUrl
}

export const apiRedirect = (customBase: string | null): RequestRedirect =>
  customBase ? 'error' : 'follow'

const anthropicHeaders = (
  apiKey: string,
  beta: boolean,
  customBase: string | null
): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  ...(customBase ? { 'anthropic-version': '2023-06-01' } : {}),
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 获取模型列表，也用同一次请求校验 Key，不发起生成。 */
export const listChatModels = async (
  apiKey: string,
  customBase: string | null,
  signal?: AbortSignal,
  format: ChatApiFormat = DEFAULT_CHAT_FORMAT
): Promise<ChatModel[]> => {
  const url = `${customBase ?? API_ORIGIN}/models`
  const models = new Set<ChatModel>()
  const cursors = new Set<string>()
  let cursor = ''
  for (;;) {
    const response = await request(cursor ? `${url}?after_id=${encodeURIComponent(cursor)}` : url, {
      method: 'GET',
      headers:
        customBase && format === 'messages'
          ? anthropicHeaders(apiKey, false, customBase)
          : { Authorization: `Bearer ${apiKey}` },
      redirect: apiRedirect(customBase),
      signal,
    })
    const payload = (await response.json().catch(() => null)) as {
      data?: ({ id?: unknown } | null)[]
      has_more?: unknown
      last_id?: unknown
    } | null
    if (!Array.isArray(payload?.data)) {
      throw new ApiError('protocol', { key: 'apiModelInvalidList' })
    }
    for (const entry of payload.data) {
      if (typeof entry?.id === 'string' && entry.id.trim()) {
        models.add(entry.id)
      }
    }
    if (!customBase || payload.has_more !== true) {
      return [...models]
    }
    if (typeof payload.last_id !== 'string' || !payload.last_id || cursors.has(payload.last_id)) {
      throw new ApiError('protocol', { key: 'apiModelInvalidList' })
    }
    cursor = payload.last_id
    cursors.add(cursor)
  }
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const customBase = getCustomApiBase(apiKey)
  const response = await request(`${customBase ?? ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true, customBase),
    redirect: apiRedirect(customBase),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (
  apiKey: string,
  fileId: string,
  signal?: AbortSignal
): Promise<void> => {
  const customBase = getCustomApiBase(apiKey)
  const response = await request(
    `${customBase ?? ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`,
    {
      method: 'DELETE',
      signal,
      headers: anthropicHeaders(apiKey, true, customBase),
      redirect: apiRedirect(customBase),
    }
  )
  await response.body?.cancel()
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      message.role === 'user' &&
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type !== 'text' && block.source.type === 'file')
  )

const openMessageStream = (
  apiKey: string,
  customBase: string | null,
  body: CreateMessageRequest,
  signal: AbortSignal
) =>
  request(`${customBase ?? ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    redirect: apiRedirect(customBase),
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body), customBase),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      ...body,
      ...(body.thinking.type === 'enabled' ? { output_config: { effort: DEEP_THINK_EFFORT } } : {}),
      stream: true,
    }),
    signal,
  })

const withDeepSeekExtensionsFallback = (
  body: CreateMessageRequest,
  send: (requestBody: CreateMessageRequest) => Promise<Response>
) =>
  send(body).catch((error: unknown) => {
    if (
      !(body.tools?.length || body.safety_check || body.title?.enabled) ||
      !(error instanceof ApiError) ||
      error.status !== 400 ||
      !/\buser input too long, \d+ tokens exceeds max 32768 tokens\b/i.test(error.message)
    ) {
      throw error
    }
    // 扩展模式在生成前拒绝长输入时，用同一协议的基础模式发送同一上下文。
    return send({ ...body, tools: undefined, safety_check: undefined, title: undefined })
  })

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
async function* streamMessage(
  apiKey: string,
  customBase: string | null,
  body: CreateMessageRequest,
  signal: AbortSignal
) {
  const response = await withDeepSeekExtensionsFallback(body, (requestBody) =>
    openMessageStream(apiKey, customBase, requestBody, signal)
  )
  yield* readAnthropicStream(response, signal)
}

async function* readStreamPayloads(response: Response, signal: AbortSignal) {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.toLowerCase().includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    throwIfAborted(signal)
    if (data === '[DONE]') {
      yield { done: true } as const
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      const { message, code } = payload.error
      throw new ApiError('stream', message, undefined, typeof code === 'string' ? code : undefined)
    }
    if (eventName === 'error' && !payload) {
      throw new ApiError('stream', data)
    }
    yield { done: false, payload, eventName, data } as const
  }
  throwIfAborted(signal)
}

async function* readAnthropicStream(response: Response, signal: AbortSignal) {
  for await (const frame of readStreamPayloads(response, signal)) {
    if (frame.done) {
      break
    }
    const { payload, eventName, data } = frame
    if (eventName === 'error') {
      const detail = payload as { error?: { message?: unknown; type?: unknown } } | null
      const error = detail?.error
      throw new ApiError(
        'stream',
        typeof error?.message === 'string' ? error.message : data,
        undefined,
        typeof error?.type === 'string' ? error.type : undefined
      )
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

export const streamChatMessage = (
  config: ChatConfig,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
) => {
  if (config.format === 'messages') {
    const base = config.endpoint ? config.endpoint.slice(0, -CHAT_API_PATHS.messages.length) : null
    return streamMessage(apiKey, base, body, signal)
  }
  const endpoint = config.endpoint || `${API_ORIGIN}${CHAT_API_PATHS[config.format]}`
  return streamCompatibleMessage(endpoint, config.format, apiKey, body, signal, !config.endpoint)
}

async function* streamCompatibleMessage(
  endpoint: string,
  format: Exclude<ChatApiFormat, 'messages'>,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  deepSeek: boolean
): AsyncGenerator<MessageStreamEvent> {
  throwIfAborted(signal)
  const send = (requestBody: CreateMessageRequest) =>
    request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openAIRequest(format, requestBody, deepSeek)),
      credentials: 'omit',
      redirect: 'error',
      signal,
    })
  const response = deepSeek ? await withDeepSeekExtensionsFallback(body, send) : await send(body)
  let block: 'text' | 'thinking' | undefined
  let index = -1
  let stop: StopReason | undefined
  let usage: MessageUsage | undefined
  let title: string | undefined
  let complete = false
  for await (const packet of readStreamPayloads(response, signal)) {
    if (packet.done) {
      complete = format === 'chat' && (index >= 0 || stop !== undefined)
      break
    }
    const frame = readOpenAIFrame(format, packet.payload)
    if (frame.error) {
      throw new ApiError('stream', frame.error.message, undefined, frame.error.code)
    }
    if (packet.eventName === 'error') {
      throw new ApiError('stream', packet.data)
    }
    const deltas = [
      ['thinking', frame.thinking],
      ['text', frame.text],
    ] as const
    for (const [type, delta] of deltas) {
      if (!delta) {
        continue
      }
      if (block !== type) {
        if (block) {
          yield { type: 'content_block_stop', index }
        }
        block = type
        index += 1
        yield {
          type: 'content_block_start',
          index,
          content_block:
            type === 'text' ? { type, text: '' } : { type, thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index,
        delta:
          type === 'text'
            ? { type: 'text_delta', text: delta }
            : { type: 'thinking_delta', thinking: delta },
      }
    }
    stop = frame.stop ?? stop
    usage = frame.usage ?? usage
    title = frame.title ?? title
    if (frame.done) {
      complete = true
      break
    }
  }
  if (!complete && !(format === 'chat' && stop)) {
    throw new ApiError('interrupted', '')
  }
  if (block) {
    yield { type: 'content_block_stop', index }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stop ?? 'end_turn', stop_sequence: null, title },
    usage,
  }
  yield { type: 'message_stop' }
}
