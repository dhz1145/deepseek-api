import { useEffect, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { android } from '../../app/android.js'
import whale from '../../assets/deepseek-whale.svg'
import {
  useAndroidColdStartGreeting,
  useAndroidWelcomeMessages,
  useTranslate,
} from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

let coldStartGreetingPending = true

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = ({ startup = false }: { startup?: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const coldStartGreeting = useAndroidColdStartGreeting()
  const androidMessages = useAndroidWelcomeMessages()
  const [coldStart] = useState(coldStartGreetingPending)
  const [welcomeSample] = useState(() => (android ? Math.random() : 0))
  const greeting = !android
    ? t('welcomeMessageChat250808')
    : coldStart
      ? coldStartGreeting
      : androidMessages[Math.floor(welcomeSample * androidMessages.length)]
  useEffect(() => {
    if (android) {
      coldStartGreetingPending = false
    }
  }, [])
  return (
    <div
      className={styles.container}
      data-drawer-free-pan={android ? '' : undefined}
      data-chat-startup={startup ? '' : undefined}
    >
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          {android ? <img src={whale} width={42} height={42} alt="" /> : null}
          {greeting}
        </div>
        <ChatInput sessionId={null} />
        {isMobile && !android ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
