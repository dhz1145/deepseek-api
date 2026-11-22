import './utils/abort.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { android } from './app/android.js'
import { setupTheme } from './app/theme.js'
import './app/theme.css'
import './app/global.css'
import './app/android.css'

if (android) {
  const root = document.documentElement
  const buttonNavigationInset = android.buttonNavigationInset()
  root.dataset.android = ''
  root.style.setProperty('--android-status-inset', `${android.statusInset()}px`)
  root.style.setProperty('--android-button-nav-inset', `${buttonNavigationInset}px`)
  root.toggleAttribute('data-button-navigation', buttonNavigationInset > 0)
}
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
