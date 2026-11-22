import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { cancelMessageEdit, useDrafts } from '../../services/chat/drafts.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { JumpToBottomButton } from './JumpToBottomButton.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { prefersReducedMotion, stepCriticallyDampedSpring, type SpringState } from './spring.js'
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
const JUMP_TO_BOTTOM_THRESHOLD = 48
const JUMP_TO_BOTTOM_MIN_HEIGHT = 64
const JUMP_SCROLL_STIFFNESS = 700
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
  const isMobile = useIsMobile()
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const desktopFooterRef = useRef<HTMLDivElement>(null)
  const jumpSlotRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const jumpingRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  const scrollTopRef = useRef(0)
  const jumpFrameRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const editingMessageId = useDrafts((state) =>
    android && state.editing?.sessionId === session.id ? state.editing.messageId : null
  )
  const editingMessageIdRef = useRef(editingMessageId)
  editingMessageIdRef.current = editingMessageId
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
  const cancelJump = useCallback(() => {
    cancelAnimationFrame(jumpFrameRef.current)
    jumpFrameRef.current = 0
    jumpingRef.current = false
  }, [])
  const updateJumpVisibility = useCallback(() => {
    const el = scrollRef.current
    if (!el || stickyRef.current || jumpingRef.current) {
      setShowJumpToBottom(false)
      return
    }
    const footerHeight =
      !isMobile && desktopFooterRef.current ? desktopFooterRef.current.offsetHeight : 0
    const availableHeight = Math.max(0, el.clientHeight - footerHeight)
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowJumpToBottom(
      availableHeight >= JUMP_TO_BOTTOM_MIN_HEIGHT && distance > JUMP_TO_BOTTOM_THRESHOLD
    )
  }, [isMobile])
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current && !jumpingRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
      setShowJumpToBottom(false)
    }
  }, [])
  const ensureEditedBubbleVisible = useCallback(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content || !editingMessageIdRef.current) {
      return
    }
    const bubble = content.querySelector<HTMLElement>(
      '[data-editing-target="true"] [data-editing-bubble="true"]'
    )
    if (!bubble) {
      return
    }
    const scrollRect = scroll.getBoundingClientRect()
    const bubbleRect = bubble.getBoundingClientRect()
    if (scrollRect.height <= 0 || bubbleRect.height <= 0) {
      return
    }
    const margin = 12
    let delta = 0
    if (bubbleRect.bottom > scrollRect.bottom - margin) {
      delta = bubbleRect.bottom - (scrollRect.bottom - margin)
      if (bubbleRect.top - delta < scrollRect.top + margin) {
        delta = Math.max(0, bubbleRect.top - (scrollRect.top + margin))
      }
    } else if (bubbleRect.top < scrollRect.top + margin) {
      delta = bubbleRect.top - (scrollRect.top + margin)
    }
    if (Math.abs(delta) > 0.5) {
      programmaticScrollRef.current = true
      scroll.scrollTop += delta
      scrollTopRef.current = scroll.scrollTop
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    }
  }, [])
  const stopFollowing = useCallback(() => {
    cancelJump()
    stickyRef.current = false
    updateJumpVisibility()
  }, [cancelJump, updateJumpVisibility])
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el || jumpingRef.current) {
      return
    }
    const initialTarget = Math.max(0, el.scrollHeight - el.clientHeight)
    if (el.scrollTop >= initialTarget - 0.5 || prefersReducedMotion()) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
      stickyRef.current = true
      setShowJumpToBottom(false)
      return
    }
    cancelJump()
    jumpingRef.current = true
    // 到达底部前不恢复 stickyRef，避免流式增长触发 ResizeObserver 瞬间拉底打断弹簧动画。
    stickyRef.current = false
    setShowJumpToBottom(false)

    let state: SpringState = { value: el.scrollTop, velocity: 0 }
    let lastTime = performance.now()
    const step = (now: number) => {
      if (!jumpingRef.current || scrollRef.current !== el) {
        jumpFrameRef.current = 0
        jumpingRef.current = false
        return
      }
      const target = Math.max(0, el.scrollHeight - el.clientHeight)
      if (target <= 0) {
        el.scrollTop = el.scrollHeight
        scrollTopRef.current = el.scrollTop
        jumpingRef.current = false
        jumpFrameRef.current = 0
        stickyRef.current = true
        setShowJumpToBottom(false)
        return
      }
      const stepTime = now > lastTime ? now : lastTime
      const dt = Math.min(0.05, (stepTime - lastTime) / 1000)
      lastTime = stepTime
      state = stepCriticallyDampedSpring(state, target, JUMP_SCROLL_STIFFNESS, dt)
      if (state.value >= target) {
        state = { value: target, velocity: Math.min(0, state.velocity) }
      }
      el.scrollTop = state.value
      scrollTopRef.current = el.scrollTop
      if (Math.abs(target - state.value) <= 0.5 && Math.abs(state.velocity) < 12) {
        el.scrollTop = el.scrollHeight
        scrollTopRef.current = el.scrollTop
        jumpingRef.current = false
        jumpFrameRef.current = 0
        stickyRef.current = true
        setShowJumpToBottom(false)
        return
      }
      jumpFrameRef.current = requestAnimationFrame(step)
    }
    jumpFrameRef.current = requestAnimationFrame(step)
  }, [cancelJump])
  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态，或刷新回到底部按钮的显示状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    const desktopFooter = desktopFooterRef.current
    if (!content || !scroll) {
      return
    }
    const handleResize = () => {
      if (editingMessageIdRef.current) {
        stickyRef.current = false
        ensureEditedBubbleVisible()
        return
      }
      if (stickyRef.current && !jumpingRef.current) {
        scrollToBottom()
      } else {
        updateJumpVisibility()
      }
    }
    const observer = new ResizeObserver(handleResize)
    observer.observe(content)
    observer.observe(scroll)
    if (!isMobile && desktopFooter) {
      observer.observe(desktopFooter)
    }
    return () => observer.disconnect()
  }, [isMobile, ensureEditedBubbleVisible, scrollToBottom, updateJumpVisibility])

  useLayoutEffect(() => {
    if (!editingMessageId) {
      updateJumpVisibility()
      return
    }
    cancelJump()
    stickyRef.current = false
    setShowJumpToBottom(false)
    ensureEditedBubbleVisible()
  }, [cancelJump, editingMessageId, ensureEditedBubbleVisible, updateJumpVisibility])

  useEffect(() => {
    if (!android || !editingMessageId) {
      return
    }
    const area = scrollAreaRef.current
    const scroll = scrollRef.current
    if (!area || !scroll) {
      return
    }
    let pointerDown: { x: number; y: number; pointerId: number } | null = null
    let touchStart: { x: number; y: number } | null = null
    let touchActive = false
    let dismissed = false
    const dismiss = () => {
      if (dismissed) {
        return
      }
      dismissed = true
      pointerDown = null
      touchStart = null
      touchActive = false
      cancelMessageEdit()
      window.dispatchEvent(new Event('android-close-attachments'))
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return
      }
      pointerDown = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerDown || event.pointerId !== pointerDown.pointerId) {
        return
      }
      if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 8) {
        dismiss()
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      if (!pointerDown || event.pointerId !== pointerDown.pointerId) {
        return
      }
      dismiss()
    }
    const onPointerCancel = () => {
      pointerDown = null
    }
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (touch) {
        touchStart = { x: touch.clientX, y: touch.clientY }
        touchActive = true
      }
    }
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch || !touchStart) {
        return
      }
      if (Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 8) {
        dismiss()
      }
    }
    const onTouchEnd = () => {
      touchStart = null
      touchActive = false
    }
    const onWheel = () => dismiss()
    const onScroll = () => {
      if (!programmaticScrollRef.current && (pointerDown || touchActive)) {
        dismiss()
      }
    }
    area.addEventListener('pointerdown', onPointerDown)
    area.addEventListener('pointermove', onPointerMove)
    area.addEventListener('pointerup', onPointerUp)
    area.addEventListener('pointercancel', onPointerCancel)
    area.addEventListener('touchstart', onTouchStart, { passive: true })
    area.addEventListener('touchmove', onTouchMove, { passive: true })
    area.addEventListener('touchend', onTouchEnd, { passive: true })
    area.addEventListener('touchcancel', onTouchEnd, { passive: true })
    scroll.addEventListener('wheel', onWheel, { passive: true })
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      area.removeEventListener('pointerdown', onPointerDown)
      area.removeEventListener('pointermove', onPointerMove)
      area.removeEventListener('pointerup', onPointerUp)
      area.removeEventListener('pointercancel', onPointerCancel)
      area.removeEventListener('touchstart', onTouchStart)
      area.removeEventListener('touchmove', onTouchMove)
      area.removeEventListener('touchend', onTouchEnd)
      area.removeEventListener('touchcancel', onTouchEnd)
      scroll.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('scroll', onScroll)
    }
  }, [editingMessageId])

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
      if (frame || jumpingRef.current) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        if (jumpingRef.current) {
          return
        }
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
      scrollTopRef.current = scroll.scrollTop
      updateJumpVisibility()
      return
    }
    cancelJump()
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, cancelJump, scrollToBottom, updateJumpVisibility])

  useEffect(closeSearchPanel, [session.id, lastMessageId])
  useEffect(() => cancelJump, [cancelJump])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      cancelJump()
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [cancelJump, session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框、当前阅读位置与回到底部按钮状态。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    cancelJump()
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
      updateJumpVisibility()
    }
    const onScroll = () => {
      if (jumpingRef.current) {
        scrollTopRef.current = el.scrollTop
        return
      }
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      updateJumpVisibility()
    }
    const interruptJump = (event: Event) => {
      if (!jumpingRef.current) {
        return
      }
      const target = event.target
      if (
        target instanceof Node &&
        (desktopFooterRef.current?.contains(target) || jumpSlotRef.current?.contains(target))
      ) {
        return
      }
      cancelJump()
      stickyRef.current = false
      scrollTopRef.current = el.scrollTop
      updateJumpVisibility()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('touchstart', interruptJump, { passive: true })
    el.addEventListener('pointerdown', interruptJump, { passive: true })
    el.addEventListener('wheel', interruptJump, { passive: true })
    return () => {
      cancelJump()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', interruptJump)
      el.removeEventListener('pointerdown', interruptJump)
      el.removeEventListener('wheel', interruptJump)
    }
  }, [isMobile, cancelJump, scrollToBottom, updateJumpVisibility])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const jumpButton = (
    <JumpToBottomButton
      visible={showJumpToBottom && !editingMessageId}
      streaming={streaming}
      resetKey={session.id}
      onClick={jumpToBottom}
    />
  )
  return (
    <ScrollToBottomContext.Provider value={stopFollowing}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={scrollAreaRef} className={styles.scrollArea}>
          <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
            <div
              ref={contentRef}
              className={styles.column}
              data-editing-session={editingMessageId ? 'true' : undefined}
            >
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
                    editingTarget={editingMessageId === message.id}
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
          {isMobile ? (
            <div ref={jumpSlotRef} className={styles.mobileJumpSlot}>
              {jumpButton}
            </div>
          ) : null}
        </div>
        {isMobile ? (
          footer
        ) : (
          <div ref={desktopFooterRef} className={styles.desktopFooter}>
            <div ref={jumpSlotRef} className={styles.desktopJumpSlot}>
              {jumpButton}
            </div>
            {footer}
          </div>
        )}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
