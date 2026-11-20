import { throwIfAborted } from '../../utils/abort.js'
import { isContextOverflow } from '../api/errors.js'
import { getContextRounds, getReplyText } from './reply.js'
import type {
  AssistantMessage,
  ContextCheckpoint,
  FileAttachment,
  Message,
  UserMessage,
} from './types.js'

const WINDOW_TOKENS = 1_048_576
const HEADROOM_TOKENS = 65_536
export const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_BATCH_TOKENS = 96 * 1024
const CHECKPOINT_LIMIT = 16

export const contextBudget = (outputTokens: number, window = WINDOW_TOKENS) => ({
  input: Math.min(
    Math.floor(window * 0.8),
    window - outputTokens - Math.min(HEADROOM_TOKENS, window / 8)
  ),
  recent: Math.floor((window - outputTokens) * 0.16),
})

/** 文件和阅读链接会在服务端展开。这里只估算，实际超限由 API 响应兜底。 */
export const estimateTextTokens = (text: string): number => {
  let nonAscii = 0
  for (let index = 0; index < text.length; index++) {
    nonAscii += Number(text.charCodeAt(index) > 127)
  }
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii * 1.25)
}

const estimateFileTokens = (file: FileAttachment) => {
  // 导入后只有文件名和大小的占位附件不会进入请求。
  if (!file.serverId && !file.mimeType) {
    return 0
  }
  return file.isImage ? 4_096 : Math.min(131_072, Math.max(512, Math.ceil(file.size / 2)))
}

export const estimateQuestionTokens = ({ content, files }: UserMessage) =>
  16 +
  estimateTextTokens(content) +
  files.reduce((total, file) => total + estimateFileTokens(file), 0)

export const estimatePrefixTokens = (prefix?: AssistantMessage) =>
  prefix?.blocks.reduce((total, block) => {
    if (block.type === 'text') {
      return total + estimateTextTokens(block.text)
    }
    if (block.type === 'thinking') {
      return total + estimateTextTokens(block.thinking)
    }
    return total
  }, 0) ?? 0

/** 返回可放入预算的前缀长度，优先在换行处结束，避免截断 Unicode 字符。 */
export const textPrefixLength = (text: string, budget: number): number => {
  if (budget <= 0) {
    return 0
  }
  let length = Math.min(text.length, budget * 3)
  for (;;) {
    const next = text.charCodeAt(length)
    if (length > 0 && next >= 0xdc00 && next <= 0xdfff) {
      length--
    }
    const cost = estimateTextTokens(text.slice(0, length))
    if (cost <= budget) {
      break
    }
    length = Math.floor((length * budget) / cost)
  }
  if (length > 0 && length < text.length) {
    const newline = text.lastIndexOf('\n', length - 1) + 1
    if (newline > length / 2) {
      return newline
    }
  }
  return length
}

type Round = [UserMessage, AssistantMessage]
type Cursor = { index: number; offset: number }
type SummaryRequest = { previous?: string; excerpts: string[] }
export type HistoryContext = { history: Message[]; summary?: string; tokens: number }

const roundTokens = ([user, reply]: Round) => {
  const links = reply.blocks.filter((block) => block.type === 'web_fetch_tool_result').length
  return estimateQuestionTokens(user) + estimateTextTokens(getReplyText(reply)) + links * 8_192 + 32
}

const roundText = ([user, reply]: Round) => {
  const files = user.files.map(({ name }) => name)
  const links = reply.blocks.flatMap((block) =>
    block.type === 'server_tool_use' && 'url' in block.input && block.input.url
      ? [block.input.url]
      : []
  )
  return [
    '用户',
    user.content,
    ...(files.length ? ['附件', JSON.stringify(files)] : []),
    '助手',
    getReplyText(reply),
    ...(links.length ? ['参考链接', JSON.stringify(links)] : []),
  ].join('\n')
}

const fitRecent = (costs: number[], after: number, budget: number) => {
  let index = costs.length
  let tokens = 0
  while (index > after && tokens + costs[index - 1] <= budget) {
    tokens += costs[--index]
  }
  return { index, tokens }
}

const readBatch = (rounds: Round[], cursor: Cursor, end: number, budget: number) => {
  const excerpts: string[] = []
  let { index, offset } = cursor
  while (index < end && budget >= 128) {
    const content = roundText(rounds[index]).slice(offset)
    const length = textPrefixLength(content, budget - 64)
    if (length < content.length && excerpts.length) {
      break
    }
    const excerpt = content.slice(0, length)
    excerpts.push(excerpt)
    budget -= estimateTextTokens(excerpt) + 64
    if (length < content.length) {
      offset += length
      break
    }
    index++
    offset = 0
  }
  return { excerpts, next: { index, offset } }
}

export const saveContextCheckpoint = (
  checkpoints: ContextCheckpoint[] | undefined,
  checkpoint: ContextCheckpoint
) =>
  [
    ...(checkpoints ?? []).filter(({ replyId }) => replyId !== checkpoint.replyId),
    checkpoint,
  ].slice(-CHECKPOINT_LIMIT)

export const prepareHistoryContext = async ({
  history,
  checkpoints,
  budget,
  recentBudget,
  summarize,
  save,
  signal,
  batchBudget = SUMMARY_BATCH_TOKENS,
}: {
  history: Message[]
  checkpoints?: ContextCheckpoint[]
  budget: number
  recentBudget: number
  summarize: (request: SummaryRequest) => Promise<string | null>
  save: (checkpoint: ContextCheckpoint) => void
  signal: AbortSignal
  batchBudget?: number
}): Promise<HistoryContext> => {
  throwIfAborted(signal)
  if (budget < 64) {
    return { history: [], tokens: 0 }
  }
  const rounds = getContextRounds(history)
  const costs = rounds.map(roundTokens)
  const byReply = new Map(checkpoints?.map((checkpoint) => [checkpoint.replyId, checkpoint]))
  let index = rounds.findLastIndex(([, reply]) => byReply.has(reply.id))
  let checkpoint = index >= 0 ? byReply.get(rounds[index][1].id) : undefined
  if (!checkpoint?.offset) {
    index++
  }
  let cursor = { index, offset: checkpoint?.offset ?? 0 }
  const remaining = fitRecent(costs, cursor.index, budget - summaryTokens(checkpoint?.summary))
  if (remaining.index > cursor.index || cursor.offset) {
    const summaryReserve = Math.max(
      Math.min(SUMMARY_OUTPUT_TOKENS, Math.floor(budget / 4)),
      summaryTokens(checkpoint?.summary)
    )
    const recentTarget = Math.max(recentBudget, costs.at(-1) ?? 0)
    const end = Math.max(
      cursor.index + Number(cursor.offset > 0),
      fitRecent(costs, cursor.index, Math.min(budget - summaryReserve, recentTarget)).index
    )
    const firstBatchBudget = batchBudget
    while (cursor.index < end && batchBudget >= 128) {
      throwIfAborted(signal)
      const { excerpts, next } = readBatch(rounds, cursor, end, batchBudget)
      try {
        const summary = await summarize({ previous: checkpoint?.summary, excerpts })
        throwIfAborted(signal)
        if (!summary) {
          break
        }
        cursor = next
        checkpoint = {
          replyId: rounds[cursor.offset ? cursor.index : cursor.index - 1][1].id,
          summary,
          offset: cursor.offset || undefined,
        }
        save(checkpoint)
        batchBudget = firstBatchBudget
      } catch (error) {
        throwIfAborted(signal)
        if (!isContextOverflow(error)) {
          break
        }
        batchBudget = Math.floor(batchBudget / 2)
      }
    }
  }
  const after = cursor.index + Number(cursor.offset > 0)
  const latest = after < costs.length ? (costs.at(-1) ?? 0) : 0
  const summaryBudget = latest <= budget ? budget - latest : budget
  const summary =
    checkpoint && summaryTokens(checkpoint.summary) <= summaryBudget
      ? checkpoint.summary
      : undefined
  const retained = fitRecent(costs, after, budget - summaryTokens(summary))
  return {
    history: rounds.slice(retained.index).flat(),
    summary,
    tokens: retained.tokens + summaryTokens(summary),
  }
}

const summaryTokens = (summary?: string) => (summary ? estimateTextTokens(summary) + 64 : 0)
