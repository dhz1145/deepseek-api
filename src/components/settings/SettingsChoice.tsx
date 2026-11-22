import clsx from 'clsx'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  subscribeToAndroidBackPreview,
  useAndroidBackInterception,
} from '../../app/useAndroidBackInterception.js'
import { useTranslate } from '../../i18n/index.js'
import { IconChevronDownOutline14 } from '../base/icons.js'
import styles from './AndroidSettings.module.css'

type ChoiceProps<T extends string> = {
  title: string
  icon?: ReactNode
  value: T | null
  fields: ReadonlyArray<{ id: T; label: string }>
  confirm: (value: T) => void
}

export const SettingsChoice = <T extends string>({
  title,
  icon,
  value,
  fields,
  confirm,
  dismiss,
}: ChoiceProps<T> & { dismiss: () => void }) => {
  const t = useTranslate()
  const [next, setNext] = useState(value)
  const dialog = useRef<HTMLElement>(null)
  const onDismiss = useRef(dismiss)
  onDismiss.current = dismiss
  useAndroidBackInterception()

  useLayoutEffect(() => {
    const panel = dialog.current
    const trigger = document.activeElement
    const buttons = () =>
      Array.from(panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const cancel = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      onDismiss.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel(event)
      } else if (event.key === 'Tab') {
        const available = buttons()
        const focused = document.activeElement
        const edge = event.shiftKey ? available.at(0) : available.at(-1)
        if (!panel?.contains(focused) || focused === edge) {
          event.preventDefault()
          const target = event.shiftKey ? available.at(-1) : available.at(0)
          target?.focus()
        }
      }
    }
    // The picker, not its parent settings page, owns Back while it is open.
    window.addEventListener('android-back', cancel, true)
    document.addEventListener('keydown', onKeyDown, true)
    const stopPreview = subscribeToAndroidBackPreview(() => {})
    const selected = panel?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    const initialFocus = selected ?? buttons()[0]
    initialFocus?.focus()
    return () => {
      stopPreview?.()
      window.removeEventListener('android-back', cancel, true)
      document.removeEventListener('keydown', onKeyDown, true)
      if (trigger instanceof HTMLButtonElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [])

  return createPortal(
    <div
      className={clsx(styles.overlay, styles.choiceOverlay)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dismiss()
        }
      }}
    >
      <section
        ref={dialog}
        className={styles.choice}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          {icon}
          {title}
        </header>
        <div className={styles.options} role="radiogroup" aria-label={title}>
          {fields.map((field) => (
            <button
              key={field.id}
              type="button"
              role="radio"
              aria-checked={next === field.id}
              onClick={() => setNext(field.id)}
            >
              {field.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.confirm}
          disabled={next === null || !fields.some(({ id }) => id === next)}
          onClick={() => {
            if (next !== null) {
              confirm(next)
            }
          }}
        >
          {t('confirm')}
        </button>
      </section>
    </div>,
    document.body
  )
}

export const SettingsChoiceField = <T extends string>({
  title,
  value,
  fields,
  confirm,
  fallback,
  disabled,
  className,
}: ChoiceProps<T> & { fallback?: string; disabled?: boolean; className?: string }) => {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={clsx(styles.choiceField, className)}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span>{fields.find(({ id }) => id === value)?.label ?? value ?? fallback}</span>
        <IconChevronDownOutline14 />
      </button>
      {open && !disabled ? (
        <SettingsChoice
          title={title}
          value={value}
          fields={fields}
          dismiss={() => setOpen(false)}
          confirm={(next) => {
            setOpen(false)
            confirm(next)
          }}
        />
      ) : null}
    </>
  )
}
