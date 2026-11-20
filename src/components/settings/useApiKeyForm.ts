import { useEffect, useRef, useState } from 'react'
import { parseApiAddress } from '../../services/api/address.js'
import { ANTHROPIC_BASE_URL, ApiError, listChatModels } from '../../services/api/client.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiKey, useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'

/** 输入 API Key 后先用 GET /models 校验，通过才保存 */
export const useApiKeyForm = (onSaved?: () => void) => {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [address, setAddress] = useState(() => useSettings.getState().apiBaseUrl ?? '')
  const [invalidAddress, setInvalidAddress] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null)
  const pending = useRef<AbortController>()
  useEffect(() => () => pending.current?.abort(), [])
  const cause = failure?.cause
  const error =
    failure === null
      ? null
      : classifyApiError(cause) === 'unauthorized'
        ? t('apiKeyInvalid')
        : classifyApiError(cause) === 'network'
          ? t('commonNetworkErrorToast')
          : t('apiKeyVerificationFailed', {
              message:
                cause instanceof ApiError && cause.localMessage
                  ? t(cause.localMessage.key, cause.localMessage.params)
                  : cause instanceof Error
                    ? cause.message
                    : String(cause),
            })

  const reset = () => {
    pending.current?.abort()
    pending.current = undefined
    setValue('')
    setAddress(useSettings.getState().apiBaseUrl ?? '')
    setInvalidAddress(false)
    setVerifying(false)
    setFailure(null)
  }

  const submit = async () => {
    const apiKey = value.trim()
    if (!apiKey || pending.current) {
      return
    }
    setFailure(null)
    setInvalidAddress(false)
    let apiBaseUrl: string | null
    try {
      const parsed = parseApiAddress(address)
      apiBaseUrl = parsed === ANTHROPIC_BASE_URL ? null : parsed
    } catch {
      setInvalidAddress(true)
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    pending.current = controller
    setVerifying(true)
    try {
      const models = await listChatModels(apiKey, apiBaseUrl, signal)
      if (signal.aborted) {
        return
      }
      if (!setApiKey(apiKey, apiBaseUrl, models)) {
        throw new Error(t('apiKeyStorageFailed'))
      }
      setValue('')
      onSaved?.()
    } catch (e) {
      if (!signal.aborted) {
        setFailure({ cause: e })
      }
    } finally {
      if (pending.current === controller) {
        pending.current = undefined
        if (!signal.aborted) {
          setVerifying(false)
        }
      }
    }
  }

  return {
    value,
    setValue,
    address,
    setAddress: (value: string) => {
      setAddress(value)
      setInvalidAddress(false)
      setFailure(null)
    },
    verifying,
    error,
    addressError: invalidAddress ? t('apiAddressInvalid') : null,
    reset,
    submit,
  }
}
