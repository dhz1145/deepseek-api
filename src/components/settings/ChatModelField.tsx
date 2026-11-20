import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listChatModels } from '../../services/api/client.js'
import { setChatModel, updateChatModels, useSettings } from '../../services/settings.js'
import styles from './ChatModelField.module.css'

export const ChatModelField = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const apiBaseUrl = useSettings((state) => state.apiBaseUrl)
  const format = useSettings((state) => state.chatConfig.format)
  const model = useSettings((state) => state.chatModel)
  const models = useSettings((state) => state.chatModels)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    if (!apiKey || (useSettings.getState().chatModels !== null && !refresh)) {
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    setStatus('loading')
    void listChatModels(apiKey, apiBaseUrl, signal, format).then(
      (items) => {
        if (!signal.aborted) {
          updateChatModels(apiKey, apiBaseUrl, items, format)
          setStatus('idle')
        }
      },
      () => {
        if (!signal.aborted) {
          setStatus('error')
        }
      }
    )
    return () => controller.abort()
  }, [apiKey, apiBaseUrl, format, refresh])

  if (!apiKey) {
    return null
  }
  return (
    <div className={styles.field}>
      <label>
        <span>{t('apiModel')}</span>
        <select
          value={model ?? ''}
          disabled={!models?.length || status === 'loading'}
          onChange={(event) => {
            setChatModel(event.currentTarget.value)
          }}
        >
          <option value="" disabled>
            {t('apiModelChoose')}
          </option>
          {models === null && model ? <option value={model}>{model}</option> : null}
          {models?.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
      {status === 'loading' ? <div role="status">{t('apiModelLoading')}</div> : null}
      {status === 'error' ? <div role="alert">{t('apiModelLoadFailed')}</div> : null}
      {status === 'idle' && models?.length === 0 ? (
        <div role="status">{t('apiModelEmpty')}</div>
      ) : null}
      <button
        type="button"
        disabled={status === 'loading'}
        onClick={() => setRefresh((value) => value + 1)}
      >
        {t('apiModelRefresh')}
      </button>
    </div>
  )
}
