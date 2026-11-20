/** Android's older system WebViews do not implement AbortSignal.throwIfAborted. */
export const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('The request was aborted', 'AbortError')
  }
}
