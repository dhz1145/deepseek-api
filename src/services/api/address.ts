import { CHAT_API_PATHS, DEFAULT_CHAT_FORMAT, type ChatApiFormat } from './chatConfig.js'

/** 将 Anthropic 基础地址（或完整的 Messages 地址）转换为带 /v1 的 API 根路径。 */
export const parseApiAddress = (input: string, format = DEFAULT_CHAT_FORMAT): string | null => {
  const value = input.trim()
  if (!value) {
    return null
  }
  if (!/^https:\/\//i.test(value) || /[?#\\\s]/.test(value)) {
    throw new Error('Invalid HTTPS API address')
  }
  const url = new URL(value)
  if (url.username || url.password) {
    throw new Error('Invalid HTTPS API address')
  }
  let path = url.pathname.replace(/\/+$/, '')
  if (format === 'messages') {
    path = path.replace(/(\/v1)\/messages$/, '$1')
    if (!path && url.origin === 'https://api.deepseek.com') {
      path = '/anthropic'
    }
    return `${url.origin}${path.endsWith('/v1') ? path : `${path}/v1`}`
  }
  for (const suffix of [CHAT_API_PATHS.chat, CHAT_API_PATHS.responses]) {
    if (path.endsWith(suffix)) {
      path = path.slice(0, -suffix.length)
      break
    }
  }
  return `${url.origin}${path || '/v1'}`
}

export const isOfficialApiAddress = (base: string | null, format: ChatApiFormat) =>
  base ===
  (format === 'messages' ? 'https://api.deepseek.com/anthropic/v1' : 'https://api.deepseek.com/v1')
