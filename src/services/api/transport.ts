import { readBlobChunks } from '../../utils/blob.js'

type NativeApiBridge = {
  prepare: (address: string, method: string, headers: string) => string | null
  append: (id: string, chunk: string) => boolean
  cancel: (id: string) => void
}

export const fetchApi = async (url: string, init: RequestInit): Promise<Response> => {
  const bridge = (window as Window & { DeepSeekNativeApi?: NativeApiBridge }).DeepSeekNativeApi
  if (!bridge) {
    return fetch(url, init)
  }

  const { signal } = init
  const checkAbort = () => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The request was aborted', 'AbortError')
    }
  }
  checkAbort()
  const headers = new Headers(init.headers)
  // Let the browser encode the multipart boundary, but do not make a network request here.
  const encoded = init.body == null ? null : new Response(init.body)
  const contentType = encoded?.headers.get('Content-Type')
  if (contentType && !headers.has('Content-Type')) {
    headers.set('Content-Type', contentType)
  }
  const id = bridge.prepare(url, init.method ?? 'GET', JSON.stringify(Object.fromEntries(headers)))
  if (!id) {
    throw new Error('Invalid HTTPS API request')
  }
  const cleanup = () => {
    signal?.removeEventListener('abort', cleanup)
    bridge.cancel(id)
  }
  signal?.addEventListener('abort', cleanup, { once: true })

  try {
    if (encoded) {
      for await (const chunk of readBlobChunks(await encoded.blob())) {
        const size = 32768
        for (let offset = 0; offset < chunk.length; offset += size) {
          checkAbort()
          if (
            !bridge.append(id, btoa(String.fromCharCode(...chunk.subarray(offset, offset + size))))
          ) {
            throw new Error('Could not prepare the HTTPS request body')
          }
        }
      }
    }
    checkAbort()
    // This URL is intercepted in Android; headers/credentials are passed only via the bridge.
    const response = await fetch(`/_native_api/${id}`, { signal, cache: 'no-store' })
    if (response.headers.has('X-Native-Api-Error')) {
      throw new Error(await response.text())
    }
    if (!response.body) {
      cleanup()
      return response
    }
    const reader = response.body.getReader()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read()
          if (result.done) {
            cleanup()
            controller.close()
          } else {
            controller.enqueue(result.value)
          }
        } catch (error) {
          cleanup()
          controller.error(error)
        }
      },
      cancel(reason) {
        cleanup()
        return reader.cancel(reason)
      },
    })
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    cleanup()
    throw error
  }
}
