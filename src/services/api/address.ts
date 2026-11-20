/** 将 Anthropic 基础地址（或完整的 Messages 地址）转换为带 /v1 的 API 根路径。 */
export const parseApiAddress = (input: string): string | null => {
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
  let path = url.pathname.replace(/\/+$/, '').replace(/(\/v1)\/messages$/, '$1')
  if (!path && url.origin === 'https://api.deepseek.com') {
    path = '/anthropic'
  }
  return `${url.origin}${path.endsWith('/v1') ? path : `${path}/v1`}`
}
