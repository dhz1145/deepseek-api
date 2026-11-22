import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { useTranslate } from '../../i18n/index.js'
import {
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconSearchOutline16,
  IconCloseOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setPinnedSessions, setSiderCollapsed, useSettings } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ProfileAvatar } from '../settings/ProfileAvatar.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, closeOverlaySider, useMobileSider } from './mobileSiderState.js'
import { SessionActionDialog } from './SessionActionDialog.js'
import { SessionItem } from './SessionItem.js'
import { useSessionSearch } from './useSessionSearch.js'
import { setInert } from '../../utils/inert.js'
import styles from './Sider.module.css'

const ROW_OVERSCAN = 8

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = memo(function Sider({ mobile = false }: { mobile?: boolean }) {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const pinnedIds = useSettings((state) => state.pinnedSessions)
  const profile = useSettings((state) => state.accountProfile)
  const username = profile.username || t('profileDefaultUsername')
  const androidDrawer = Boolean(mobile && android)
  const [query, setQuery] = useState('')
  const matches = useSessionSearch(query, sessions)
  const [now, setNow] = useState(Date.now)
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [pinning, setPinning] = useState<{ ids: Set<string>; unpin: boolean } | null>(null)
  const unpin = checked.size > 0 && [...checked].every((id) => pinnedIds.includes(id))
  const groups = useMemo(() => {
    if (!androidDrawer || pinnedIds.length === 0) {
      return groupSessions(matches, now, t)
    }
    const pinned = matches.filter((session) => pinnedIds.includes(session.id))
    const rest = groupSessions(
      matches.filter((session) => !pinnedIds.includes(session.id)),
      now,
      t
    )
    return pinned.length
      ? [{ key: 'pinned', label: t('androidPinned'), sessions: pinned }, ...rest]
      : rest
  }, [androidDrawer, matches, now, pinnedIds, t])
  const listRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 720 })
  const rowHeight = androidDrawer ? 48 : mobile ? 44 : 40
  const positionedGroups = useMemo(() => {
    let end = 0
    return groups.map((group, index) => {
      // 与分组的 margin、padding、标题行高和会话行高相同，保留原生粘性标题。
      const top = end + (index ? (androidDrawer ? 7 : 16) : 0) + 4 + (mobile ? 29 : 22)
      end = top + group.sessions.length * rowHeight + (group.key === 'pinned' ? 15 : 0)
      return { ...group, top }
    })
  }, [androidDrawer, groups, mobile, rowHeight])
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const update = () => {
      const top = list.scrollTop
      const height = list.clientHeight
      setViewport((previous) =>
        previous.top === top && previous.height === height ? previous : { top, height }
      )
    }
    const observer = new ResizeObserver(update)
    observer.observe(list)
    list.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', update)
    }
  }, [])
  const [deleting, setDeleting] = useState<SessionSummary[]>([])
  const deleteOne = useCallback((session: SessionSummary) => setDeleting([session]), [])
  const togglePinned = useCallback(
    (session: SessionSummary) => {
      setPinnedSessions(
        pinnedIds.includes(session.id)
          ? pinnedIds.filter((id) => id !== session.id)
          : [...new Set([...pinnedIds, session.id])]
      )
    },
    [pinnedIds]
  )
  const startSelection = useCallback((session: SessionSummary) => {
    setSelecting(true)
    setChecked(new Set([session.id]))
    setPinning(null)
  }, [])
  const [deletePending, setDeletePending] = useState(false)
  const drawerOpen = useMobileSider((state) => state.open)
  const closeSelection = useCallback(() => {
    setSelecting(false)
    setChecked((previous) => (previous.size === 0 ? previous : new Set()))
    setPinning(null)
  }, [])

  useEffect(() => {
    if (!drawerOpen) {
      closeSelection()
    }
  }, [closeSelection, drawerOpen])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      {selecting ? (
        <div className={styles.selectionHeader}>
          {checked.size
            ? t('androidSelectedChats', { count: checked.size })
            : t('androidSelectChats')}
          <IconButton
            tone="primary"
            icon={<IconCloseOutline16 />}
            aria-label={t('close')}
            onClick={closeSelection}
          />
        </div>
      ) : androidDrawer ? (
        <label className={styles.search}>
          <IconSearchOutline16 />
          <input
            type="search"
            placeholder={t('androidSearchChats')}
            aria-label={t('androidSearchChats')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : (
        <>
          <div className={styles.top}>
            <div className={styles.appName}>{t('appName')}</div>
            <IconButton
              size="m"
              icon={<IconPanelLeftOutline16 />}
              tooltip={t('collapseSiderbarButton')}
              tooltipPlacement="bottom"
              onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
            />
          </div>
          <button
            type="button"
            className={styles.newChat}
            onClick={() => {
              newChat()
              closeOverlaySider()
            }}
          >
            <span className={styles.newChatIcon}>
              <NewChatIcon />
            </span>
            {t('newChat')}
          </button>
        </>
      )}
      <div className={styles.listWrap}>
        {androidDrawer && !selecting ? (
          <IconButton
            className={styles.selectChats}
            icon={
              <svg
                width="18"
                height="18"
                viewBox="0 0 18 18"
                fill="none"
                stroke="currentColor"
                aria-hidden="true"
              >
                <circle cx="4" cy="5" r="1.6" />
                <circle cx="4" cy="13" r="1.6" />
                <path d="M8 5h7M8 13h7" strokeWidth="1.2" />
              </svg>
            }
            aria-label={t('androidMultiSelect')}
            onClick={() => setSelecting(true)}
          />
        ) : null}
        <div ref={listRef} className={styles.list}>
          {positionedGroups.map((group) => {
            const limit = group.sessions.length
            const start = Math.min(
              limit,
              Math.max(0, Math.floor((viewport.top - group.top) / rowHeight) - ROW_OVERSCAN)
            )
            const end = Math.min(
              limit,
              Math.max(
                start,
                Math.ceil((viewport.top + viewport.height - group.top) / rowHeight) + ROW_OVERSCAN
              )
            )
            return (
              <div
                key={group.key}
                className={clsx(styles.section, group.key === 'pinned' && styles.pinnedSection)}
              >
                <div className={styles.sectionHeader}>{group.label}</div>
                {start ? <div aria-hidden="true" style={{ height: start * rowHeight }} /> : null}
                {group.sessions.slice(start, end).map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    pinned={pinnedIds.includes(session.id)}
                    onTogglePin={togglePinned}
                    onMultiSelect={startSelection}
                    onDelete={deleteOne}
                    selection={
                      selecting
                        ? {
                            checked: checked.has(session.id),
                            toggle: () => {
                              setChecked((previous) => {
                                const next = new Set(previous)
                                if (next.has(session.id)) {
                                  next.delete(session.id)
                                } else {
                                  next.add(session.id)
                                }
                                return next
                              })
                            },
                          }
                        : undefined
                    }
                  />
                ))}
                {end < limit ? (
                  <div aria-hidden="true" style={{ height: (limit - end) * rowHeight }} />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      <div className={styles.bottom}>
        {selecting ? (
          <div className={styles.selectionActions}>
            <button
              type="button"
              disabled={!checked.size}
              onClick={() => setPinning({ ids: checked, unpin })}
            >
              <IconPinOutline16 />
              {t(unpin ? 'androidUnpin' : 'androidPinned')}
            </button>
            <button
              type="button"
              data-danger=""
              disabled={!checked.size}
              onClick={() => setDeleting(sessions.filter((session) => checked.has(session.id)))}
            >
              <IconTrashOutline16 />
              {t('delete')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.settings}
            aria-label={`${username} · ${t('settings')}`}
            onClick={() => openSettings('general')}
          >
            <ProfileAvatar src={profile.avatar} />
            <span className={styles.settingsLabel}>{username}</span>
            {androidDrawer ? <IconEllipsisOutline16 /> : null}
          </button>
        )}
      </div>
      {pinning ? (
        <SessionActionDialog
          title={t(pinning.unpin ? 'androidUnpinConfirm' : 'androidPinConfirm', {
            count: pinning.ids.size,
          })}
          cancelLabel={t(pinning.unpin ? 'androidKeepPinned' : 'cancel')}
          confirmLabel={t(pinning.unpin ? 'androidUnpin' : 'androidPinned')}
          onCancel={() => setPinning(null)}
          onConfirm={() => {
            const ids = sessions.filter((session) => pinning.ids.has(session.id))
            setPinnedSessions(
              pinning.unpin
                ? pinnedIds.filter((id) => !pinning.ids.has(id))
                : [...new Set([...pinnedIds, ...ids.map(({ id }) => id)])]
            )
            showToast({
              key: pinning.unpin ? 'androidUnpinnedChats' : 'androidPinnedChats',
              params: { count: ids.length },
            })
            closeSelection()
          }}
        />
      ) : null}
      {deleting.length ? (
        <SessionActionDialog
          title={
            deleting.length === 1
              ? t('androidDeleteOneTitle')
              : t('androidDeleteManyTitle', { count: deleting.length })
          }
          description={
            deleting.length === 1
              ? t('androidDeleteOneDescription')
              : t('androidDeleteManyDescription')
          }
          cancelLabel={t('cancel')}
          confirmLabel={
            deleting.length === 1 ? t('androidDeleteOneConfirm') : t('androidDeleteManyConfirm')
          }
          danger
          stacked
          closeDisabled={deletePending}
          confirmDisabled={deletePending}
          onCancel={() => setDeleting([])}
          onConfirm={async () => {
            setDeletePending(true)
            try {
              const remaining: SessionSummary[] = []
              const deleted = new Set<string>()
              for (const session of deleting) {
                if (await removeSession(session.id)) {
                  deleted.add(session.id)
                } else {
                  remaining.push(session)
                }
              }
              setDeleting(remaining)
              if (deleted.size) {
                setPinnedSessions(pinnedIds.filter((id) => !deleted.has(id)))
              }
              if (remaining.length) {
                showToast({ key: 'sessionDeleteFailed', type: 'error' })
              } else {
                closeSelection()
              }
            } finally {
              setDeletePending(false)
            }
          }}
        />
      ) : null}
    </div>
  )
})

export const MobileSider = memo(function MobileSider({ split }: { split: boolean }) {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  const drawer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setInert(drawer.current, !open)
  }, [open])
  if (!android && !open) {
    return null
  }
  return (
    <>
      {open && !split ? (
        <div
          className={styles.drawerMask}
          role="button"
          aria-label={t('closeSiderbarButton')}
          onClick={closeMobileSider}
        />
      ) : null}
      <div
        className={styles.drawer}
        ref={drawer}
        hidden={split && !open}
        data-android-drawer={android ? '' : undefined}
      >
        <Sider mobile />
      </div>
    </>
  )
})
