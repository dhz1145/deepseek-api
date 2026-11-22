import { useTranslate } from '../../i18n/index.js'
import {
  CHAT_API_FORMATS,
  isChatApiFormat,
  type ChatApiFormat,
} from '../../services/api/chatConfig.js'
import { SettingsChoiceField } from './SettingsChoice.js'

const protocols = Object.keys(CHAT_API_FORMATS)
  .filter(isChatApiFormat)
  .map((id) => ({
    id,
    label: CHAT_API_FORMATS[id],
  }))

export const ApiProtocolSelect = ({
  value,
  disabled,
  onChange,
  className,
}: {
  value: ChatApiFormat
  disabled: boolean
  onChange: (value: ChatApiFormat) => void
  className?: string
}) => {
  const t = useTranslate()
  return (
    <SettingsChoiceField
      title={t('apiProtocol')}
      value={value}
      fields={protocols}
      disabled={disabled}
      confirm={onChange}
      className={className}
    />
  )
}
