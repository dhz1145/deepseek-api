import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { SERVER_DEFAULT_EFFORT } from '../../services/api/modelReasoning.js'
import { getReasoningChoice, useSettings } from '../../services/settings.js'

const effortNames: Record<string, TranslationKey> = {
  [SERVER_DEFAULT_EFFORT]: 'reasoningEffortServerDefault',
  none: 'reasoningEffortNone',
  minimal: 'reasoningEffortMinimal',
  low: 'reasoningEffortLow',
  medium: 'reasoningEffortMedium',
  high: 'reasoningEffortHigh',
  xhigh: 'reasoningEffortXhigh',
  max: 'reasoningEffortMax',
}

export const useReasoningChoice = () => {
  const t = useTranslate()
  const state = useSettings()
  const { effort, efforts } = getReasoningChoice(state)
  const label = (id: string) => (Object.hasOwn(effortNames, id) ? t(effortNames[id]) : id)
  const ready = Boolean(state.apiKey && state.chatModel)
  return {
    title: t('defaultReasoningEffort'),
    ready,
    value: ready ? effort : null,
    valueLabel: ready ? label(effort) : t('apiModelChoose'),
    fields: [SERVER_DEFAULT_EFFORT, ...efforts].map((id) => ({ id, label: label(id) })),
  }
}
