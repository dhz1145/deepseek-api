import { readBlobChunks } from '../utils/blob.js'

type AndroidBridge = {
  statusInset: () => number
  buttonNavigationInset: () => number
  systemFontScale: () => number
  openAppPermissions: () => void
  reasoningAliasesUrl?: () => string
  updateStatus: () => string
  checkForUpdate: () => void
  installUpdate: () => void
  getMusicVolume?: () => number
  openSourcePage: (
    url: string,
    dark: boolean,
    closeLabel: string,
    browserLabel: string,
    loadingLabel: string,
    errorLabel: string,
    retryLabel: string
  ) => void
  readApiKey: () => string | null
  writeApiKey: (value: string | null) => boolean
  readAccountProfile: () => string | null
  writeAccountProfile: (value: string | null) => boolean
  systemDarkMode?: () => boolean
  consumeStartupAnimation?: () => boolean
  onStartupFrameReady?: () => void
  setDarkBars: (dark: boolean) => void
  setHandlesBack: (handlesBack: boolean) => void
  setBackPreviewEnabled: (enabled: boolean) => void
  setImageViewerFullscreen: (fullscreen: boolean) => void
  requestRecentPhotos: () => void
  prefetchRecentPhotos: () => void
  requestHistoryExport: (name: string) => void
  writeHistoryExport: (bytes: string) => boolean
  finishHistoryExport: () => boolean
  beginImageSave: (name: string, mime: string) => boolean
  writeImageSave: (bytes: string) => boolean
  finishImageSave: (keep: boolean) => boolean
  requestRecording: () => void
  finishRecording: (keep: boolean) => boolean
  recordingLevel: () => number
  setSelectionExclusion?: (
    startLeft: number,
    startTop: number,
    startRight: number,
    startBottom: number,
    endLeft: number,
    endTop: number,
    endRight: number,
    endBottom: number,
    active: boolean
  ) => void
}

export const android = (window as Window & { DeepSeekAndroid?: AndroidBridge }).DeepSeekAndroid

const writeAndroidBlob = async (blob: Blob, append: (base64: string) => boolean) => {
  const chunkSize = 32768
  for await (const chunk of readBlobChunks(blob)) {
    for (let offset = 0; offset < chunk.length; offset += chunkSize) {
      const base64 = btoa(String.fromCharCode(...chunk.subarray(offset, offset + chunkSize)))
      if (!append(base64)) {
        throw new Error('Unable to write the file')
      }
    }
  }
}

export const saveAndroidHistory = async (name: string, blob: Blob): Promise<boolean> => {
  const device = android
  if (!device) {
    return false
  }
  const status = await new Promise<string>((resolve) => {
    window.addEventListener(
      'android-export',
      (event) => resolve((event as CustomEvent<string>).detail),
      { once: true }
    )
    device.requestHistoryExport(name)
  })
  if (status === 'cancelled') {
    return false
  }
  if (status !== 'ready') {
    throw new Error('Unable to open the export document')
  }
  let closed = false
  try {
    await writeAndroidBlob(blob, (base64) => device.writeHistoryExport(base64))
    closed = device.finishHistoryExport()
    if (!closed) {
      throw new Error('Unable to close the export document')
    }
    return true
  } finally {
    if (!closed) {
      device.finishHistoryExport()
    }
  }
}

export const saveAndroidImage = async (name: string, blob: Blob) => {
  const device = android
  if (!device?.beginImageSave(name, blob.type)) {
    throw new Error('Unable to create the image')
  }
  try {
    await writeAndroidBlob(blob, (base64) => device.writeImageSave(base64))
  } catch (error) {
    device.finishImageSave(false)
    throw error
  }
  if (!device.finishImageSave(true)) {
    throw new Error('Unable to save the image')
  }
}
