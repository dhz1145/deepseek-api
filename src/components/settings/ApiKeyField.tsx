import { useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { ApiProtocolSelect } from './ApiProtocolSelect.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** API Key 的编辑状态：输入框与移动端底部的「确定」按钮共用 */
export const useApiKeyEditor = () => {
  const apiKey = useSettings((state) => state.apiKey)
  const [editing, setEditing] = useState(false)
  const form = useApiKeyForm(() => setEditing(false))
  const open = () => {
    if (!editing) {
      form.reset()
      setEditing(true)
    }
  }
  const close = () => {
    form.reset()
    setEditing(false)
  }
  return { apiKey, editing, open, close, form, showInput: !apiKey || editing }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/** API Key：保存后只显示掩码，点编辑按钮才能重新输入 */
export const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, editing, open, form, showInput } = editor

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('apiKeyStart')}</div>
        {apiKey && !editing ? (
          <div className={styles.apiKeySaved}>
            <span className={styles.apiKeyMask}>{'*'.repeat(apiKey.length)}</span>
            <IconButton
              tone="primary"
              icon={<IconEditOutline16 />}
              tooltip={t('apiKeyEdit')}
              onClick={open}
            />
          </div>
        ) : null}
        {showInput ? (
          <>
            <div className={styles.apiKeyInput}>
              <ApiProtocolSelect
                value={form.format}
                onChange={form.setFormat}
                disabled={form.verifying}
              />
            </div>
            <div className={styles.apiKeyInput}>
              <input
                aria-label={t('apiAddress')}
                aria-invalid={Boolean(form.addressError)}
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={form.verifying}
                placeholder={t('apiAddressPlaceholder')}
                value={form.address}
                onChange={(event) => form.setAddress(event.target.value)}
              />
            </div>
            {form.addressError ? (
              <div role="alert" className={styles.error}>
                {form.addressError}
              </div>
            ) : null}
            <div className={styles.apiKeyInput}>
              <input
                aria-label="DeepSeek API Key"
                aria-invalid={Boolean(form.error)}
                type="password"
                placeholder={t('apiKeyPlaceholder')}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={form.verifying}
                // 移动端打开设置时不弹键盘，点编辑后才聚焦
                autoFocus={!isMobile || editing}
                value={form.value}
                onChange={(event) => form.setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    void form.submit()
                  }
                }}
              />
              {!isMobile && form.value.trim() ? (
                <>
                  <span className={styles.divider} />
                  <button
                    type="button"
                    className={styles.confirm}
                    disabled={form.verifying}
                    // 保持输入框焦点
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void form.submit()}
                  >
                    {form.verifying ? t('apiKeyVerifying') : t('confirm')}
                  </button>
                </>
              ) : null}
            </div>
            {form.error ? (
              <div role="alert" className={styles.error}>
                {form.error}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

/** 移动端：输入 API Key 时在选项下方显示整行「确定」 */
export const ApiKeyConfirm = ({ editor: { showInput, form } }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  return showInput && form.value.trim() ? (
    <button
      type="button"
      className={styles.mobileConfirm}
      disabled={form.verifying}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void form.submit()}
    >
      {form.verifying ? t('apiKeyVerifying') : t('confirm')}
    </button>
  ) : null
}
