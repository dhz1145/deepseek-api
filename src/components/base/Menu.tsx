import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
  variant,
  anchorClassName,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
  variant?: 'sidebar' | 'userMessage' | 'assistantMessage'
  anchorClassName?: string
}) => {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const sidebarMenu = variant === 'sidebar'
  const userMessageMenu = variant === 'userMessage'
  const assistantMessageMenu = variant === 'assistantMessage'
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    userMessageMenu
      ? { align: 'end', alignOffset: 0, offset: -7.8222 }
      : { align: 'start', alignOffset: -5, offset: sidebarMenu ? 6.4 : 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  return (
    <>
      <span ref={anchorRef} className={clsx(styles.anchor, anchorClassName)}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={clsx(
                styles.menu,
                sidebarMenu && styles.sidebarMenu,
                userMessageMenu && styles.userMessageMenu,
                assistantMessageMenu && styles.assistantMessageMenu
              )}
              style={position ?? undefined}
              role="menu"
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={(event) => {
                    event.stopPropagation()
                    setOpen(false)
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  <span>{option.label}</span>
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
