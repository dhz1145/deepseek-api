export const CHAT_API_FORMATS = {
  messages: 'Anthropic Messages',
  chat: 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
} as const

export type ChatApiFormat = keyof typeof CHAT_API_FORMATS
export type ChatConfig = { endpoint: string; format: ChatApiFormat }

export const CHAT_API_PATHS: Record<ChatApiFormat, string> = {
  messages: '/messages',
  chat: '/chat/completions',
  responses: '/responses',
}

export const DEFAULT_CHAT_FORMAT: ChatApiFormat = 'messages'
export const DEEP_THINK_EFFORT = 'high'

export const supportsPrefix = ({ endpoint, format }: ChatConfig) =>
  format === 'messages' || (format === 'chat' && !endpoint)

export const isChatApiFormat = (value: unknown): value is ChatApiFormat =>
  value === 'messages' || value === 'chat' || value === 'responses'

export const chatConfigFor = (base: string | null, format: ChatApiFormat): ChatConfig => ({
  format,
  endpoint: base ? `${base}${CHAT_API_PATHS[format]}` : '',
})
