import { useEffect, useState } from 'react'
import { loadFile } from '../../services/chat/db.js'
import { createFileView } from '../../services/filePreview.js'

type FileView = Awaited<ReturnType<typeof createFileView>>

/** undefined 表示尚未加载，null 表示原件不可用。仅预览副本改变 MIME，原件不变。 */
export const useFileView = (source: File | string | undefined, name: string | undefined) => {
  const [state, setState] = useState<{
    source: File | string
    name: string
    view: FileView | null
  }>()
  useEffect(() => {
    if (source === undefined || name === undefined) {
      return
    }
    let active = true
    const original = typeof source === 'string' ? loadFile(source) : Promise.resolve(source)
    const pending = original
      .then((blob) => (active && blob ? createFileView(blob, name) : null))
      .catch(() => null)
    void pending.then((view) => {
      if (active) {
        setState({ source, name, view })
      }
    })
    return () => {
      active = false
      void pending.then((view) => {
        if (view?.url.startsWith('blob:')) {
          URL.revokeObjectURL(view.url)
        }
      })
    }
  }, [source, name])

  return state && state.source === source && state.name === name ? state.view : undefined
}
