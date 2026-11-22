import { useEffect, useRef, type RefObject } from 'react'
import type { VoiceTouch } from './useHoldToTalk.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './AndroidVoiceOverlay.module.css'

const bars = Array.from({ length: 48 }, (_, index) => index)

export const AndroidVoiceOverlay = ({
  active,
  canceling,
  level,
  touch,
}: {
  active: boolean
  canceling: boolean
  level: () => number
  touch: RefObject<VoiceTouch | null>
}) => {
  const t = useTranslate()
  const overlay = useRef<HTMLDivElement>(null)
  const waveform = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = overlay.current
    if (!active || !waveform.current || !panel) {
      return
    }
    const elements = Array.from(waveform.current.children) as HTMLElement[]
    const samples = new Float32Array(elements.length / 2)
    let lastSample = 0
    let frame = 0
    let lastTouch: VoiceTouch | null = null
    const draw = (now: number) => {
      const point = touch.current
      if (point && point !== lastTouch) {
        lastTouch = point
        const top = panel.getBoundingClientRect().top
        panel.style.setProperty('--voice-x', `${point.x}px`)
        panel.style.setProperty('--voice-y', `${point.y - top}px`)
      }
      if (now - lastSample >= 26) {
        lastSample = now
        samples.copyWithin(1, 0, -1)
        samples[0] = level()
      }
      elements.forEach((bar, index) => {
        const distance = Math.abs(index - (elements.length - 1) / 2)
        const amplitude = samples[Math.floor(distance)] * Math.pow(1 - distance / 24, 2)
        bar.style.transform = `scaleY(${1 + amplitude * 4.9})`
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [active, level, touch])

  return (
    <div
      ref={overlay}
      className={styles.overlay}
      data-recording={active}
      data-canceling={canceling}
      aria-hidden={!active}
    >
      <div className={styles.color} data-color="blue" />
      <div className={styles.color} data-color="red" />
      <div className={styles.hint} role="status">
        {t(canceling ? 'androidReleaseToCancel' : 'androidSlideToCancel')}
      </div>
      <div className={styles.wave} ref={waveform} aria-hidden="true">
        {bars.map((index) => (
          <span key={index} />
        ))}
      </div>
    </div>
  )
}
