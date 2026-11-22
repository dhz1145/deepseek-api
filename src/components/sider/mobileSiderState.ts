import { create } from 'zustand'
import { isAndroidTablet } from '../../app/viewport.js'

/** 窄屏使用抽屉，Android 宽屏使用可独立开合的分栏。 */
export const useMobileSider = create(() => ({ open: isAndroidTablet() }))

export const openMobileSider = () => useMobileSider.setState({ open: true })

export const closeMobileSider = () => useMobileSider.setState({ open: false })

export const toggleMobileSider = () => useMobileSider.setState((state) => ({ open: !state.open }))

export const closeOverlaySider = () => {
  if (!isAndroidTablet()) {
    closeMobileSider()
  }
}
