import type { TranslationKey } from '../i18n/index.js'

export const updateMessages = {
  current: 'updateCurrent',
  checkFailed: 'updateCheckFailed',
  downloadFailed: 'updateDownloadFailed',
  invalidApk: 'updateInvalidApk',
  apkContents: 'updateApkContents',
  apkPackage: 'updateApkPackage',
  apkVersion: 'updateApkVersion',
  apkAndroid: 'updateApkAndroid',
  apkSignature: 'updateApkSignature',
  apkMissing: 'updateApkMissing',
  permissionDenied: 'updatePermissionDenied',
  installerUnavailable: 'updateInstallerUnavailable',
} satisfies Record<string, TranslationKey>

export type UpdateStatus = {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready'
  version?: string
  progress?: number
  offer?: number
  automatic?: boolean
  message?: keyof typeof updateMessages
}
