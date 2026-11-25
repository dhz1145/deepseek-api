import { fetchApi } from '../../api/transport.js'
import { BackupError } from './errors.js'

const maxArchiveBytes = 512 * 1024 * 1024

/** A signed export URL must retain its path and query; don't rebuild its parameters. */
export const downloadHistoryArchive = async (
  input: string,
  signal?: AbortSignal
): Promise<File> => {
  const address = input.trim()
  let url: URL
  try {
    if (!/^https:\/\//i.test(address) || /[\s\\#]/.test(address)) {
      throw new Error('Expected a direct HTTPS link')
    }
    url = new URL(address)
    if (url.username || url.password) {
      throw new Error('Credentials in URL')
    }
  } catch {
    throw new BackupError('historyImportInvalidLink')
  }

  const download = new AbortController()
  const abort = () => download.abort()
  const timeout = setTimeout(abort, 5 * 60 * 1000)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    abort()
  }
  try {
    // Native HTTPS on Android, with no API key, WebView cookies, or redirects.
    const response = await fetchApi(url.href, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: download.signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new BackupError(
        [401, 403, 404, 410].includes(response.status)
          ? 'historyImportLinkUnavailable'
          : 'historyImportLinkFailed'
      )
    }
    if (Number(response.headers.get('Content-Length')) > maxArchiveBytes) {
      await response.body.cancel()
      throw new BackupError('historyImportLinkTooLarge')
    }
    let bytes = 0
    const bounded = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > maxArchiveBytes) {
            throw new BackupError('historyImportLinkTooLarge')
          }
          controller.enqueue(chunk)
        },
      }),
      { signal: download.signal }
    )
    const archive = await new Response(bounded).blob()
    return new File([archive], 'deepseek_data.zip', { type: 'application/zip' })
  } catch (error) {
    // Don't put signed URLs or remote responses (which might echo credentials) in messages.
    throw error instanceof BackupError ? error : new BackupError('historyImportLinkFailed')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
