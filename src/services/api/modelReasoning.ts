import { DEEP_THINK_EFFORT, type ChatApiFormat, type ChatConfig } from './chatConfig.js'

export const SERVER_DEFAULT_EFFORT = ''
const STANDARD_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const LEVELS = ['low', 'medium', 'high'] as const
const XHIGH = [...LEVELS, 'xhigh'] as const
const MAX = [...XHIGH, 'max'] as const
const DEEPSEEK = ['low', 'high', 'max'] as const

type MessagesThinking = 'adaptive' | 'budget'
export type ModelReasoning = {
  efforts?: readonly string[]
  canonicalId?: string
  messagesThinking?: MessagesThinking
  canDisableThinking?: false
}
export type ChatReasoning = Omit<ModelReasoning, 'efforts' | 'canonicalId'> & { effort?: string }
export type ModelReasoningMap = Map<string, ModelReasoning>

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

export const readEffortList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const values = new Set<string>(
    value.filter(
      (item): item is string => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(item)
    )
  )
  if (value.length && !values.size) {
    return undefined
  }
  const standard = STANDARD_EFFORTS.filter((item) => values.delete(item))
  return [...standard, ...values].slice(0, 24)
}

const modelId = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_./:@-]{0,199}$/i.test(value) ? value : undefined

export const readModelReasoning = (
  entry: Record<string, unknown>,
  format: ChatApiFormat
): ModelReasoning | undefined => {
  // Explicit gateway extensions only: neither field is required by OpenAI's Models API.
  const declared =
    readEffortList(entry.supported_reasoning_efforts) ?? readEffortList(entry.reasoning_efforts)
  const canonicalId = modelId(entry.canonical_id) ?? modelId(entry.canonical_slug)
  if (format !== 'messages') {
    return declared || canonicalId ? { efforts: declared, canonicalId } : undefined
  }
  // Anthropic Models API: capabilities.effort.<level>.supported and thinking.types.
  const capabilities = object(entry.capabilities)
  const effort = object(capabilities.effort)
  const levels = STANDARD_EFFORTS.filter((level) => object(effort[level]).supported === true)
  const efforts =
    effort.supported === false ? [] : (declared ?? (levels.length ? levels : undefined))
  const thinking = object(object(capabilities.thinking).types)
  const messagesThinking =
    object(thinking.adaptive).supported === true
      ? 'adaptive'
      : object(thinking.enabled).supported === true
        ? 'budget'
        : undefined
  const canDisableThinking = object(thinking.disabled).supported === false ? false : undefined
  return efforts || canonicalId || messagesThinking || canDisableThinking === false
    ? { efforts, canonicalId, messagesThinking, canDisableThinking }
    : undefined
}

export const restoreModelReasoning = (entries: unknown): ModelReasoningMap => {
  const profiles: ModelReasoningMap = new Map()
  for (const [model, value] of Object.entries(object(entries))) {
    const profile = object(value)
    const { messagesThinking } = profile
    profiles.set(model, {
      efforts: readEffortList(profile.efforts),
      canonicalId: modelId(profile.canonicalId),
      messagesThinking:
        messagesThinking === 'adaptive' || messagesThinking === 'budget'
          ? messagesThinking
          : undefined,
      canDisableThinking: profile.canDisableThinking === false ? false : undefined,
    })
  }
  return profiles
}

// Model IDs/snapshots, not substring matches; provider aliases not recognized here use server default.
// Reference: OpenAI model pages; Anthropic effort; Gemini OpenAI compatibility; xAI Reasoning; Z.ai Thinking.
const knownOpenAI = (model: string, format: ChatApiFormat): readonly string[] | undefined => {
  if (/^gpt-(?:6\.2-(?:astra|sol)|6\.1-sol|6-astra)$/.test(model)) {
    return MAX
  }
  if (/^gpt-(?:6\.1-terra|6-(?:sol|luna)|5\.6(?:-(?:sol|terra))?)$/.test(model)) {
    return ['none', ...MAX]
  }
  if (/^gpt-5\.[245]-pro$/.test(model)) {
    return format === 'responses' ? ['medium', 'high', 'xhigh'] : undefined
  }
  if (/^gpt-5\.(?:[245]|4-(?:mini|nano))$/.test(model)) {
    return ['none', ...XHIGH]
  }
  if (/^gpt-5\.(?:[23]-codex|1-codex-max)$/.test(model)) {
    return XHIGH
  }
  if (model === 'gpt-5.1') {
    return ['none', ...LEVELS]
  }
  if (/^gpt-5(?:-(?:mini|nano))?$/.test(model)) {
    return ['minimal', ...LEVELS]
  }
  if (model === 'gpt-5-pro') {
    return format === 'responses' ? ['high'] : undefined
  }
  if (/^(?:o[13]|o3-mini|o4-mini|gpt-5(?:\.1)?-codex(?:-mini)?)$/.test(model)) {
    return LEVELS
  }
  return undefined
}

const knownMessages = (model: string): ModelReasoning => {
  if (
    /^claude-(?:opus-(?:5(?:-5)?|4-[78])|sonnet-5(?:-5)?|haiku-5-5|(?:fable|mythos)-5(?:-[12])?|mythos-preview)$/.test(
      model
    )
  ) {
    return { efforts: MAX, messagesThinking: 'adaptive' }
  }
  if (/^claude-(?:opus|sonnet)-4-6$/.test(model)) {
    return { efforts: [...LEVELS, 'max'], messagesThinking: 'adaptive' }
  }
  if (model === 'claude-opus-4-5') {
    return { efforts: LEVELS, messagesThinking: 'budget' }
  }
  if (/^claude-(?:sonnet-(?:3-7|4(?:-0|-5)?)|opus-4(?:-0|-1)?|haiku-4-5|3-7-sonnet)$/.test(model)) {
    return { messagesThinking: 'budget' }
  }
  return {}
}

const knownChatEfforts = (model: string): readonly string[] | undefined => {
  if (/^gemini-4-(?:neon|hydrogen)$/.test(model)) {
    return XHIGH
  }
  if (/^gemini-(?:4-(?:argon|carbon)|3\.8-flash|3\.1-pro-preview|2\.5-pro)$/.test(model)) {
    return LEVELS
  }
  if (model === 'gemini-3-pro-preview') {
    return ['low', 'high']
  }
  if (model === 'gemini-3.1-flash-lite-image') {
    return ['minimal', 'high']
  }
  if (model === 'gemini-robotics-er-2-preview' || /^gpt-oss-(?:20|120)b$/.test(model)) {
    return model.startsWith('gemini') ? ['minimal', ...LEVELS] : LEVELS
  }
  if (
    /^gemini-3(?:-flash-preview|\.1-flash-lite(?:-preview)?|\.5-flash-lite|\.6-flash)$/.test(model)
  ) {
    return ['minimal', ...LEVELS]
  }
  if (/^gemini-2\.5-flash(?:-lite)?$/.test(model)) {
    return ['none', ...LEVELS]
  }
  if (model === 'glm-5.2') {
    return ['none', 'high', 'max']
  }
  if (/^glm-5\.3(?:-flash)?$/.test(model)) {
    return DEEPSEEK
  }
  return undefined
}

const knownReasoning = (config: ChatConfig, id: string): ModelReasoning => {
  const { format, endpoint } = config
  const model = id
    .toLowerCase()
    .replace(/^(?:openai|anthropic|deepseek|google|x-ai|z-ai)\//, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/^(claude-.+)-\d{8}$/, '$1')
  // DeepSeek documents actual levels, not the aliases that map to the same level.
  if (
    !endpoint ||
    /^deepseek-(?:flash|v4-(?:pro|flash(?:-vision-exp)?)|v4\.1-flash-1017)$/.test(model)
  ) {
    return { efforts: format === 'responses' ? ['none', ...DEEPSEEK] : DEEPSEEK }
  }
  if (format === 'messages') {
    return knownMessages(model)
  }
  return {
    efforts:
      knownOpenAI(model, format) ??
      (/^grok-4\.[67]$/.test(model) ? XHIGH : model === 'grok-4.5' ? LEVELS : undefined) ??
      (format === 'chat' ? knownChatEfforts(model) : undefined),
  }
}

export const modelReasoning = (
  config: ChatConfig,
  model: string,
  profiles: ModelReasoningMap,
  aliasEfforts?: readonly string[]
) => {
  const declared = profiles.get(model)
  const canonical = declared?.canonicalId ? knownReasoning(config, declared.canonicalId) : undefined
  const known = knownReasoning(config, model)
  return {
    efforts: declared?.efforts ?? aliasEfforts ?? canonical?.efforts ?? known.efforts ?? [],
    messagesThinking:
      declared?.messagesThinking ?? canonical?.messagesThinking ?? known.messagesThinking,
    canDisableThinking:
      declared?.canDisableThinking ?? canonical?.canDisableThinking ?? known.canDisableThinking,
  }
}

export const resolveReasoningEffort = (efforts: readonly string[], saved: string | undefined) =>
  saved === SERVER_DEFAULT_EFFORT || (saved !== undefined && efforts.includes(saved))
    ? saved
    : efforts.includes(DEEP_THINK_EFFORT)
      ? DEEP_THINK_EFFORT
      : SERVER_DEFAULT_EFFORT
