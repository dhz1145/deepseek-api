import { useState } from 'react'
import whale from '../../assets/deepseek-whale.svg'
import { useTranslate } from '../../i18n/index.js'
import { setApiKey } from '../../services/settings.js'
import { ChatModelField } from './ChatModelField.js'
import { ApiProtocolSelect } from './ApiProtocolSelect.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import styles from './ApiKeyScreen.module.css'

export const ApiKeyScreen = ({ selectingModel = false }: { selectingModel?: boolean }) => {
  const t = useTranslate()
  const form = useApiKeyForm()
  const [resetFailed, setResetFailed] = useState(false)

  if (selectingModel) {
    return (
      <main className={styles.page}>
        <section className={styles.form}>
          <img className={styles.whale} src={whale} alt="" />
          <h1>{t('apiModelChoose')}</h1>
          <ChatModelField />
          <button type="button" onClick={() => setResetFailed(!setApiKey(null))}>
            {t('apiModelChangeConnection')}
          </button>
          {resetFailed ? (
            <div role="alert" className={styles.error}>
              {t('apiKeyStorageFailed')}
            </div>
          ) : null}
        </section>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit()
        }}
      >
        <img className={styles.whale} src={whale} alt="" />
        <h1>{t('apiKeyStart')}</h1>
        <ApiProtocolSelect
          value={form.format}
          onChange={form.setFormat}
          disabled={form.verifying}
        />
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
        {form.addressError ? (
          <div role="alert" className={styles.error}>
            {form.addressError}
          </div>
        ) : null}
        <input
          aria-label="DeepSeek API Key"
          aria-invalid={Boolean(form.error)}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          disabled={form.verifying}
          placeholder={t('apiKeyPlaceholder')}
          value={form.value}
          onChange={(event) => form.setValue(event.target.value)}
        />
        {form.error ? (
          <div role="alert" className={styles.error}>
            {form.error}
          </div>
        ) : null}
        <button type="submit" disabled={form.verifying || !form.value.trim()}>
          {t(form.verifying ? 'apiKeyVerifying' : 'confirm')}
        </button>
        <a href="https://platform.deepseek.com/api_keys">{t('apiKeyGet')}</a>
      </form>
    </main>
  )
}
