import { useEffect, useState } from 'react'
import { Button } from '../components/base/Button.js'
import { Modal } from '../components/base/Modal.js'
import { useTranslate } from '../i18n/index.js'
import { android } from './android.js'
import { updateMessages, type UpdateStatus } from './updateStatus.js'

/** A foreground check can finish before the WebView has attached its event listener. */
export const AndroidUpdatePrompt = () => {
  const t = useTranslate()
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const [dismissed, setDismissed] = useState(0)

  useEffect(() => {
    if (!android?.updateStatus) {
      return
    }
    const onUpdate = (event: Event) => setStatus((event as CustomEvent<UpdateStatus>).detail)
    window.addEventListener('android-update', onUpdate)
    setStatus(JSON.parse(android.updateStatus()) as UpdateStatus)
    return () => window.removeEventListener('android-update', onUpdate)
  }, [])

  const { version, offer = 0, phase, message, progress } = status
  if (!version || offer <= dismissed || !android) {
    return null
  }
  const close = () => setDismissed(offer)
  const downloading = phase === 'downloading'
  return (
    <Modal
      title={t('updateAvailableTitle')}
      closable
      onClose={close}
      footer={
        <>
          <Button variant="outlined" onClick={close}>
            {t('updateLater')}
          </Button>
          <Button variant="primary" disabled={downloading} onClick={() => android?.installUpdate()}>
            {t(
              phase === 'ready'
                ? 'updateInstall'
                : downloading
                  ? 'updateDownloading'
                  : 'updateDownload'
            )}
          </Button>
        </>
      }
    >
      <p>{t('updateAvailableDescription', { version: `v${version}` })}</p>
      {downloading && progress !== undefined ? (
        <progress aria-label={t('updateDownloading')} max={100} value={progress} />
      ) : null}
      {message && !status.automatic ? <p role="alert">{t(updateMessages[message])}</p> : null}
    </Modal>
  )
}
