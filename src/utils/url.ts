/** 来自服务端或归档、用于页面导航的链接只接受 HTTP / HTTPS。 */
export const isWebUrl = (value: string) => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
