import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const JUMP_TO_BOTTOM_THRESHOLD = 44.8
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
const INITIAL_MESSAGES = 4
const OLDER_MESSAGES = 8
const OLDER_THRESHOLD = 320

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const jumpFrameRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = useMemo(() => getVisibleMessages(session), [session])
  const latestStart = Math.max(0, messages.length - INITIAL_MESSAGES)
  const [messageWindow, setMessageWindow] = useState({ sessionId: session.id, start: latestStart })
  const start =
    messageWindow.sessionId === session.id
      ? Math.min(messageWindow.start, latestStart)
      : latestStart
  if (messageWindow.sessionId !== session.id || messageWindow.start !== start) {
    setMessageWindow({ sessionId: session.id, start })
  }
  const prependAnchor = useRef<{ element: Element; top: number } | null>(null)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
      setShowJumpToBottom(false)
    }
  }, [])
  const stopFollowing = useCallback(() => {
    stickyRef.current = false
  }, [])
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    stickyRef.current = true
    setShowJumpToBottom(false)
    cancelAnimationFrame(jumpFrameRef.current)
    const start = el.scrollTop
    const target = el.scrollHeight - el.clientHeight
    if (target <= start) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
      return
    }
    const started = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / 337)
      const eased = 1 - (1 - progress) ** 3
      el.scrollTop = start + (target - start) * eased
      scrollTopRef.current = el.scrollTop
      if (progress < 1) {
        jumpFrameRef.current = requestAnimationFrame(step)
      } else {
        el.scrollTop = el.scrollHeight
        scrollTopRef.current = el.scrollTop
      }
    }
    jumpFrameRef.current = requestAnimationFrame(step)
  }, [])
  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 首屏从最近几条消息开始。向上浏览时逐批补齐，保持原来的阅读位置。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    const anchor = prependAnchor.current
    prependAnchor.current = null
    if (anchor?.element.isConnected && !stickyRef.current) {
      scroll.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top
      scrollTopRef.current = scroll.scrollTop
    }
    if (!start) {
      return
    }

    let frame = 0
    const loadOlder = () => {
      if (frame) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        const fits = scroll.scrollHeight - scroll.clientHeight <= STICKY_THRESHOLD
        if (!fits && (stickyRef.current || scroll.scrollTop > OLDER_THRESHOLD)) {
          return
        }
        const element = content.firstElementChild
        if (element) {
          prependAnchor.current = { element, top: element.getBoundingClientRect().top }
        }
        setMessageWindow({ sessionId: session.id, start: Math.max(0, start - OLDER_MESSAGES) })
      })
    }
    const observer = new ResizeObserver(loadOlder)
    observer.observe(scroll)
    observer.observe(content)
    scroll.addEventListener('scroll', loadOlder, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      scroll.removeEventListener('scroll', loadOlder)
    }
  }, [isMobile, session.id, start])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])
  useEffect(() => () => cancelAnimationFrame(jumpFrameRef.current), [])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      if (android && isMobile) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight
        setShowJumpToBottom(distance > JUMP_TO_BOTTOM_THRESHOLD)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={stopFollowing}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div className={styles.scrollArea}>
          <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
            <div ref={contentRef} className={styles.column}>
              {messages.slice(start).map((message, offset) => {
                const index = start + offset
                return message.role === 'user' ? (
                  <UserMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    retryUploadId={uploadRetryId}
                    isFirst={index === 0}
                    isLast={index === lastIndex || index === lastIndex - 1}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    isLast={index === lastIndex}
                    streaming={streaming && index === lastIndex}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                )
              })}
            </div>
          </div>
          {android && isMobile && showJumpToBottom ? (
            <button
              type="button"
              className={styles.jumpToBottom}
              aria-label={t('jumpToBottom')}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={jumpToBottom}
            >
              <span className={styles.jumpToBottomIcon}>
                <IconChevronDownOutline14 />
              </span>
            </button>
          ) : null}
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
