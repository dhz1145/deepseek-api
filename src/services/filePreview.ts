import { getFileExt, isImage } from './attachments.js'

const VIEW_TYPES: Record<string, string> = {
  png: 'image/png',
  apng: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  pjp: 'image/jpeg',
  pjpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  dib: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  avif: 'image/avif',
  avifs: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** 展示时只按允许的文件后缀定类型，不信任本地文件或归档自报的 MIME。 */
export const getFileViewType = (name: string) => {
  const ext = getFileExt(name)
  return (
    (Object.hasOwn(VIEW_TYPES, ext) ? VIEW_TYPES[ext] : undefined) ?? 'application/octet-stream'
  )
}

export const isFileViewImage = (name: string) => isImage(getFileViewType(name))

export const createFileView = async (original: Blob, name: string) => {
  const type = getFileViewType(name)
  const blob = original.slice(0, original.size, type)
  // SVG 不生成与网页同源、可直接导航的对象地址。
  const url =
    type === 'image/svg+xml'
      ? await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
      : URL.createObjectURL(blob)
  const open = type === 'application/pdf' || (isImage(type) && type !== 'image/svg+xml')
  const link = open
    ? { href: url, target: '_blank', rel: 'noreferrer' }
    : { href: url, download: name }
  return { blob, url, link }
}
