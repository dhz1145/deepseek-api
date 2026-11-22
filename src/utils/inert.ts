/** 在不支持原生 inert（Chrome < 102）的 WebView 上同步属性与焦点移除。 */
export const setInert = (element: HTMLElement | null, inert: boolean) => {
  if (!element) {
    return
  }
  element.inert = inert
  element.toggleAttribute('inert', inert)
  if (
    inert &&
    element.contains(document.activeElement) &&
    document.activeElement instanceof HTMLElement
  ) {
    document.activeElement.blur()
  }
}
