import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { android } from '../../app/android.js'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import {
  IconCloseOutline16,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import {
  isSearchEnabled,
  isThinkingEnabled,
  setSearch,
  setThinking,
  useSettings,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { editMessage, sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  addEditFiles,
  cancelMessageEdit,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  removeEditAttachment,
  replaceDraftImage,
  replaceEditImage,
  retryDraftAttachment,
  retryEditAttachment,
  setDraftText,
  setEditDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { AndroidCircle } from '../base/AndroidIcons.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { AndroidAttachments } from './AndroidAttachments.js'
import { AndroidDraftAttachments } from './AndroidDraftAttachments.js'
import { AndroidImageViewer } from '../files/AndroidImageViewer.js'
import { useFileView } from '../files/useFileView.js'
import { AndroidVoiceOverlay } from './AndroidVoiceOverlay.js'
import { useHoldToTalk } from './useHoldToTalk.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

const useVoiceMode = create<{ enabled: boolean }>(() => ({ enabled: false }))

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const editing = useDrafts((state) =>
    android && sessionId !== null && state.editing?.sessionId === sessionId ? state.editing : null
  )
  const editingHere = editing !== null
  const activeDraft = editing ?? draft
  const { text, attachments } = activeDraft
  const customEndpoint = useSettings((state) =>
    Boolean(state.apiBaseUrl && state.chatConfig.format !== 'messages')
  )
  const apiKey = useSettings((state) => state.apiKey)
  const apiBaseUrl = useSettings((state) => state.apiBaseUrl)
  const uploadKey = customEndpoint ? null : apiKey
  const isEditingTarget = useCallback(
    () =>
      Boolean(
        android && sessionId !== null && useDrafts.getState().editing?.sessionId === sessionId
      ),
    [sessionId]
  )
  const setText = (value: string) => {
    if (isEditingTarget()) {
      setEditDraftText(value)
    } else {
      setDraftText(sessionId, value)
    }
  }
  const draftReady = useUploads(
    (state) => prepareDraftMessage(activeDraft, state.tasks, customEndpoint) !== null
  )
  const imagesUploading = useUploads(
    (state) =>
      !customEndpoint &&
      attachments.some(
        (item) =>
          item.isImage &&
          !item.existing &&
          (!state.tasks[item.id] || state.tasks[item.id].status === 'uploading')
      )
  )
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings(isThinkingEnabled)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings(isSearchEnabled)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const voiceMode = useVoiceMode((state) => state.enabled) && !editingHere
  const [showAttachments, setShowAttachments] = useState(false)
  const [previewId, setPreviewId] = useState<string>()
  const preview = attachments.find((item) => item.id === previewId)
  const previewView = useFileView(preview?.file ?? (preview?.existing ? preview.id : undefined), preview?.name)
  const [typing, setTyping] = useState(false)
  const sendSpoken = useRef(false)

  useEffect(() => {
    if (!uploadKey) {
      return
    }
    for (const item of attachments) {
      if (!item.existing && !useUploads.getState().tasks[item.id]) {
        if (editingHere) {
          retryEditAttachment(item.id, uploadKey)
        } else {
          retryDraftAttachment(sessionId, item.id, uploadKey)
        }
      }
    }
  }, [apiBaseUrl, attachments, editingHere, sessionId, uploadKey])

  useEffect(() => {
    if (!apiKey) {
      useVoiceMode.setState({ enabled: false })
    }
  }, [apiKey])

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [customEndpoint, t])

  const acceptFiles = (files: File[], recentPhotoId?: string) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = isEditingTarget()
      ? addEditFiles(files, uploadKey, recentPhotoId)
      : addDraftFiles(sessionId, files, uploadKey, recentPhotoId)
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && uploadKey && ensureApiKey()) {
        if (isEditingTarget()) {
          retryEditAttachment(id, uploadKey)
        } else {
          retryDraftAttachment(sessionId, id, uploadKey)
        }
      }
    },
    [isEditingTarget, sessionId, uploadKey]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        if (isEditingTarget()) {
          removeEditAttachment(id)
        } else {
          removeDraftAttachment(sessionId, id)
        }
      }
    },
    [isEditingTarget, sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = isEditingTarget()
      ? (useDrafts.getState().editing?.text ?? '')
      : getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    if (sendSpoken.current) {
      sendSpoken.current = false
      if (!useChatStore.getState().importingHistory && ensureApiKey() && !isEditingTarget()) {
        stopReadAloud()
        sendMessage(sessionId)
      }
      return
    }
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })
  const hold = useHoldToTalk(voice, () => {
    if (importingHistory || streaming || !ensureApiKey()) {
      return false
    }
    setShowAttachments(false)
    sendSpoken.current = true
    return true
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
          setPreviewId(undefined)
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'
  const voiceOverlayActive = recording || voice.status === 'transcribing'

  const focusComposer = useCallback(() => {
    setShowAttachments(false)
    useVoiceMode.setState({ enabled: false })
    if (android) {
      setTyping(true)
    }
    textareaRef.current?.focus({ preventScroll: true })
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  }, [])

  const editingMessageId = editing?.messageId
  useLayoutEffect(() => {
    if (!editingMessageId) {
      return
    }
    cancelVoice()
    setShowAttachments(false)
    useVoiceMode.setState({ enabled: false })
    setTyping(true)
    const textarea = textareaRef.current
    if (textarea) {
      textarea.focus({ preventScroll: true })
      const end = textarea.value.length
      textarea.setSelectionRange(end, end)
      textarea.scrollTop = textarea.scrollHeight
    }
  }, [cancelVoice, editingMessageId])

  useEffect(() => {
    if (!android) {
      return
    }
    const onFocusRequest = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) {
        focusComposer()
      }
    }
    const onDismissExtras = () => {
      setShowAttachments(false)
      textareaRef.current?.blur()
    }
    window.addEventListener('android-focus-composer', onFocusRequest)
    window.addEventListener('android-close-attachments', onDismissExtras)
    return () => {
      window.removeEventListener('android-focus-composer', onFocusRequest)
      window.removeEventListener('android-close-attachments', onDismissExtras)
    }
  }, [focusComposer, sessionId])

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady
  const showSend = !android || editingHere || streaming || draftReady || typing

  useAndroidBackInterception(showAttachments || editingHere)
  useEffect(() => {
    if (!showAttachments && !editingHere) {
      return
    }
    const closeOnBack = (event: Event) => {
      if (event.defaultPrevented) {
        return
      }
      event.preventDefault()
      if (showAttachments) {
        setShowAttachments(false)
        return
      }
      textareaRef.current?.blur()
      cancelMessageEdit()
    }
    window.addEventListener('android-back', closeOnBack)
    return () => window.removeEventListener('android-back', closeOnBack)
  }, [showAttachments, editingHere])

  useEffect(() => {
    if (!android) {
      return
    }
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      const textarea = textareaRef.current
      if (!root.hasAttribute('data-keyboard') && document.activeElement === textarea) {
        textarea?.blur()
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-keyboard'] })
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    if (!android || !typing) {
      return
    }
    textareaRef.current?.focus({ preventScroll: true })
  }, [typing])

  const send = () => {
    if (useChatStore.getState().importingHistory || voice.status !== 'idle') {
      return
    }
    const currentEditing = useDrafts.getState().editing
    if (android && sessionId !== null && currentEditing?.sessionId === sessionId) {
      const prepared = prepareDraftMessage(
        currentEditing,
        useUploads.getState().tasks,
        customEndpoint
      )
      if (
        !prepared ||
        !ensureApiKey() ||
        !editMessage(sessionId, currentEditing.messageId, prepared.text, prepared.files)
      ) {
        return
      }
      setShowAttachments(false)
      stopReadAloud()
      textareaRef.current?.blur()
      return
    }
    if (!prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks, customEndpoint)) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    setShowAttachments(false)
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  const photoSuggestions = !!android && !text.trim() && attachments.some((item) => item.isImage)

  return (
    <div className={styles.composer}>
      <div
        data-drawer-gesture-ignore=""
        data-editing={editingHere ? 'true' : undefined}
        className={clsx(
          styles.wrapper,
          sessionId === null ? styles.home : styles.session,
          android && voiceOverlayActive && styles.recordingCard
        )}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            focusComposer()
          }
        }}
      >
        {editingHere ? (
          <div className={styles.editBanner}>
            <span className={styles.editLabel}>{t('androidEditingMessage')}</span>
            <button
              type="button"
              className={styles.editClose}
              aria-label={t('cancel')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                textareaRef.current?.blur()
                cancelMessageEdit()
              }}
            >
              <IconCloseOutline16 />
            </button>
          </div>
        ) : null}
        {android ? (
          <AndroidDraftAttachments
            items={attachments}
            suggestions={photoSuggestions}
            loading={imagesUploading}
            localOnly={customEndpoint}
            canSend={canSend}
            onRetry={retryFile}
            onRemove={removeFile}
            onPreview={(id) => {
              textareaRef.current?.blur()
              setPreviewId(id)
            }}
            onSuggestion={(message) => {
              const latestText = isEditingTarget()
                ? (useDrafts.getState().editing?.text ?? '')
                : getDraft(sessionId).text
              if (!canSend || latestText.trim()) {
                return
              }
              setText(message)
              send()
            }}
          />
        ) : (
          <DraftAttachments
            items={attachments}
            localOnly={customEndpoint}
            onRetry={retryFile}
            onRemove={removeFile}
          />
        )}
        <div
          className={styles.textareaWrapper}
          onClick={(event) => {
            if (android && event.target === event.currentTarget) {
              focusComposer()
            }
          }}
        >
          {android && voiceMode ? (
            <button
              type="button"
              className={styles.holdButton}
              disabled={importingHistory || streaming}
              {...hold.direct}
              onPointerDown={(event) => {
                if (voice.status === 'transcribing') {
                  voice.cancel()
                } else {
                  hold.direct.onPointerDown(event)
                }
              }}
            >
              {t(voice.status === 'transcribing' ? 'voiceInputCancel' : 'androidHoldToTalk')}
            </button>
          ) : (
            <textarea
              ref={textareaRef}
              className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
              placeholder={t(
                android
                  ? editingHere || typing
                    ? 'androidMessageHint'
                    : 'androidHoldHint'
                  : 'chatInputPlaceholderChat'
              )}
              rows={2}
              // 移动端不自动聚焦，避免一打开就弹出键盘
              autoFocus={!isMobile}
              disabled={importingHistory}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onFocus={() => {
                setTyping(true)
                setShowAttachments(false)
              }}
              onBlur={() => setTyping(false)}
              {...(android && !editingHere ? hold.delayed : {})}
              onPointerDown={(event) => {
                if (android && !editingHere && !text && !typing) {
                  hold.delayed.onPointerDown(event)
                }
              }}
              onContextMenu={(event) => {
                if (recording && android) {
                  event.preventDefault()
                }
              }}
              onMouseDown={(event) => {
                // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
                if (
                  isMobile &&
                  event.button === 0 &&
                  document.activeElement !== event.currentTarget
                ) {
                  event.preventDefault()
                  event.currentTarget.focus({ preventScroll: true })
                }
              }}
              enterKeyHint={android || isMobile ? 'enter' : undefined}
              onKeyDown={(event) => {
                if (
                  !android &&
                  !isMobile &&
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  send()
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length > 0) {
                  event.preventDefault()
                  acceptFiles(files)
                }
              }}
            />
          )}
          {recording && isMobile && !android ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
          {voiceMode ? null : (
            <div className={styles.mirror} aria-hidden>
              {`${text}\n`}
            </div>
          )}
        </div>
        <div className={styles.functionRow}>
          {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
          <div ref={togglesRef} className={styles.toggles}>
            <Tooltip content={t('deactivatedThinkTooltip')}>
              <button
                type="button"
                className={clsx(styles.toggle, thinking && styles.selected)}
                aria-label={t('thinkingSwitch')}
                aria-pressed={thinking}
                onClick={() => setThinking(!thinking)}
              >
                <IconThinkOutline14 />
                <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
              </button>
            </Tooltip>
            <Tooltip content={t('deactivatedSearchTooltip')}>
              <button
                type="button"
                className={clsx(styles.toggle, search && styles.selected)}
                aria-label={t('search')}
                aria-pressed={search}
                onClick={() => setSearch(!search)}
              >
                <IconGlobeLanguageOutline14 />
                <span className={styles.toggleLabel}>{t('search')}</span>
              </button>
            </Tooltip>
          </div>
          <div className={styles.right}>
            {android ? (
              <>
                <IconButton
                  size="xl"
                  tone="primary"
                  icon={<AndroidCircle icon={showAttachments ? 'close' : 'add'} />}
                  aria-label={t(showAttachments ? 'close' : 'uploadFile')}
                  aria-expanded={showAttachments}
                  disabled={importingHistory}
                  onClick={() => {
                    textareaRef.current?.blur()
                    setShowAttachments(!showAttachments)
                  }}
                />
                {typing ||
                editingHere ||
                (draftReady && (attachments.length === 0 || text.trim())) ? null : (
                  <IconButton
                    size="xl"
                    tone="primary"
                      icon={<AndroidCircle icon={voiceMode ? 'keys' : 'voice'} />}
                    aria-label={t(voiceMode ? 'androidTextMode' : 'androidVoiceMode')}
                    aria-pressed={voiceMode}
                    onClick={() => {
                      if (!voiceMode && !ensureApiKey()) {
                        return
                      }
                      voice.cancel()
                      useVoiceMode.setState({ enabled: !voiceMode })
                      if (voiceMode) {
                        focusComposer()
                      }
                    }}
                  />
                )}
              </>
            ) : (
              <>
                <VoiceButton
                  status={voice.status}
                  disabled={!voice.available}
                  seconds={voice.seconds}
                  onClick={() => {
                    if (
                      voice.status !== 'idle' ||
                      (!useChatStore.getState().importingHistory && ensureApiKey())
                    ) {
                      void voice.toggle()
                    }
                  }}
                />
                <IconButton
                  size="m"
                  tone="primary"
                  icon={<IconPaperclipOutline16 />}
                  tooltip={t('uploadFile')}
                  disabled={importingHistory}
                  onClick={() => ensureApiKey() && fileInputRef.current?.click()}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  accept={ACCEPT}
                  onChange={(event) => {
                    acceptFiles(Array.from(event.target.files ?? []))
                    event.target.value = ''
                  }}
                />
              </>
            )}
            {streaming && sessionId ? (
              <button
                type="button"
                className={styles.sendButton}
                aria-label={t('chatInputStopButtonTooltip')}
                onClick={() => {
                  stopReadAloud()
                  stopReply(sessionId)
                }}
              >
                <IconStopFill16 />
              </button>
            ) : showSend ? (
              <button
                type="button"
                className={clsx(styles.sendButton, !canSend && styles.disabled)}
                aria-label={t('send')}
                aria-disabled={!canSend}
                onPointerDown={(event) => {
                  if (android && !canSend) {
                    event.preventDefault()
                  }
                }}
                onClick={send}
              >
                <IconSendOutline16 />
              </button>
            ) : null}
          </div>
        </div>
        {dragging ? <DragMask /> : null}
      </div>
      {android ? (
        <>
          <AndroidAttachments
            open={showAttachments}
            selectedPhotos={
              new Map(
                attachments.flatMap((item) =>
                  item.recentPhotoId ? [[item.recentPhotoId, item.id] as const] : []
                )
              )
            }
            onRecentFile={(file, photoId) => acceptFiles([file], photoId)}
            onRemove={removeFile}
            onFiles={(files, source) => {
              setShowAttachments(false)
              acceptFiles(files)
              if (source === 'gallery') {
                focusComposer()
              }
            }}
          />
          <AndroidVoiceOverlay
            active={voiceOverlayActive}
            canceling={hold.canceling}
            level={voice.getLevel}
            touch={hold.touch}
          />
        </>
      ) : null}
      {android && !importingHistory && preview && previewView ? (
        <AndroidImageViewer
          key={preview.id}
          blob={previewView.blob}
          name={preview.name}
          source={previewView.url}
          onClose={() => setPreviewId(undefined)}
          onConfirm={(file) => {
            const error = editingHere
              ? replaceEditImage(preview.id, file, uploadKey)
              : replaceDraftImage(sessionId, preview.id, file, uploadKey)
            if (!error) {
              setPreviewId(undefined)
              focusComposer()
            }
            return error
          }}
        />
      ) : null}
    </div>
  )
}
