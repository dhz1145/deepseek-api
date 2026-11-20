import { translate, type TranslationMessage } from '../../i18n/index.js'
import { useSettings } from '../settings.js'
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
    readonly status?: number
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
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
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
  signal?: AbortSignal
): Promise<ChatModel[]> => {
  const url = `${customBase ?? API_ORIGIN}/models`
  const models = new Set<ChatModel>()
  const cursors = new Set<string>()
  let cursor = ''
  for (;;) {
    const response = await request(cursor ? `${url}?after_id=${encodeURIComponent(cursor)}` : url, {
      method: 'GET',
      headers: customBase
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
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  const customBase = getCustomApiBase(apiKey)
  const response = await request(`${customBase ?? ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true, customBase),
    redirect: apiRedirect(customBase),
  })
  await response.body?.cancel()
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
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
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const customBase = getCustomApiBase(apiKey)
  const response = await openMessageStream(apiKey, customBase, body, signal).catch(
    (error: unknown) => {
      if (
        !(body.tools?.length || body.safety_check || body.title?.enabled) ||
        !(error instanceof ApiError) ||
        error.status !== 400 ||
        !/\buser input too long, \d+ tokens exceeds max 32768 tokens\b/i.test(error.message)
      ) {
        throw error
      }
      // 扩展模式在生成前拒绝长输入时，用基础 Messages API 发送同一上下文。
      return openMessageStream(
        apiKey,
        customBase,
        { ...body, tools: undefined, safety_check: undefined, title: undefined },
        signal
      )
    }
  )
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
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
