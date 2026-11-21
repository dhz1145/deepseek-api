import clsx from 'clsx'
import { memo, useEffect, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEditOutline16,
  IconEllipsisOutline16,
  IconMultiSelectOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import { SessionActionDialog } from './SessionActionDialog.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  pinned,
  onDelete,
  onTogglePin,
  onMultiSelect,
  selection,
}: {
  session: SessionSummary
  active: boolean
  pinned: boolean
  onDelete: (session: SessionSummary) => void
  onTogglePin: (session: SessionSummary) => void
  onMultiSelect: (session: SessionSummary) => void
  selection?: { checked: boolean; toggle: () => void }
}) {
  const t = useTranslate()
  const [renaming, setRenaming] = useState(false)
  const [tapHighlight, setTapHighlight] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const highlightTimerRef = useRef<number | undefined>(undefined)
  const displayTitle = session.title || t('untitledChat')
  const openSession = () => {
    selectSession(session.id)
    if (!android) {
      closeMobileSider()
      return
    }
    window.clearTimeout(closeTimerRef.current)
    window.clearTimeout(highlightTimerRef.current)
    setTapHighlight(true)
    closeTimerRef.current = window.setTimeout(closeMobileSider, 170)
    highlightTimerRef.current = window.setTimeout(() => setTapHighlight(false), 350)
  }

  useEffect(
    () => () => {
      window.clearTimeout(closeTimerRef.current)
      window.clearTimeout(highlightTimerRef.current)
    },
    []
  )

  if (selection) {
    return (
      <div
        className={styles.select}
        role="checkbox"
        tabIndex={0}
        aria-checked={selection.checked}
        onClick={selection.toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selection.toggle()
          }
        }}
      >
        <span aria-hidden="true" />
        <div className={styles.title}>{displayTitle}</div>
      </div>
    )
  }

  const finishRename = () => {
    const title = renameInputRef.current?.value.trim() ?? ''
    setRenaming(false)
    if (title && title !== displayTitle) {
      renameSession(session.id, title)
    }
  }

  return (
    <>
      <div
        className={clsx(styles.item, active && styles.active, tapHighlight && styles.tapHighlight)}
        onContextMenu={(event) => {
          if (android) {
            event.preventDefault()
            actionsRef.current?.querySelector('button')?.click()
          }
        }}
        onClick={openSession}
        onKeyDown={(event) => {
          if (android && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            openSession()
          }
        }}
      >
        <div className={styles.title}>{displayTitle}</div>
        <div
          ref={actionsRef}
          className={clsx(styles.action, active && styles.actionActive)}
          onClick={(event) => event.stopPropagation()}
        >
          <Menu
            variant={android ? 'sidebar' : undefined}
            options={[
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setRenaming(true),
              },
              {
                key: pinned ? 'unpin' : 'pin',
                label: t(pinned ? 'androidUnpin' : 'androidPinned'),
                icon: <IconPinOutline16 />,
                onSelect: () => onTogglePin(session),
              },
              {
                key: 'multiselect',
                label: t('androidMultiSelect'),
                icon: <IconMultiSelectOutline16 />,
                onSelect: () => onMultiSelect(session),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: () => onDelete(session),
              },
            ]}
          >
            {({ toggle }) =>
              android ? (
                active ? (
                  <button
                    type="button"
                    className={clsx(styles.actionTrigger, styles.activeTrigger)}
                    aria-label={t('androidShowMenu')}
                    tabIndex={-1}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={toggle}
                  >
                    <span className={styles.activeTriggerIcon}>
                      <IconEllipsisOutline16 />
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.actionTrigger}
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={toggle}
                  />
                )
              ) : (
                <IconButton
                  icon={<IconEllipsisOutline16 />}
                  aria-label={t('more')}
                  onClick={toggle}
                />
              )
            }
          </Menu>
        </div>
      </div>
      {renaming ? (
        <SessionActionDialog
          title={t('renameSessionTitle')}
          cancelLabel={t('cancel')}
          confirmLabel={t('renameSessionConfirm')}
          onCancel={() => setRenaming(false)}
          onConfirm={finishRename}
        >
          <input
            ref={renameInputRef}
            className={styles.renameInput}
            defaultValue={displayTitle}
            autoFocus
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                finishRename()
              }
            }}
          />
        </SessionActionDialog>
      ) : null}
    </>
  )
})
