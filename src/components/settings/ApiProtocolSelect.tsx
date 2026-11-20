import { useTranslate } from '../../i18n/index.js'
import {
  CHAT_API_FORMATS,
  isChatApiFormat,
  type ChatApiFormat,
} from '../../services/api/chatConfig.js'

export const ApiProtocolSelect = ({
  value,
  disabled,
  onChange,
}: {
  value: ChatApiFormat
  disabled: boolean
  onChange: (value: ChatApiFormat) => void
}) => {
  const t = useTranslate()
  return (
    <select
      aria-label={t('apiProtocol')}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const format = event.currentTarget.value
        if (isChatApiFormat(format)) {
          onChange(format)
        }
      }}
    >
      {Object.entries(CHAT_API_FORMATS).map(([format, name]) => (
        <option key={format} value={format}>
          {name}
        </option>
      ))}
    </select>
  )
}
