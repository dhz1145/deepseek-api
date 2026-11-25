import { asString, firstChatChoice, record, type OpenAIFrame } from './openaiChat.js'
import { createResponsesStream } from './responsesStream.js'
import type { MessageStreamEvent } from './types.js'

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Normalize Chat Completions deltas to the same chat blocks as Responses. */
export const createCompletionsStream = () => {
  const read = createResponsesStream(true)
  let thoughtIndex = 0
  let thinkingOpen = false
  const thought = (delta: string) => {
    thinkingOpen = true
    return read({ output_index: thoughtIndex }, delta)
  }
  function* endThought(): Generator<MessageStreamEvent> {
    if (!thinkingOpen) {
      return
    }
    thinkingOpen = false
    yield* read({
      type: 'response.output_item.done',
      output_index: thoughtIndex++,
      item: { type: 'reasoning' },
    })
  }
  const callEvent = (value: unknown, done: boolean) => {
    const call = record(value)
    return read({
      type: done ? 'response.output_item.done' : 'response.output_item.added',
      item: {
        ...call,
        type: 'web_search_call',
        kind: call.kind ?? (call.type === 'deepseek_read_url' ? 'read_link' : undefined),
        status: call.status ?? (done ? 'completed' : 'in_progress'),
        action: { ...record(call.action), sources: call.sources ?? record(call.action).sources },
      },
    })
  }
  function* chunk(
    payload: unknown,
    { thinking, text }: OpenAIFrame
  ): Generator<MessageStreamEvent> {
    const choice = firstChatChoice(record(payload))
    const delta = record(choice.delta ?? choice.message)
    const event = record(choice.server_tool_event)
    const nonStreaming = Boolean(choice.message && !choice.delta)
    if (nonStreaming) {
      for (const value of array(delta.server_tool_calls)) {
        const step = record(value)
        const trace = asString(step.reasoning_content)
        if (trace) {
          yield* thought(trace)
          yield* endThought()
        }
        for (const call of array(step.calls)) {
          yield* callEvent(call, true)
        }
      }
    }
    if (thinking) {
      yield* thought(thinking)
    }
    if (event.type === 'step_reasoning_done') {
      yield* endThought()
    } else if (event.type === 'call_started' || event.type === 'call_completed') {
      yield* callEvent(event.call, event.type === 'call_completed')
    }
    if (!nonStreaming) {
      // The terminal chunk carries complete call metadata, including signed pages and any failures.
      for (const value of array(delta.server_tool_calls)) {
        for (const call of array(record(value).calls)) {
          yield* callEvent(call, true)
        }
      }
    }
    if (text) {
      yield* endThought()
      yield* read({ type: 'response.output_text.delta', delta: text })
    }
    for (const value of array(delta.annotations ?? choice.annotations)) {
      const annotation = record(value)
      if (annotation.type === 'url_citation') {
        yield* read({
          type: 'response.output_text.annotation.added',
          annotation: {
            ...record(annotation.url_citation ?? annotation),
            type: 'url_citation',
          },
        })
      }
    }
  }
  return { chunk, finish: () => read({ type: 'response.completed' }) }
}
