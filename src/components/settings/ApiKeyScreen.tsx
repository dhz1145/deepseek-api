import { useLayoutEffect, useRef, useState } from 'react'
import { android } from '../../app/android.js'
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
  const formRef = useRef<HTMLFormElement>(null)
  const whaleRef = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    const device = android
    const form = formRef.current
    const image = whaleRef.current
    if (!form || !image || !device?.onStartupFrameReady || !device.consumeStartupAnimation?.()) {
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    form.dataset.startup = 'waiting'
    let active = true
    const finish = () => {
      active = false
      delete form.dataset.startup
      window.clearTimeout(timeout)
      window.removeEventListener('android-startup-frame', play)
      form.removeEventListener('focusin', finish)
      image.removeEventListener('animationend', finish)
    }
    const play = () => {
      const { left, top, width, height } = image.getBoundingClientRect()
      const x = window.innerWidth / 2 - left - width / 2
      const y = window.innerHeight * 0.45 - top - height / 2
      image.style.setProperty('--startup-x', `${x}px`)
      image.style.setProperty('--startup-y', `${y}px`)
      form.dataset.startup = 'playing'
    }
    const timeout = window.setTimeout(finish, 1400)
    window.addEventListener('android-startup-frame', play, { once: true })
    form.addEventListener('focusin', finish)
    image.addEventListener('animationend', finish, { once: true })
    const firstFrame = () => {
      if (active) {
        device.onStartupFrameReady?.()
      }
    }
    void Promise.resolve(image.decode?.()).then(firstFrame, firstFrame)
    return finish
  }, [])

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
        ref={formRef}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit()
        }}
      >
        <img ref={whaleRef} className={styles.whale} src={whale} alt="" />
        <h1>{t('apiKeyStart')}</h1>
        <ApiProtocolSelect
          className={styles.protocol}
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
