import { memo, useEffect } from 'react'
import { android } from './android.js'
import { AndroidUpdatePrompt } from './AndroidUpdatePrompt.js'
import { useAndroidBackInterception } from './useAndroidBackInterception.js'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { AndroidSettings } from '../components/settings/AndroidSettings.js'
import { ApiKeyScreen } from '../components/settings/ApiKeyScreen.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider, useMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { useAndroidDrawerGesture } from '../components/sider/useAndroidDrawerGesture.js'
import styles from './App.module.css'

const ChatContent = memo(function ChatContent({
  isMobile,
  siderCollapsed,
}: {
  isMobile: boolean
  siderCollapsed: boolean
}) {
  const t = useTranslate()
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const activeId = useChatStore((state) => state.activeId)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )

  if (!ready || (activeId !== null && !session)) {
    const loadFailed = !ready ? initError : sessionLoadError
    return (
      <div className={styles.loadingView}>
        {isMobile ? <MobileHeader /> : null}
        <div className={styles.loadingState} role="status" aria-live="polite">
          <span>
            {t(
              loadFailed
                ? !ready
                  ? 'sessionListLoadFailed'
                  : 'sessionLoadFailed'
                : 'sessionLoading'
            )}
          </span>
          {loadFailed ? (
            <Button
              variant="outlined"
              size="m"
              onClick={() => {
                if (!ready) {
                  void initChat()
                } else if (activeId !== null) {
                  selectSession(activeId)
                }
              }}
            >
              {t('retry')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return session ? (
    <SessionView session={session} streaming={streaming} siderCollapsed={siderCollapsed} />
  ) : (
    <Welcome />
  )
})

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const apiKey = useSettings((state) => state.apiKey)
  const model = useSettings((state) => state.chatModel)
  const needsApiSetup = Boolean(android && (!apiKey || !model))
  const drawerOpen = useMobileSider((state) => state.open)
  const drawerGesture = useAndroidDrawerGesture()
  const locale = useSettings((state) => state.locale)
  const fontSize = useSettings((state) => state.fontSize)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const saveErrors = useChatStore((state) => state.sessionSaveErrors)
  const saveError = Object.values(saveErrors).some(Boolean)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const frameRef = useMobileViewport(isMobile && !needsApiSetup)
  const activeId = useChatStore((state) => state.activeId)

  useAndroidBackInterception(drawerOpen)
  usePreventPageScroll(isMobile && !android)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    if (android) {
      const size = fontSize === null ? android.systemFontScale() : 1 + (fontSize - 3) * 0.09
      document.documentElement.style.setProperty('--android-chat-font-scale', String(size))
    }
  }, [fontSize])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key
    if (!android) {
      ensureApiKey()
    }
  }, [])

  useEffect(() => {
    if (!android) {
      return
    }
    const onBack = (event: Event) => {
      if (useSettingsDialog.getState().open) {
        return
      }
      if (document.querySelector('[role="dialog"]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      } else if (useSearchPanel.getState().entry) {
        closeSearchPanel()
      } else if (useMobileSider.getState().open) {
        closeMobileSider()
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('android-back', onBack)
    return () => window.removeEventListener('android-back', onBack)
  }, [])

  if (needsApiSetup) {
    return (
      <>
        <ApiKeyScreen key={apiKey ? 'model' : 'credentials'} selectingModel={Boolean(apiKey)} />
        <AndroidUpdatePrompt key="android-update" />
      </>
    )
  }

  return (
    <>
      <div
        ref={frameRef}
        className={styles.frame}
        data-drawer-open={drawerOpen}
        {...(android && isMobile ? drawerGesture : {})}
      >
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            <ChatContent isMobile={isMobile} siderCollapsed={siderCollapsed} />
          </div>
        </main>
        <SearchPanel />
      </div>
      {android ? <AndroidSettings chatFrame={frameRef} /> : <SettingsDialog />}
      <Toast />
      {android ? <AndroidUpdatePrompt key="android-update" /> : null}
    </>
  )
}
