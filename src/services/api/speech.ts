import { useSettings } from '../settings.js'
import { ApiError, API_ORIGIN, apiRedirect, getCustomApiBase, request } from './client.js'

/**
 * 语音接口：
 * - ASR：POST /v1/tools/asr，multipart 上传 WAV / Ogg Opus，一次返回全文
 * - TTS：POST /v1/tools/tts，返回音频字节流（产出首帧后即返回 200）
 * 鉴权都用 Authorization: Bearer。
 */
const TOOLS_BASE_URL = `${API_ORIGIN}/v1/tools`

// A custom OpenAI-compatible gateway may also serve OpenAI's independent audio endpoints.
// Preserve the previous DeepSeek-style route only when the standard route is missing.
const requestAudio = async (
  customBase: string | null,
  path: 'asr' | 'tts',
  init: RequestInit,
  standardBody: () => BodyInit
) => {
  if (customBase && useSettings.getState().chatConfig.format !== 'messages') {
    try {
      return await request(`${customBase}/audio/${path === 'asr' ? 'transcriptions' : 'speech'}`, {
        ...init,
        credentials: 'omit',
        body: standardBody(),
      })
    } catch (error) {
      if (
        customBase === 'https://api.openai.com/v1' ||
        !(error instanceof ApiError) ||
        error.code === 'model_not_found' ||
        (error.status !== 404 && error.status !== 405)
      ) {
        throw error
      }
    }
  }
  return request(`${customBase ? `${customBase}/tools` : TOOLS_BASE_URL}/${path}`, init)
}

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal
): Promise<string> => {
  const form = new FormData()
  form.append('file', audio, 'recording.wav')
  const customBase = getCustomApiBase(apiKey)
  const response = await requestAudio(
    customBase,
    'asr',
    {
      method: 'POST',
      redirect: apiRedirect(customBase),
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    },
    () => {
      const standard = new FormData()
      standard.append('file', audio, 'recording.wav')
      standard.append('model', 'gpt-4o-mini-transcribe')
      return standard
    }
  )
  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', raw)
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', raw)
  }
  return body.text
}

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const customBase = getCustomApiBase(apiKey)
  const response = await requestAudio(
    customBase,
    'tts',
    {
      method: 'POST',
      redirect: apiRedirect(customBase),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
      signal,
    },
    () =>
      JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice: voice === 'stella' ? 'shimmer' : 'onyx',
        response_format: 'pcm',
      })
  )
  if (!response.body || /json|text\//i.test(response.headers.get('Content-Type') ?? '')) {
    throw new ApiError('protocol', await response.text())
  }
  return response.body
}
