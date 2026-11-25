import { create } from 'zustand'
import { android } from '../app/android.js'
import { parseApiAddress } from './api/address.js'
import {
  chatConfigFor,
  DEFAULT_CHAT_FORMAT,
  isChatApiFormat,
  type ChatApiFormat,
  type ChatConfig,
} from './api/chatConfig.js'
import {
  modelReasoning,
  resolveReasoningEffort,
  restoreModelReasoning,
  SERVER_DEFAULT_EFFORT,
  type ChatReasoning,
  type ModelReasoningMap,
} from './api/modelReasoning.js'
import {
  bundledReasoningAliases,
  fetchReasoningAliases,
  readReasoningAliases,
  reasoningAliasKey,
  type ReasoningAliases,
} from './api/reasoningAliases.js'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'
export type LocalePreference = Locale | 'system'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

type AccountProfile = {
  username: string
  avatar: string | null
}

/** 本机设置，Android 上的 API Key 和账号资料交给原生层存储。 */
type Settings = {
  apiKey: string | null
  apiBaseUrl: string | null
  chatModel: ChatModel | null
  chatModels: ChatModel[] | null
  reasoningProfiles: ModelReasoningMap
  reasoningAliases: ReasoningAliases
  reasoningPreferences: Record<string, string>
  chatConfig: ChatConfig
  accountProfile: AccountProfile
  locale: Locale
  localePreference: LocalePreference
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  autoRead: boolean
  thinking: boolean
  search: boolean
  responsesThinking: boolean
  responsesSearch: boolean
  chatThinking: boolean
  chatSearch: boolean
  siderCollapsed: boolean
  fontSize: number | null
  foldThinking: boolean
  pinnedSessions: string[]
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  chatModel: 'dsapi:chat-model',
  reasoningProfiles: 'dsapi:reasoning-profiles',
  reasoningAliases: 'dsapi:reasoning-aliases',
  reasoningPreferences: 'dsapi:reasoning-effort',
  accountProfile: 'dsapi:account-profile',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  autoRead: 'dsapi:auto-read',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  responsesThinking: 'dsapi:responses-thinking',
  responsesSearch: 'dsapi:responses-search',
  chatThinking: 'dsapi:chat-thinking',
  chatSearch: 'dsapi:chat-search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  fontSize: 'dsapi:font-size',
  foldThinking: 'dsapi:fold-thinking',
  pinnedSessions: 'dsapi:pinned-sessions',
} as const

// Keep settings from existing installs when switching the project's key prefix.
const legacyKey = (key: string) =>
  key.startsWith('dsapi:') ? key.replace('dsapi:', 'replica:') : null

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
    const previousKey = legacyKey(key)
    if (previousKey) {
      localStorage.removeItem(previousKey)
    }
    return true
  } catch {
    return false
  }
}

const read = (key: string) => {
  try {
    const value = localStorage.getItem(key)
    const previousKey = value === null ? legacyKey(key) : null
    if (!previousKey) {
      return value
    }
    const previous = localStorage.getItem(previousKey)
    if (previous !== null) {
      write(key, previous)
    }
    return previous
  } catch {
    return null
  }
}

const initialAccountProfile = (): AccountProfile => {
  try {
    const value = android ? android.readAccountProfile() : read(KEYS.accountProfile)
    const profile = JSON.parse(value ?? 'null') as Partial<AccountProfile> | null
    return {
      username: typeof profile?.username === 'string' ? profile.username : '',
      avatar:
        typeof profile?.avatar === 'string' &&
        /^data:image\/(webp|png);base64,/.test(profile.avatar)
          ? profile.avatar
          : null,
    }
  } catch {
    return { username: '', avatar: null }
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocalePreference = (): LocalePreference => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return 'system'
}

const resolveLocale = (preference: LocalePreference): Locale =>
  preference === 'system' ? (isChineseBrowser() ? 'zh-CN' : 'en-US') : preference

const initialFontSize = () => {
  const saved = read(KEYS.fontSize)
  if (saved === 'system') {
    return null
  }
  return saved !== null && /^[0-6]$/.test(saved) ? Number(saved) : 3
}

const initialPinnedSessions = (): string[] => {
  try {
    const value: unknown = JSON.parse(read(KEYS.pinnedSessions) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

// 地址和 Key 必须一起保存，避免重启后把自定义服务的 Key 发往官方地址。
const CREDENTIALS_PREFIX = 'dsapi-credentials-v1:'

const initialCredentials = (): Pick<Settings, 'apiKey' | 'apiBaseUrl' | 'chatConfig'> => {
  const saved = android ? android.readApiKey() : read(KEYS.apiKey)
  if (!saved?.startsWith(CREDENTIALS_PREFIX)) {
    return { apiKey: saved, apiBaseUrl: null, chatConfig: chatConfigFor(null, DEFAULT_CHAT_FORMAT) }
  }
  try {
    const value = JSON.parse(saved.slice(CREDENTIALS_PREFIX.length)) as {
      apiKey?: unknown
      apiBaseUrl?: unknown
      format?: unknown
    }
    const format = value.format === undefined ? DEFAULT_CHAT_FORMAT : value.format
    if (typeof value.apiKey === 'string' && value.apiKey && isChatApiFormat(format)) {
      const apiBaseUrl =
        typeof value.apiBaseUrl === 'string' ? parseApiAddress(value.apiBaseUrl, format) : null
      if (apiBaseUrl || value.apiBaseUrl === null) {
        return { apiKey: value.apiKey, apiBaseUrl, chatConfig: chatConfigFor(apiBaseUrl, format) }
      }
    }
  } catch {
    // Invalid stored credentials cannot fall back to the official host.
  }
  return { apiKey: null, apiBaseUrl: null, chatConfig: chatConfigFor(null, DEFAULT_CHAT_FORMAT) }
}

const readChatModel = (apiBaseUrl: string | null, format: ChatApiFormat): ChatModel | null => {
  try {
    const value = JSON.parse(read(KEYS.chatModel) ?? 'null') as {
      apiBaseUrl?: string | null
      format?: ChatApiFormat
      chatModel?: ChatModel
    } | null
    if (
      value?.apiBaseUrl === apiBaseUrl &&
      (value.format ?? DEFAULT_CHAT_FORMAT) === format &&
      typeof value.chatModel === 'string' &&
      value.chatModel
    ) {
      return value.chatModel
    }
  } catch {
    // An unreadable model preference is treated as unconfigured.
  }
  return null
}

const saveChatModel = (
  apiBaseUrl: string | null,
  format: ChatApiFormat,
  chatModel: ChatModel | null
) => {
  write(KEYS.chatModel, chatModel ? JSON.stringify({ apiBaseUrl, format, chatModel }) : null)
}

const chooseChatModel = (
  models: ChatModel[] | null,
  preferred: ChatModel | null
): ChatModel | null => {
  if (preferred && (models === null || models.includes(preferred))) {
    return preferred
  }
  return models?.length === 1 ? models[0] : null
}

const connectionScope = ({ endpoint, format }: ChatConfig) => JSON.stringify([endpoint, format])
const effortScope = ({ endpoint, format }: ChatConfig, model: ChatModel) =>
  JSON.stringify([endpoint, format, model])

const readReasoningProfiles = (config: ChatConfig): ModelReasoningMap => {
  try {
    const cached = JSON.parse(read(KEYS.reasoningProfiles) ?? 'null')
    if (cached?.scope === connectionScope(config)) {
      return restoreModelReasoning(cached.profiles)
    }
  } catch {
    // A malformed cache never prevents using the model's documented options.
  }
  return new Map()
}

const saveReasoningProfiles = (config: ChatConfig, profiles: ModelReasoningMap) =>
  write(
    KEYS.reasoningProfiles,
    profiles.size
      ? JSON.stringify({ scope: connectionScope(config), profiles: Object.fromEntries(profiles) })
      : null
  )

const readReasoningPreferences = (): Record<string, string> => {
  try {
    return Object.fromEntries(
      Object.entries(JSON.parse(read(KEYS.reasoningPreferences) ?? '{}')).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

export const useSettings = create<Settings>(() => {
  const credentials = initialCredentials()
  return {
    ...credentials,
    accountProfile: initialAccountProfile(),
    chatModel: credentials.apiKey
      ? readChatModel(credentials.apiBaseUrl, credentials.chatConfig.format)
      : null,
    chatModels: null,
    reasoningProfiles: credentials.apiKey
      ? readReasoningProfiles(credentials.chatConfig)
      : new Map(),
    reasoningAliases: readReasoningAliases(read(KEYS.reasoningAliases)) ?? bundledReasoningAliases,
    reasoningPreferences: readReasoningPreferences(),
    locale: resolveLocale(initialLocalePreference()),
    localePreference: initialLocalePreference(),
    location: initialLocation(),
    themePreference: initialThemePreference(),
    ttsVoice: initialTtsVoice(),
    autoRead: read(KEYS.autoRead) === 'true',
    thinking: read(KEYS.thinking) === 'true',
    search: (read(KEYS.search) ?? (android ? 'true' : 'false')) === 'true',
    responsesThinking: read(KEYS.responsesThinking) === 'true',
    responsesSearch: read(KEYS.responsesSearch) === 'true',
    chatThinking: read(KEYS.chatThinking) === 'true',
    chatSearch: read(KEYS.chatSearch) === 'true',
    siderCollapsed: read(KEYS.siderCollapsed) === 'true',
    fontSize: initialFontSize(),
    foldThinking: read(KEYS.foldThinking) !== 'false',
    pinnedSessions: initialPinnedSessions(),
  }
})

export const setAccountProfile = (accountProfile: AccountProfile) => {
  const { username, avatar } = accountProfile
  const value = username || avatar ? JSON.stringify(accountProfile) : null
  const persisted = android ? android.writeAccountProfile(value) : write(KEYS.accountProfile, value)
  if (!persisted) {
    return false
  }
  useSettings.setState({ accountProfile })
  return true
}

export const setPinnedSessions = (pinnedSessions: string[]) => {
  write(KEYS.pinnedSessions, JSON.stringify(pinnedSessions))
  useSettings.setState({ pinnedSessions })
}
export const setLocale = (localePreference: LocalePreference) => {
  write(KEYS.locale, localePreference)
  useSettings.setState({ localePreference, locale: resolveLocale(localePreference) })
}

export const setFontSize = (fontSize: number | null) => {
  write(KEYS.fontSize, fontSize?.toString() ?? 'system')
  useSettings.setState({ fontSize })
}

export const setFoldThinking = (foldThinking: boolean) => {
  write(KEYS.foldThinking, String(foldThinking))
  useSettings.setState({ foldThinking })
}
export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setAutoRead = (autoRead: boolean) => {
  write(KEYS.autoRead, String(autoRead))
  useSettings.setState({ autoRead })
}

export const setApiKey = (
  apiKey: string | null,
  address = useSettings.getState().apiBaseUrl,
  chatModels: ChatModel[] | null = null,
  format = useSettings.getState().chatConfig.format,
  profiles: ModelReasoningMap = new Map()
) => {
  const apiBaseUrl = apiKey ? address : null
  const selectedFormat = apiKey ? format : DEFAULT_CHAT_FORMAT
  const chatConfig = chatConfigFor(apiBaseUrl, selectedFormat)
  const saved =
    apiKey && (apiBaseUrl || selectedFormat !== DEFAULT_CHAT_FORMAT)
      ? CREDENTIALS_PREFIX + JSON.stringify({ apiKey, apiBaseUrl, format: selectedFormat })
      : apiKey
  if (android) {
    if (!android.writeApiKey(saved)) {
      return false
    }
  } else {
    if (!write(KEYS.apiKey, saved)) {
      return false
    }
  }
  const chatModel = apiKey
    ? chooseChatModel(chatModels, readChatModel(apiBaseUrl, selectedFormat))
    : null
  saveChatModel(apiBaseUrl, selectedFormat, chatModel)
  const reasoningProfiles = apiKey ? profiles : new Map()
  saveReasoningProfiles(chatConfig, reasoningProfiles)
  useSettings.setState({
    apiKey,
    apiBaseUrl,
    chatConfig,
    chatModel,
    chatModels: apiKey ? chatModels : null,
    reasoningProfiles,
  })
  return true
}

export const updateChatModels = (
  apiKey: string,
  apiBaseUrl: string | null,
  chatModels: ChatModel[],
  format: ChatApiFormat,
  reasoningProfiles: ModelReasoningMap
) => {
  const current = useSettings.getState()
  if (
    current.apiKey !== apiKey ||
    current.apiBaseUrl !== apiBaseUrl ||
    current.chatConfig.format !== format
  ) {
    return
  }
  const chatModel = chooseChatModel(chatModels, current.chatModel)
  saveChatModel(apiBaseUrl, format, chatModel)
  saveReasoningProfiles(current.chatConfig, reasoningProfiles)
  useSettings.setState({ chatModels, chatModel, reasoningProfiles })
}

export const setChatModel = (chatModel: ChatModel) => {
  const current = useSettings.getState()
  if (current.apiKey && current.chatModels?.includes(chatModel)) {
    saveChatModel(current.apiBaseUrl, current.chatConfig.format, chatModel)
    useSettings.setState({ chatModel })
  }
}

export const refreshReasoningAliases = async (signal: AbortSignal) => {
  try {
    const url = android?.reasoningAliasesUrl?.()
    if (!url) {
      return
    }
    const text = await fetchReasoningAliases(url, signal)
    const entries = readReasoningAliases(text)
    if (text && entries && !signal.aborted) {
      write(KEYS.reasoningAliases, text)
      useSettings.setState({ reasoningAliases: entries })
    }
  } catch {
    // The bundled or previously cached entries remain available offline.
  }
}

export const getReasoningChoice = (state: Settings, model = state.chatModel) => {
  const { chatConfig, reasoningProfiles, reasoningAliases, reasoningPreferences } = state
  const profile = model
    ? modelReasoning(
        chatConfig,
        model,
        reasoningProfiles,
        reasoningAliases.get(reasoningAliasKey(chatConfig, model))
      )
    : { efforts: [], messagesThinking: undefined, canDisableThinking: undefined }
  const effort = resolveReasoningEffort(
    profile.efforts,
    model ? reasoningPreferences[effortScope(chatConfig, model)] : undefined
  )
  return { ...profile, effort }
}

export const getChatReasoning = (state: Settings, model: ChatModel): ChatReasoning => {
  const { effort, messagesThinking, canDisableThinking } = getReasoningChoice(state, model)
  return { effort: effort || undefined, messagesThinking, canDisableThinking }
}

export const setReasoningEffort = (effort: string) => {
  const current = useSettings.getState()
  const { apiKey, chatConfig, chatModel } = current
  if (
    !apiKey ||
    !chatModel ||
    (effort !== SERVER_DEFAULT_EFFORT && !getReasoningChoice(current).efforts.includes(effort))
  ) {
    return
  }
  const reasoningPreferences = {
    ...current.reasoningPreferences,
    [effortScope(chatConfig, chatModel)]: effort,
  }
  write(KEYS.reasoningPreferences, JSON.stringify(reasoningPreferences))
  useSettings.setState({ reasoningPreferences })
}

// Custom gateways opt in separately for each OpenAI protocol. Do not inherit DeepSeek defaults.
const chatOptionKeys = ({ endpoint, format }: ChatConfig) =>
  !endpoint || format === 'messages'
    ? (['thinking', 'search'] as const)
    : format === 'responses'
      ? (['responsesThinking', 'responsesSearch'] as const)
      : (['chatThinking', 'chatSearch'] as const)

export const isThinkingEnabled = (state: Settings) => state[chatOptionKeys(state.chatConfig)[0]]
export const isSearchEnabled = (state: Settings) => state[chatOptionKeys(state.chatConfig)[1]]

const setChatOption = (index: 0 | 1, enabled: boolean) => {
  const key = chatOptionKeys(useSettings.getState().chatConfig)[index]
  write(KEYS[key], String(enabled))
  useSettings.setState({ [key]: enabled })
}

export const setThinking = (thinking: boolean) => setChatOption(0, thinking)
export const setSearch = (search: boolean) => setChatOption(1, search)

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
