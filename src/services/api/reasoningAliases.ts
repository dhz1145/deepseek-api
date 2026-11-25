import { parseApiAddress } from './address.js'
import { chatConfigFor, isChatApiFormat, type ChatConfig } from './chatConfig.js'
import { readEffortList } from './modelReasoning.js'
import bundled from './reasoning-aliases.json' with { type: 'json' }
import { fetchApi } from './transport.js'

export type ReasoningAliases = ReadonlyMap<string, readonly string[]>

export const reasoningAliasKey = ({ endpoint, format }: ChatConfig, model: string) =>
  JSON.stringify([endpoint, format, model])

const parseAliases = (data: unknown) => {
  const doc = data as { schema?: unknown; entries?: unknown } | null
  if (doc?.schema !== 1 || !Array.isArray(doc.entries) || doc.entries.length > 256) {
    return undefined
  }
  const aliases = new Map<string, readonly string[]>()
  for (const entry of doc.entries) {
    if (!entry || typeof entry !== 'object') {
      return undefined
    }
    const { baseUrl, format, model } = entry
    if (
      typeof baseUrl !== 'string' ||
      baseUrl.length > 400 ||
      !isChatApiFormat(format) ||
      typeof model !== 'string' ||
      !model ||
      model.length > 200
    ) {
      return undefined
    }
    const base = parseApiAddress(baseUrl, format)
    const efforts = readEffortList(entry.efforts)
    if (!base || !efforts) {
      return undefined
    }
    const key = reasoningAliasKey(chatConfigFor(base, format), model)
    if (aliases.has(key)) {
      return undefined
    }
    aliases.set(key, efforts)
  }
  return aliases
}

export const bundledReasoningAliases: ReasoningAliases = parseAliases(bundled) ?? new Map()

export const readReasoningAliases = (text: string | null): ReasoningAliases | undefined => {
  if (!text || text.length > 64 * 1024) {
    return undefined
  }
  try {
    const aliases = parseAliases(JSON.parse(text))
    return aliases && new Map([...bundledReasoningAliases, ...aliases])
  } catch {
    return undefined
  }
}

export const fetchReasoningAliases = async (url: string, signal: AbortSignal) => {
  const response = await fetchApi(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    redirect: 'error',
    signal,
  })
  return response.ok ? response.text() : null
}
