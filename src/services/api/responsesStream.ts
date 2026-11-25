import { asString, record } from './openaiChat.js'
import type { MessageStreamEvent, OutputBlockStart, ServerToolUseBlock } from './types.js'

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const strings = (value: unknown): string[] =>
  list(value).filter((item): item is string => typeof item === 'string')
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const searchCall = (item: Record<string, unknown>): ServerToolUseBlock | undefined => {
  const id = asString(item.id)
  if (item.type !== 'web_search_call' || !id) {
    return
  }
  const action = record(item.action)
  const name: ServerToolUseBlock['name'] =
    item.kind === 'read_link' ? 'deepseek_read_url' : 'deepseek_web_search'
  const base = { type: 'server_tool_use' as const, id, name, caller: { type: 'direct' as const } }
  const url = asString(action.url) ?? ''
  if (item.kind === 'read_link') {
    return { ...base, kind: 'read_link', input: { action: 'read_link', url } }
  }
  if (action.type === 'open_page' || action.type === 'find_in_page') {
    return {
      ...base,
      kind: 'deep_search',
      input:
        action.type === 'open_page'
          ? { action: 'open_page', url }
          : { action: 'find_in_page', url, pattern: asString(action.pattern) ?? '' },
    }
  }
  if (action.type === 'search' || (item.status !== 'in_progress' && item.status !== 'searching')) {
    const kind =
      item.kind === 'image_search' ||
      item.kind === 'deep_image_search' ||
      item.kind === 'deep_search'
        ? item.kind
        : 'search'
    const query = asString(action.query)
    const queries = strings(action.queries)
    return {
      ...base,
      kind,
      input: { action: 'search', queries: queries.length ? queries : query ? [query] : [] },
    }
  }
  return undefined
}

const searchResult = (
  item: Record<string, unknown>,
  { id, input, kind }: ServerToolUseBlock
): OutputBlockStart => {
  const failed = item.status === 'failed' || Boolean(item.error)
  if (kind === 'read_link' || (kind === 'deep_search' && input.action !== 'search')) {
    const page = record(item.page)
    const code = record(item.error).code
    return {
      type: 'web_fetch_tool_result',
      kind,
      tool_use_id: id,
      signature: failed ? undefined : asString(item.signature),
      content: failed
        ? {
            type: 'web_fetch_tool_result_error',
            error_code:
              code === 'url_not_accessible' || code === 'url_not_allowed' ? code : 'unavailable',
          }
        : {
            type: 'web_fetch_result',
            url:
              asString(page.url) ??
              (kind === 'read_link' || input.action === 'search' ? '' : input.url),
            content: {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: '' },
              title: asString(page.title) ?? null,
            },
            published_at: asString(page.published_at) ?? null,
          },
    }
  }
  return {
    type: 'web_search_tool_result',
    kind,
    tool_use_id: id,
    content: failed
      ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
      : list(record(item.action).sources).flatMap((entry) => {
          const source = record(entry)
          const url = asString(source.url)
          return url
            ? [
                {
                  type: 'web_search_result',
                  url,
                  title: asString(source.title) ?? '',
                  image_url: asString(source.image_url),
                  snippet: asString(source.snippet) ?? '',
                  site_icon: asString(source.site_icon) ?? null,
                  site_name: asString(source.site_name) ?? null,
                  encrypted_content: '',
                  page_age: asString(source.published_at) ?? null,
                },
              ]
            : []
        }),
  }
}

/** Convert Responses output items to the existing chat blocks without a second rendering path. */
export const createResponsesStream = (deferredReadLinkSignatures = false) => {
  let nextIndex = 0
  const textIndexes = new Map<string, number>()
  const textSeen = new Set<string>()
  const citations = new Set<string>()
  const thoughts = new Map<number, { index: number; part: number; done: boolean }>()
  const calls = new Map<string, ServerToolUseBlock>()
  const completedCalls = new Set<string>()
  const unsignedLinks = new Map<string, number>()

  function* atomic(content_block: OutputBlockStart): Generator<MessageStreamEvent> {
    const index = nextIndex++
    yield { type: 'content_block_start', index, content_block }
    yield { type: 'content_block_stop', index }
  }
  function* text(key: string, delta?: string, annotation?: unknown): Generator<MessageStreamEvent> {
    const entry = record(annotation)
    const url = entry.type === 'url_citation' ? asString(entry.url) : undefined
    if (!delta && !url) {
      return
    }
    let index = textIndexes.get(key)
    if (index === undefined) {
      index = nextIndex++
      textIndexes.set(key, index)
      yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
    }
    if (delta) {
      textSeen.add(key)
      yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } }
    }
    if (url) {
      const end_index = number(entry.end_index)
      const id = JSON.stringify([key, url, end_index])
      if (!citations.has(id)) {
        citations.add(id)
        yield {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'web_search_result_location',
              url,
              title: asString(entry.title) ?? null,
              cited_text: '',
              encrypted_index: '',
              end_index,
            },
          },
        }
      }
    }
  }
  function* thought(output: number, part: number, delta: string): Generator<MessageStreamEvent> {
    let block = thoughts.get(output)
    if (!block) {
      block = { index: nextIndex++, part, done: false }
      thoughts.set(output, block)
      yield {
        type: 'content_block_start',
        index: block.index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }
    }
    if (!block.done) {
      const thinking = part > block.part ? `\n\n${delta}` : delta
      block.part = part
      yield {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'thinking_delta', thinking },
      }
    }
  }
  function* item(value: unknown, output: number, done: boolean): Generator<MessageStreamEvent> {
    const outputItem = record(value)
    if (outputItem.type === 'web_search_call') {
      const id = asString(outputItem.id)
      if (!id) {
        return
      }
      if (completedCalls.has(id)) {
        const index = unsignedLinks.get(id)
        const signature = asString(outputItem.signature)
        if (index !== undefined && signature) {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'signature_delta', signature },
          }
          yield { type: 'content_block_stop', index }
          unsignedLinks.delete(id)
        }
        return
      }
      const call = calls.get(id) ?? searchCall(outputItem)
      if (call && !calls.has(id)) {
        calls.set(id, call)
        yield* atomic(call)
      }
      if (
        call &&
        done &&
        outputItem.status !== 'in_progress' &&
        outputItem.status !== 'searching'
      ) {
        completedCalls.add(id)
        const result = searchResult(outputItem, call)
        if (
          deferredReadLinkSignatures &&
          result.type === 'web_fetch_tool_result' &&
          result.kind === 'read_link' &&
          result.content.type === 'web_fetch_result' &&
          !result.signature
        ) {
          const index = nextIndex++
          unsignedLinks.set(id, index)
          yield { type: 'content_block_start', index, content_block: result }
        } else {
          yield* atomic(result)
        }
      }
    } else if (done && outputItem.type === 'message') {
      for (const [part, value] of list(outputItem.content).entries()) {
        const content = record(value)
        const key = `${output}:${part}`
        if (content.type === 'output_text' || content.type === 'refusal') {
          if (!textSeen.has(key)) {
            yield* text(key, asString(content.text) ?? asString(content.refusal))
          }
          for (const annotation of list(content.annotations)) {
            yield* text(key, undefined, annotation)
          }
        }
      }
    } else if (done && outputItem.type === 'reasoning') {
      if (!thoughts.has(output)) {
        const parts = list(outputItem.content).length
          ? list(outputItem.content)
          : list(outputItem.summary)
        for (const [part, value] of parts.entries()) {
          const delta = asString(record(value).text)
          if (delta) {
            yield* thought(output, part, delta)
          }
        }
      }
      const block = thoughts.get(output)
      if (block && !block.done) {
        block.done = true
        yield { type: 'content_block_stop', index: block.index }
      }
    }
  }

  return function* (value: unknown, thinking?: string): Generator<MessageStreamEvent> {
    const payload = record(value)
    const output = number(payload.output_index) ?? 0
    const key = `${output}:${number(payload.content_index) ?? 0}`
    if (thinking) {
      yield* thought(output, number(payload.summary_index ?? payload.content_index) ?? 0, thinking)
    } else {
      switch (payload.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          yield* text(key, asString(payload.delta))
          break
        case 'response.output_text.annotation.added':
          yield* text(key, undefined, payload.annotation)
          break
        case 'response.output_item.added':
        case 'response.output_item.done':
          yield* item(payload.item, output, payload.type === 'response.output_item.done')
          break
        case 'response.completed':
        case 'response.incomplete': {
          for (const [index, value] of list(record(payload.response).output).entries()) {
            yield* item(value, index, true)
          }
          const openThoughts = [...thoughts.values()]
            .filter(({ done }) => !done)
            .map(({ index }) => index)
          for (const index of [
            ...openThoughts,
            ...textIndexes.values(),
            ...unsignedLinks.values(),
          ]) {
            yield { type: 'content_block_stop', index }
          }
          break
        }
      }
    }
  }
}
