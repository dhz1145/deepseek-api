import { create } from 'zustand'
import { android } from '../app/android.js'
import { parseApiAddress } from './api/address.js'
import type { TtsVoice } from './api/speech.js'
import type { ChatModel } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'
export type LocalePreference = Locale | 'system'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  apiBaseUrl: string | null
  chatModel: ChatModel | null
  chatModels: ChatModel[] | null
  locale: Locale
  localePreference: LocalePreference
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  autoRead: boolean
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  fontSize: number | null
  foldThinking: boolean
  pinnedSessions: string[]
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  chatModel: 'replica:chat-model',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  autoRead: 'replica:auto-read',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  fontSize: 'replica:font-size',
  foldThinking: 'replica:fold-thinking',
  pinnedSessions: 'replica:pinned-sessions',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
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

const initialCredentials = (): Pick<Settings, 'apiKey' | 'apiBaseUrl'> => {
  const saved = android ? android.readApiKey() : read(KEYS.apiKey)
  if (!saved?.startsWith(CREDENTIALS_PREFIX)) {
    return { apiKey: saved, apiBaseUrl: null }
  }
  try {
    const value = JSON.parse(saved.slice(CREDENTIALS_PREFIX.length)) as Partial<Settings>
    if (typeof value.apiKey === 'string' && typeof value.apiBaseUrl === 'string') {
      const apiBaseUrl = parseApiAddress(value.apiBaseUrl)
      if (apiBaseUrl) {
        return { apiKey: value.apiKey, apiBaseUrl }
      }
    }
  } catch {
    // 保存的自定义配置无法恢复时，重新显示登录表单，不回退到官方服务。
  }
  return { apiKey: null, apiBaseUrl: null }
}

const readChatModel = (apiBaseUrl: string | null): ChatModel | null => {
  try {
    const value = JSON.parse(read(KEYS.chatModel) ?? 'null') as Pick<
      Settings,
      'apiBaseUrl' | 'chatModel'
    > | null
    if (
      value?.apiBaseUrl === apiBaseUrl &&
      typeof value.chatModel === 'string' &&
      value.chatModel
    ) {
      return value.chatModel
    }
  } catch {
    // 旧版本或不可读的模型偏好按未配置处理。
  }
  return null
}

const saveChatModel = (apiBaseUrl: string | null, chatModel: ChatModel | null) => {
  write(KEYS.chatModel, chatModel ? JSON.stringify({ apiBaseUrl, chatModel }) : null)
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

export const useSettings = create<Settings>(() => {
  const credentials = initialCredentials()
  return {
    ...credentials,
    chatModel: credentials.apiKey ? readChatModel(credentials.apiBaseUrl) : null,
    chatModels: null,
    locale: resolveLocale(initialLocalePreference()),
    localePreference: initialLocalePreference(),
    location: initialLocation(),
    themePreference: initialThemePreference(),
    ttsVoice: initialTtsVoice(),
    autoRead: read(KEYS.autoRead) === 'true',
    thinking: read(KEYS.thinking) === 'true',
    search: (read(KEYS.search) ?? (android ? 'true' : 'false')) === 'true',
    siderCollapsed: read(KEYS.siderCollapsed) === 'true',
    fontSize: initialFontSize(),
    foldThinking: read(KEYS.foldThinking) !== 'false',
    pinnedSessions: initialPinnedSessions(),
  }
})

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
  chatModels: ChatModel[] | null = null
) => {
  const apiBaseUrl = apiKey ? address : null
  const saved = apiBaseUrl ? CREDENTIALS_PREFIX + JSON.stringify({ apiKey, apiBaseUrl }) : apiKey
  if (android) {
    if (!android.writeApiKey(saved)) {
      return false
    }
  } else {
    write(KEYS.apiKey, saved)
  }
  const chatModel = apiKey ? chooseChatModel(chatModels, readChatModel(apiBaseUrl)) : null
  saveChatModel(apiBaseUrl, chatModel)
  useSettings.setState({ apiKey, apiBaseUrl, chatModel, chatModels: apiKey ? chatModels : null })
  return true
}

export const updateChatModels = (
  apiKey: string,
  apiBaseUrl: string | null,
  chatModels: ChatModel[]
) => {
  const current = useSettings.getState()
  if (current.apiKey !== apiKey || current.apiBaseUrl !== apiBaseUrl) {
    return
  }
  const chatModel = chooseChatModel(chatModels, current.chatModel)
  saveChatModel(apiBaseUrl, chatModel)
  useSettings.setState({ chatModels, chatModel })
}

export const setChatModel = (chatModel: ChatModel) => {
  const current = useSettings.getState()
  if (current.apiKey && current.chatModels?.includes(chatModel)) {
    saveChatModel(current.apiBaseUrl, chatModel)
    useSettings.setState({ chatModel })
  }
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
