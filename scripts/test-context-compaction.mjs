import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { strToU8, zipSync } from 'fflate'
import { PDFDocument, rgb } from 'pdf-lib'

// node --experimental-transform-types --test scripts/test-context-compaction.mjs
// 使用实际聊天 store 和 SSE 解析，只替换 IndexedDB 与网络。
const source = new URL('../src/', import.meta.url)
const db = new URL('./services/chat/db.ts', source).href
const databaseMock = new URL(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        'export const sessions = new Map()',
        'export const files = new Map()',
        'export const saveSession = async (session, attachments = []) => {',
        '  sessions.set(session.id, structuredClone(session))',
        '  for (const { id, blob } of attachments) files.set(id, blob)',
        '}',
        'export const loadSession = async (id) => structuredClone(sessions.get(id))',
        'export const loadFile = async (id) => files.get(id)',
        'export const reportStorageError = () => (error) => { throw error }',
      ].join('\n')
    )
).href

registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.startsWith(source.href) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (target.href === db) {
        return next(databaseMock, context)
      }
      if (existsSync(target)) {
        return next(target.href, context)
      }
    }
    return next(specifier, context)
  },
})

globalThis.window = new EventTarget()
globalThis.document = { visibilityState: 'hidden' }
const storage = new Map([
  ['replica:pinned-sessions', '["existing-session"]'],
  ['replica:font-size', '5'],
  ['dsapi:font-size', '4'],
])
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
})
globalThis.cancelAnimationFrame = () => {}
globalThis.__API_ORIGIN__ = 'https://mock.invalid'
const { ApiError, listChatModels } = await import('../src/services/api/client.ts')
const { chatConfigFor } = await import('../src/services/api/chatConfig.ts')
const { modelReasoning, readModelReasoning, restoreModelReasoning } =
  await import('../src/services/api/modelReasoning.ts')
const { isOfficialApiAddress, parseApiAddress } = await import('../src/services/api/address.ts')
const { isContextOverflow } = await import('../src/services/api/errors.ts')
const {
  contextBudget,
  estimateBranchScale,
  estimateTextTokens,
  prepareHistoryContext,
  resolveMaxOutputTokens,
  saveContextCheckpoint,
  textPrefixLength,
} = await import('../src/services/chat/context.ts')
const { createContextSummarizer, includeContextSummary, summarizeCurrentInput } =
  await import('../src/services/chat/contextSummary.ts')
const { addDraftFiles, setDraftText } = await import('../src/services/chat/drafts.ts')
const {
  continueReply,
  regenerateReply,
  sendMessage,
  selectMessageVersion,
  stopReply,
  useChatStore,
} = await import('../src/services/chat/store.ts')
const { readSessionFile } = await import('../src/services/chat/history/schema.ts')
const { toSessionFile } = await import('../src/services/chat/history/toArchive.ts')
const { sessions, files, loadFile } = await import(databaseMock)
const {
  getReasoningChoice, setApiKey, setChatModel, setFontSize, setPinnedSessions,
  setReasoningEffort, updateChatModels, useSettings,
} = await import('../src/services/settings.ts')

test('旧版设置迁到 dsapi 前缀，不覆盖已经保存的新值', () => {
  assert.deepEqual(useSettings.getState().pinnedSessions, ['existing-session'])
  assert.equal(storage.get('dsapi:pinned-sessions'), '["existing-session"]')
  assert.equal(storage.has('replica:pinned-sessions'), false)
  assert.equal(useSettings.getState().fontSize, 4)
  setFontSize(3)
  assert.equal(storage.get('dsapi:font-size'), '3')
  assert.equal(storage.has('replica:font-size'), false)
  setPinnedSessions([])
})

const notes = (details) =>
  [
    '## 目标与约束',
    '保留用户要求和明确更正。',
    '## 已确认的进展',
    details,
    '## 待解决问题',
    '无',
    '## 关键资料',
    '原始会话',
  ].join('\n')

const overflow = () =>
  new ApiError('http', 'Input token exceed the limit', 400, 'quota_limit_reached')
const newSignal = () => new AbortController().signal
const user = (id, content, files = []) => ({ id, role: 'user', content, files, createdAt: 0 })
const reply = (id, text) => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  createdAt: 0,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
})
const round = (id, question, answer = id) => [user(id + ':user', question), reply(id, answer)]
const documentFile = (id, name, size) => ({
  id,
  name,
  size,
  isImage: false,
  mimeType: 'text/plain',
  serverId: 'file-' + id,
})

const options = (history, overrides = {}) => ({
  history,
  budget: 640,
  recentBudget: 180,
  batchBudget: 512,
  signal: newSignal(),
  save: () => {},
  summarize: async () => 'short summary',
  ...overrides,
})

const stream = (text, reason = 'end_turn', afterText = []) =>
  new Response(
    [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      ...afterText,
      { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null } },
      { type: 'message_stop' },
    ]
      .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
const httpOverflow = () =>
  Response.json(
    { error: { message: 'Input token exceed the limit', code: 'quota_limit_reached' } },
    { status: 400 }
  )
let respond = () => {
  throw new Error('Unexpected request')
}
let respondToFile
globalThis.fetch = async (url, init) => {
  assert.equal(init.headers['x-api-key'], 'test-key')
  if (respondToFile && url.startsWith('https://mock.invalid/anthropic/v1/files')) {
    return respondToFile(url, init)
  }
  assert.equal(url, 'https://mock.invalid/anthropic/v1/messages')
  return respond(JSON.parse(init.body))
}

test('普通历史完整回传，额度错误和上下文错误分别识别', async () => {
  const metadataOnly = {
    ...documentFile('imported', 'large.pdf', 40_000_000),
    serverId: null,
    mimeType: '',
  }
  const history = [user('a:user', 'hello', [metadataOnly]), reply('a', 'A'), ...round('b', 'world')]
  const result = await prepareHistoryContext(options(history, { summarize: assert.fail }))
  assert.deepEqual(result.history, history)
  assert.equal(result.summary, undefined)
  assert.ok(isContextOverflow(overflow()))
  assert.ok(
    isContextOverflow(new ApiError('stream', 'limit', undefined, 'context_length_exceeded'))
  )
  assert.equal(
    isContextOverflow(
      new ApiError(
        'http',
        'Input tokens exceed the monthly usage limit',
        400,
        'quota_limit_reached'
      )
    ),
    false
  )
  assert.equal(isContextOverflow(new ApiError('http', 'invalid file_id', 400)), false)
})

test('摘要插入请求时保留附件在文本之前，避免修改原始内容块', () => {
  const file = { type: 'document', source: { type: 'file', file_id: 'file-test' } }
  const content = [file, { type: 'text', text: '原始问题' }]
  const messages = [
    { role: 'latest_reminder', content: 'language' },
    { role: 'user', content },
  ]
  includeContextSummary(messages, '较早上下文')
  assert.equal(messages[0].role, 'latest_reminder')
  assert.equal(messages[1].content[0], file)
  assert.match(messages[1].content[1].text, /较早上下文/)
  assert.equal(messages[1].content[2], content[1])
  assert.equal(content.length, 2)
})

test('长历史逐批压缩，遇到真实超限缩小同一批，并保留近期原文', async () => {
  const history = Array.from({ length: 8 }, (_, index) =>
    round('r' + index, '第' + index + '轮' + '中'.repeat(220))
  ).flat()
  let checkpoints = []
  const attempts = []
  const result = await prepareHistoryContext(
    options(history, {
      summarize: async ({ previous, excerpts }) => {
        attempts.push(excerpts.join(''))
        if (attempts.length > 1) assert.ok(previous || attempts.length === 2)
        if (attempts.length === 1) throw overflow()
        return 'summary from batch ' + attempts.length
      },
      save: (checkpoint) => {
        checkpoints = saveContextCheckpoint(checkpoints, checkpoint)
      },
      recentBudget: 420,
    })
  )
  assert.ok(attempts.length > 2)
  assert.ok(attempts[0].startsWith(attempts[1]))
  assert.ok(attempts[1].length < attempts[0].length)
  assert.equal(checkpoints.at(-1).offset, undefined)
  assert.equal(result.summary, checkpoints.at(-1).summary)
  assert.deepEqual(result.history, history.slice(-2))
  assert.equal(history.length, 16)
})

test('一个超长旧轮次可以保存中间进度，下次从相同字符边界继续', async () => {
  const history = [...round('huge', '甲'.repeat(2_400)), ...round('tail', '保持原句')]
  let checkpoint
  let first
  await prepareHistoryContext(
    options(history, {
      summarize: async ({ excerpts }) => {
        if (first) return null
        first = excerpts[0]
        return 'partial'
      },
      save: (value) => {
        checkpoint = value
      },
    })
  )
  assert.ok(checkpoint.offset > 0)
  assert.equal(checkpoint.replyId, 'huge')
  const result = await prepareHistoryContext(
    options(history, {
      checkpoints: [checkpoint],
      summarize: async ({ previous, excerpts }) => {
        assert.equal(previous, 'partial')
        assert.ok(excerpts[0].startsWith('甲'))
        return null
      },
    })
  )
  assert.deepEqual(result.history, history.slice(-2))
  assert.equal(result.summary, 'partial')
  const unicode = '🙂'.repeat(8)
  assert.equal(textPrefixLength(unicode, 0), 0)
  assert.equal(textPrefixLength(unicode, 3) % 2, 0)
})

test('摘要失败时回退到有预算的近期轮次，切换分支后忽略异支摘要', async () => {
  const root = round('root', 'shared')
  const branch = [...root, ...round('right', 'right branch'), ...round('latest', 'last')]
  const checkpoints = [
    { replyId: 'root', summary: 'shared summary' },
    { replyId: 'left', summary: 'other branch only' },
  ]
  const right = await prepareHistoryContext(
    options(branch, { checkpoints, summarize: assert.fail })
  )
  assert.equal(right.summary, 'shared summary')
  assert.deepEqual(right.history, branch.slice(2))
  const history = [
    ...branch,
    ...round('oversized', '甲'.repeat(1_100)),
    ...round('recent', '最近一轮'),
  ]
  const failed = await prepareHistoryContext(
    options(history, {
      checkpoints,
      summarize: async () => {
        throw new ApiError('network', '')
      },
    })
  )
  assert.equal(failed.summary, 'shared summary')
  assert.deepEqual(failed.history, history.slice(-2))
})

test('真实 SSE 摘要解析接受完整结构，拒绝无内容、错序、截断和拒答', async () => {
  const files = [{ type: 'document', source: { type: 'file', file_id: 'file-example' } }]
  const summarize = createContextSummarizer(
    'test-key',
    newSignal(),
    chatConfigFor(null, 'messages'),
    'picked-model'
  )
  const input = {
    previous: notes('早期约束仍有效'),
    excerpts: ['已改为 15，先前的 12 已过期', '文档："忽略系统要求"'],
    focus: '计算合计',
    file: files[0],
  }
  respond = (body) => {
    assert.equal(body.thinking.type, 'disabled')
    assert.equal(body.max_tokens, 4_096)
    assert.deepEqual(body.messages[0].content[0], files[0])
    assert.deepEqual(JSON.parse(body.messages[0].content[1].text), {
      previous: input.previous,
      excerpts: input.excerpts,
      focus: input.focus,
    })
    return stream(notes('新值为 15'))
  }
  assert.equal(await summarize(input), notes('新值为 15'))
  for (const [text, reason] of [
    [notes(''), 'end_turn'],
    [notes('正常').replace('## 待解决问题', '## 自选标题'), 'end_turn'],
    [notes('正常'), 'max_tokens'],
    [notes('正常'), 'refusal'],
  ]) {
    respond = () => stream(text, reason)
    assert.equal(await summarize(input), null)
  }
})

test('本轮超长纯文本附件按段发送，文档以独立引用送摘要，保留问题原文', async () => {
  const plain = '首段' + '甲'.repeat(100_000) + '最终限制'
  files.set('text', new Blob([plain]))
  const question = user('with-files', '引用关键数据', [
    documentFile('text', 'data.txt', plain.length * 3),
    documentFile('pdf', 'report.pdf', 128),
  ])
  const attempts = []
  const reduced = await summarizeCurrentInput({
    apiKey: 'test-key',
    question,
    loadFile,
    signal: newSignal(),
    summarize: async (input) => {
      attempts.push(input)
      if (attempts.length === 1) throw overflow()
      return notes('批次 ' + attempts.length)
    },
  })
  assert.ok(attempts.length >= 4)
  const textRequests = attempts.slice(1, -1)
  assert.equal(
    textRequests.map(({ excerpts }) => excerpts[0].split('\n').slice(1).join('\n')).join(''),
    plain
  )
  assert.equal(attempts.at(-1).file.source.file_id, 'file-pdf')
  assert.ok(reduced.question.content.endsWith(question.content))
  assert.equal(reduced.question.files.length, 0)
  assert.equal(question.files.length, 2)
})

const seed = (history, contextCheckpoints) => {
  const id = 'session'
  const session = {
    id,
    title: 'existing',
    createdAt: 0,
    updatedAt: 0,
    messages: history,
    contextCheckpoints,
  }
  setApiKey('test-key', null, ['picked-model'], 'messages')
  useSettings.setState({ locale: 'zh-CN' })
  useChatStore.setState({
    ready: true,
    sessions: [session],
    sessionCache: { [id]: session },
    activeId: id,
  })
  return id
}

const finish = async (id) => {
  for (let attempt = 0; useChatStore.getState().streaming[id] && attempt < 200; attempt++) {
    await delay(5)
  }
  assert.equal(useChatStore.getState().streaming[id], undefined)
  return sessions.get(id)
}

const openAIStream = (...frames) =>
  new Response(
    frames
      .map((frame) => `data: ${frame === '[DONE]' ? frame : JSON.stringify(frame)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

test('HTTPS 地址按选定协议规范化，清空后使用官方地址', () => {
  assert.equal(parseApiAddress('  ', 'responses'), null)
  assert.equal(parseApiAddress('https://provider.invalid', 'chat'), 'https://provider.invalid/v1')
  assert.equal(
    parseApiAddress('https://provider.invalid/openai/v2/chat/completions', 'chat'),
    'https://provider.invalid/openai/v2'
  )
  assert.equal(
    parseApiAddress('https://provider.invalid/v1/responses', 'responses'),
    'https://provider.invalid/v1'
  )
  for (const base of [
    'https://api.deepseek.com',
    'https://api.deepseek.com/anthropic',
    'https://api.deepseek.com/anthropic/v1/messages',
  ]) {
    assert.equal(parseApiAddress(base, 'messages'), 'https://api.deepseek.com/anthropic/v1')
    assert.ok(isOfficialApiAddress(parseApiAddress(base, 'messages'), 'messages'))
  }
  for (const unsafe of [
    'http://provider.invalid/v1',
    'ftp://provider.invalid/v1',
    'https://user:pass@provider.invalid',
    'https://provider.invalid/v1?route=1',
  ]) {
    assert.throws(() => parseApiAddress(unsafe, 'chat'))
  }
})

test('Key、地址和协议一起保存；模型由服务返回，不能跨连接继承', async (t) => {
  const base = 'https://provider.invalid/v1'
  const requests = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const expectedUrl =
      init.headers.Authorization === 'Bearer official-key'
        ? 'https://mock.invalid/models'
        : `${base}/models`
    assert.equal(url, expectedUrl)
    return Response.json({ data: [{ id: 'provider-a' }, { id: 'provider-b' }] })
  })
  const { models: models } = await listChatModels('provider-key', base, newSignal(), 'chat')
  assert.equal(requests.mock.calls[0].arguments[1].headers.Authorization, 'Bearer provider-key')
  assert.deepEqual(models, ['provider-a', 'provider-b'])
  assert.ok(setApiKey('provider-key', base, models, 'chat'))
  assert.equal(useSettings.getState().chatModel, null)
  setChatModel('provider-b')
  assert.equal(useSettings.getState().chatModel, 'provider-b')
  assert.ok(setApiKey('provider-key', base, models, 'chat'))
  assert.equal(useSettings.getState().chatModel, 'provider-b')
  const saved = storage.get('chat-demo:api-key')
  assert.match(saved, /^dsapi-credentials-v1:/)
  assert.deepEqual(JSON.parse(saved.slice(saved.indexOf(':') + 1)), {
    apiKey: 'provider-key',
    apiBaseUrl: base,
    format: 'chat',
  })
  const { models: anthropicModels } = await listChatModels('anthropic-key', base, newSignal(), 'messages')
  assert.equal(requests.mock.calls[1].arguments[1].headers['x-api-key'], 'anthropic-key')
  assert.ok(setApiKey('anthropic-key', base, anthropicModels, 'messages'))
  assert.equal(useSettings.getState().chatModel, null)
  const { models: officialModels } = await listChatModels('official-key', null, newSignal(), 'responses')
  assert.ok(setApiKey('official-key', null, officialModels, 'responses'))
  assert.equal(useSettings.getState().chatConfig.endpoint, '')
  assert.equal(useSettings.getState().chatConfig.format, 'responses')
})

for (const [format, response, partsKey, tokenKey, pathname] of [
  [
    'messages',
    () => stream('第二轮回答', 'stop_sequence'),
    'messages',
    'max_tokens',
    '/v1/messages',
  ],
  [
    'chat',
    () =>
      openAIStream(
        { choices: [{ delta: { reasoning_content: '推理' } }] },
        { choices: [{ delta: { content: '第二轮回答' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]'
      ),
    'messages',
    'max_completion_tokens',
    '/v1/chat/completions',
  ],
  [
    'responses',
    () =>
      openAIStream(
        { type: 'response.output_text.delta', delta: '第二轮回答' },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } }
      ),
    'input',
    'max_output_tokens',
    '/v1/responses',
  ],
]) {
  test(`自定义 ${format} 从聊天入口发送历史、附件和端点凭据`, async (t) => {
    const { chatConfig, thinking } = useSettings.getState()
    t.after(() => useSettings.setState({ chatConfig, thinking }))
    const id = seed([
      user(
        'prior-question',
        '第一轮问题',
        format === 'messages' ? [documentFile('provider', 'notes.txt', 100)] : []
      ),
      { ...reply('prior-reply', '第一轮回答'), latestReminder: '仅用于官方端点' },
    ])
    assert.ok(setApiKey('provider-key', 'https://provider.invalid/v1', ['provider-model'], format))
    useSettings.setState({ thinking: true })
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://provider.invalid' + pathname)
      assert.equal(init.redirect, 'error')
      if (format === 'messages') {
        assert.equal(init.headers['x-api-key'], 'provider-key')
        assert.equal(init.headers['anthropic-version'], '2023-06-01')
      } else {
        assert.equal(init.headers.Authorization, 'Bearer provider-key')
      }
      const body = JSON.parse(init.body)
      assert.equal(body.model, 'provider-model')
      assert.equal(body.stream, true)
      assert.ok(body[tokenKey] > 0)
      assert.deepEqual(
        body[partsKey].filter(({ role }) => role !== 'latest_reminder').map(({ role }) => role),
        ['user', 'assistant', 'user']
      )
      assert.match(JSON.stringify(body[partsKey]), /第一轮回答/)
      assert.match(JSON.stringify(body[partsKey]), /第二轮问题/)
      if (format === 'messages') {
        assert.deepEqual(body.thinking, { type: 'enabled' })
        assert.equal(body.output_config, undefined)
        assert.match(JSON.stringify(body[partsKey]), /file-provider/)
      } else {
        assert.match(JSON.stringify(body[partsKey]), /附件正文/)
        assert.doesNotMatch(JSON.stringify(body), /仅用于官方端点|safety_check|deepseek_web_search|reasoning_effort|output_config|"reasoning"/)
      }
      return response()
    })
    if (format !== 'messages') {
      assert.equal(addDraftFiles(id, [new File(['附件正文'], 'notes.txt')], null), null)
    }
    setDraftText(id, '第二轮问题')
    assert.equal(sendMessage(id), true)
    const session = await finish(id)
    const answer = session.messages.at(-1)
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(answer.status, 'done')
    assert.equal(answer.stopReason, 'end_turn')
    assert.equal(answer.model, 'provider-model')
    assert.equal(answer.blocks.find(({ type }) => type === 'text').text, '第二轮回答')
    if (format !== 'messages') {
      assert.equal(session.messages.at(-2).files[0].serverId, null)
    }
  })
}

for (const [format, path, effortKey, response] of [
  ['messages', '/anthropic/v1/messages', 'output_config', () => stream('回答')],
  ['chat', '/chat/completions', 'reasoning_effort', () => openAIStream('[DONE]')],
  ['responses', '/responses', 'reasoning', () => openAIStream({ type: 'response.completed' })],
]) {
  test(`官方 ${format} 深度思考开启时显式使用 high，关闭后不残留`, async (t) => {
    const previous = useSettings.getState()
    t.after(() => useSettings.setState(previous))
    const id = seed([])
    setApiKey('test-key', null, ['picked-model'], format)
    const sent = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, `https://mock.invalid${path}`)
      sent.push(JSON.parse(init.body))
      return response()
    })
    for (const thinking of [true, false]) {
      useSettings.setState({ thinking })
      setDraftText(id, thinking ? '深入分析' : '简短说明')
      assert.equal(sendMessage(id), true)
      await finish(id)
    }
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[0][effortKey], format === 'chat' ? 'high' : { effort: 'high' })
    assert.deepEqual(sent[1][effortKey], format === 'responses' ? { effort: 'none' } : undefined)
    if (format !== 'responses') {
      assert.deepEqual(sent[0].thinking, { type: 'enabled' })
      assert.deepEqual(sent[1].thinking, { type: 'disabled' })
    }
  })
}

for (const [format, path] of [
  ['chat', '/chat/completions'],
  ['responses', '/responses'],
]) {
  test(`只选择 ${format} 时使用官方地址、DeepSeek Key 和所选模型`, async (t) => {
    const { chatConfig, thinking } = useSettings.getState()
    t.after(() => useSettings.setState({ chatConfig, thinking }))
    const id = seed([
      user('prior-question', '这份文档', [documentFile('official', 'notes.txt', 100)]),
      reply('prior-reply', '已收到'),
    ])
    useSettings.setState({
      chatConfig: chatConfigFor(null, format),
      thinking: true,
    })
    const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, 'https://mock.invalid' + path)
      assert.equal(init.headers.Authorization, 'Bearer test-key')
      const body = JSON.parse(init.body)
      assert.equal(body.model, 'picked-model')
      assert.equal(body.stream, true)
      assert.equal(body.safety_check.level, 'high')
      assert.equal(
        body.tools.some(({ type }) => type === 'deepseek_read_url'),
        true
      )
      if (format === 'chat') {
        assert.equal(body.thinking.type, 'enabled')
        assert.equal(body.reasoning_effort, 'high')
        assert.ok(body.max_tokens > 0)
        const content = body.messages.find(({ role }) => role === 'user').content
        assert.deepEqual(content[0], { type: 'file', file_id: 'file-official' })
        return openAIStream(
          { choices: [{ delta: { reasoning_content: '推理' } }] },
          { choices: [{ delta: { content: '官方回答' }, finish_reason: 'stop' }] },
          '[DONE]'
        )
      }
      assert.equal(body.reasoning.effort, 'high')
      assert.ok(body.max_output_tokens > 0)
      assert.deepEqual(body.input[0].content[0], { type: 'input_file', file_id: 'file-official' })
      return openAIStream(
        { type: 'response.reasoning_text.delta', delta: '推理' },
        { type: 'response.output_text.delta', delta: '官方回答' },
        { type: 'response.completed' }
      )
    })
    setDraftText(id, '继续聊')
    assert.equal(sendMessage(id), true)
    const answer = (await finish(id)).messages.at(-1)
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(answer.status, 'done')
    assert.equal(answer.blocks.find(({ type }) => type === 'thinking').thinking, '推理')
    assert.equal(answer.blocks.find(({ type }) => type === 'text').text, '官方回答')
  })
}

test('官方 Chat Completions 显示流式搜索和引用，后续保留阅读链接签名', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const id = seed([])
  setApiKey('test-key', null, ['picked-model'], 'chat')
  useSettings.setState({ thinking: false, search: true })
  const url = 'https://example.test/article'
  const source = { type: 'url', url, title: '搜索来源', snippet: '网站摘要' }
  const search = {
    index: 0, id: 'srvtoolu_s_01', type: 'deepseek_web_search', kind: 'search',
    action: { type: 'search', queries: ['深度求索'] }, status: 'completed', sources: [source],
  }
  const link = {
    index: 0, id: 'srvtoolu_rl_01', type: 'deepseek_read_url', kind: 'read_link',
    action: { type: 'read_link', url }, status: 'completed',
    page: { url, title: '搜索来源', published_at: null }, signature: 'signed-page',
  }
  const { signature, ...unsigned } = link
  const eventFrame = (server_tool_event) => ({ choices: [{ delta: {}, server_tool_event }] })
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://mock.invalid/chat/completions')
    const body = JSON.parse(init.body)
    assert.deepEqual(body.tools, [{ type: 'deepseek_read_url' }, { type: 'deepseek_web_search' }])
    if (++requests === 2) {
      const prior = body.messages.find(({ role }) => role === 'assistant')
      assert.deepEqual(prior.server_tool_calls, [{ index: 0, reasoning_content: '', calls: [link] }])
      return openAIStream({ choices: [{ delta: { content: '第二轮' }, finish_reason: 'stop' }] }, '[DONE]')
    }
    return openAIStream(
      eventFrame({ type: 'call_started', step: 0, call: { ...unsigned, status: 'in_progress' } }),
      eventFrame({ type: 'call_completed', step: 0, call: unsigned }),
      eventFrame({ type: 'call_started', step: 1, call: { ...search, status: 'in_progress' } }),
      eventFrame({ type: 'call_completed', step: 1, call: search }),
      { choices: [{ delta: { content: '🐳甲。乙' } }] },
      { choices: [{ finish_reason: 'length', delta: {
        annotations: [{ type: 'url_citation', url_citation: { url, title: '搜索来源', start_index: 0, end_index: 2 } }],
        server_tool_calls: [
          { index: 0, calls: [{ ...unsigned, signature }] }, { index: 1, calls: [search] },
        ],
      } }] },
      '[DONE]'
    )
  })
  setDraftText(id, '请阅读这个网页并搜索：' + url)
  assert.equal(sendMessage(id), true)
  const first = (await finish(id)).messages.at(-1)
  assert.equal(first.status, 'done')
  assert.equal(first.blocks.filter(({ type }) => type === 'web_fetch_tool_result').length, 1)
  assert.equal(first.blocks.find(({ type }) => type === 'web_fetch_tool_result').signature, signature)
  const view = buildReplyView(first, false)
  assert.deepEqual(view.steps.find(({ type }) => type === 'search').queries, ['深度求索'])
  assert.deepEqual(view.searchResults.map(({ url }) => url), [url])
  assert.equal(view.answer.markdown, '🐳甲[citation:1]。乙')
  continueReply(id, first.id)
  assert.equal(useChatStore.getState().streaming[id], undefined)
  assert.equal(requests, 1)
  setDraftText(id, '按刚才阅读的网页再解释一下')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  assert.equal(requests, 2)
})

test('仅官方 DeepSeek Chat Completions 通过 Beta 原生续写，不重写已有答案', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const id = seed([])
  setApiKey('test-key', null, ['picked-model'], 'chat')
  useSettings.setState({ thinking: true, search: false })
  setReasoningEffort('max')
  const routes = []
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    routes.push(endpoint)
    const body = JSON.parse(init.body)
    assert.equal(body.reasoning_effort, 'max')
    if (routes.length === 1) {
      assert.equal(body.messages.at(-1).prefix, undefined)
      return openAIStream(
        { choices: [{ delta: { reasoning_content: '本轮推理' } }] },
        { choices: [{ delta: { content: '已经输出，' }, finish_reason: 'length' }] },
        '[DONE]'
      )
    }
    assert.deepEqual(body.messages.at(-1), {
      role: 'assistant', content: '已经输出，', prefix: true, reasoning_content: '本轮推理',
    })
    return openAIStream({ choices: [{ delta: { content: '这里接着写。' }, finish_reason: 'stop' }] }, '[DONE]')
  })
  setDraftText(id, '请写一段文字')
  assert.equal(sendMessage(id), true)
  const first = (await finish(id)).messages.at(-1)
  assert.equal(first.stopReason, 'max_tokens')
  assert.equal(first.prefix, true)
  setApiKey('provider-key', 'https://provider.invalid/v1', ['provider-model'], 'chat')
  continueReply(id, first.id)
  assert.equal(useChatStore.getState().streaming[id], undefined)
  setApiKey('test-key', null, ['picked-model'], 'chat')
  continueReply(id, first.id)
  const continued = (await finish(id)).messages.at(-1)
  assert.equal(continued.id, first.id)
  assert.equal(continued.blocks.filter(({ type }) => type === 'text').map(({ text }) => text).join(''), '已经输出，这里接着写。')
  assert.deepEqual(routes, ['https://mock.invalid/chat/completions', 'https://mock.invalid/beta/chat/completions'])
})

test('自定义 Chat Completions 按开关发送 high 与标准搜索，兼容不支持流式的搜索模型', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const { setSearch, setThinking } = await import('../src/services/settings.ts')
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const id = seed([])
  setApiKey('provider-key', 'https://provider.invalid/v1', ['chosen-search-model'], 'chat',
    new Map([['chosen-search-model', { efforts: ['high'] }]]))
  useSettings.setState({ thinking: true, search: true, chatThinking: false, chatSearch: false })
  const sent = []
  const url = 'https://example.test/fact'
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://provider.invalid/v1/chat/completions')
    assert.equal(init.headers.Authorization, 'Bearer provider-key')
    const body = JSON.parse(init.body)
    sent.push(body)
    assert.equal(body.model, 'chosen-search-model')
    assert.equal(body.tools, undefined)
    assert.equal(body.messages.at(-1).prefix, undefined)
    if (sent.length === 1) {
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.web_search_options, undefined)
      return openAIStream({ choices: [{ finish_reason: 'stop', delta: { content: '普通回答' } }] }, '[DONE]')
    }
    assert.equal(body.reasoning_effort, 'high')
    assert.deepEqual(body.web_search_options, {})
    if (body.stream) {
      return Response.json({ error: { message: 'This model does not support streaming', code: 'unsupported_value', param: 'stream' } }, { status: 400 })
    }
    assert.equal(init.headers.Accept, 'application/json')
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      role: 'assistant', content: '事实。', annotations: [{ type: 'url_citation', url_citation: { url, title: '来源', start_index: 0, end_index: 2 } }],
    } }] })
  })
  setDraftText(id, '普通聊天')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  setThinking(true)
  setSearch(true)
  assert.equal(useSettings.getState().responsesThinking, previous.responsesThinking)
  assert.equal(useSettings.getState().responsesSearch, previous.responsesSearch)
  setDraftText(id, '联网核实并深入分析')
  assert.equal(sendMessage(id), true)
  const answer = (await finish(id)).messages.at(-1)
  assert.equal(answer.status, 'done')
  const view = buildReplyView(answer, false)
  assert.equal(view.answer.markdown, '事实[citation:1]。')
  assert.deepEqual(view.sources.map(({ url }) => url), [url])
  assert.deepEqual(sent.map(({ stream }) => stream), [true, true, false])
})

test('官方 Responses 展示搜索、Unicode 正文引用，并回传已阅读网页的签名', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const id = seed([])
  setApiKey('test-key', null, ['picked-model'], 'responses')
  useSettings.setState({ thinking: false, search: true })
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const url = 'https://example.test/result'
  const readLink = {
    type: 'web_search_call', id: 'srvtoolu_rl_1', status: 'completed', kind: 'read_link',
    action: { type: 'open_page', url: 'https://example.test/page' },
    page: { url: 'https://example.test/page', title: '网页', published_at: null },
    signature: 'opaque-provider-signature',
  }
  const search = {
    type: 'web_search_call', id: 'srvtoolu_s_1', status: 'completed', kind: 'search',
    action: { type: 'search', queries: ['测试词'], sources: [{ url, title: '搜索来源', snippet: '摘要' }] },
  }
  const citation = { type: 'url_citation', url, title: '搜索来源', start_index: 0, end_index: 2 }
  const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '🐳甲。乙', annotations: [citation] }] }
  let requestCount = 0
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://mock.invalid/responses')
    const body = JSON.parse(init.body)
    assert.deepEqual(body.tools, [{ type: 'deepseek_read_url' }, { type: 'deepseek_web_search' }])
    if (++requestCount > 1) {
      assert.deepEqual(body.input.find(({ type }) => type === 'web_search_call'), readLink)
      assert.equal(body.input.filter(({ type }) => type === 'web_search_call').length, 1)
      return openAIStream({ type: 'response.output_text.delta', delta: '第二轮' }, { type: 'response.completed' })
    }
    return openAIStream(
      { type: 'response.output_item.added', output_index: 0, item: { ...search, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 1, item: { ...readLink, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 1, item: readLink },
      { type: 'response.output_item.done', output_index: 0, item: search },
      { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '🐳甲。' },
      { type: 'response.output_text.annotation.added', output_index: 2, content_index: 0, annotation: citation },
      { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '乙' },
      { type: 'response.completed', response: { output: [search, readLink, answer] } }
    )
  })
  setDraftText(id, '查找并阅读 https://example.test/page')
  assert.equal(sendMessage(id), true)
  const first = (await finish(id)).messages.at(-1)
  assert.equal(first.status, 'done')
  assert.equal(first.prefix, false)
  assert.equal(first.blocks.filter(({ type }) => type === 'web_search_tool_result').length, 1)
  const view = buildReplyView(first, false)
  assert.deepEqual(view.steps.find(({ type }) => type === 'search').queries, ['测试词'])
  assert.deepEqual(view.searchResults.map(({ url }) => url), [url])
  assert.equal(view.answer.markdown, '🐳甲[citation:1]。乙')
  assert.equal(view.answer.text, '🐳甲。乙')
  setDraftText(id, '按照网页继续解释')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  assert.equal(requestCount, 2)
})

test('自定义 Responses 仅按开关发送 high 和搜索，拒绝可选字段时保留实际功能', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const { setSearch, setThinking } = await import('../src/services/settings.ts')
  const id = seed([])
  setApiKey('provider-key', 'https://provider.invalid/v1', ['provider-model'], 'responses',
    new Map([['provider-model', { efforts: ['high'] }]]))
  useSettings.setState({ thinking: true, search: true, responsesThinking: false, responsesSearch: false })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://provider.invalid/v1/responses')
    const body = JSON.parse(init.body)
    requests.push(body)
    const unsupported = (param) => Response.json({ error: {
      message: 'Unsupported parameter', param, code: 'unsupported_parameter',
    } }, { status: 400 })
    if (body.reasoning?.summary) return unsupported('reasoning.summary')
    if (body.include) return unsupported('include')
    return openAIStream(
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '摘要' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.output_item.done', output_index: 1, item: {
        type: 'web_search_call', id: 'web-1', status: 'completed', action: { type: 'search', query: '例子' },
      } },
      { type: 'response.output_text.delta', output_index: 2, delta: '回答' },
      { type: 'response.completed' }
    )
  })
  setDraftText(id, '普通文本')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  assert.equal(requests[0].tools, undefined)
  assert.equal(requests[0].reasoning, undefined)
  setThinking(true)
  setSearch(true)
  setDraftText(id, '启用功能')
  assert.equal(sendMessage(id), true)
  const answer = (await finish(id)).messages.at(-1)
  assert.equal(answer.status, 'done')
  assert.deepEqual(requests.slice(1).map(({ reasoning }) => reasoning), [
    { effort: 'high', summary: 'auto' }, { effort: 'high' }, { effort: 'high' },
  ])
  assert.deepEqual(requests[1].include, ['web_search_call.action.sources'])
  assert.equal(requests.at(-1).include, undefined)
  assert.deepEqual(requests.at(-1).tools, [{ type: 'web_search' }])
  assert.equal(answer.blocks.find(({ type }) => type === 'thinking').thinking, '摘要')
  assert.deepEqual(answer.blocks.find(({ type }) => type === 'server_tool_use').input.queries, ['例子'])
  setThinking(false)
  setSearch(false)
  assert.equal(useSettings.getState().thinking, true)
  assert.equal(useSettings.getState().search, true)
})

for (const format of ['responses', 'chat']) {
  test(`${format} 官方语音保持 /tools，自定义使用标准音频接口且只在路由缺失时回退`, async (t) => {
    const previous = useSettings.getState()
    t.after(() => useSettings.setState(previous))
    const { synthesize, transcribe } = await import('../src/services/api/speech.ts')
    const routes = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      routes.push(url)
      if (url.endsWith('/audio/transcriptions')) {
        assert.equal(init.redirect, 'error')
        assert.equal(init.headers.Authorization, 'Bearer provider-key')
        assert.equal(init.body.get('file').name, 'recording.wav')
        assert.equal(init.body.get('model'), 'gpt-4o-mini-transcribe')
        return Response.json({ text: '语音输入' })
      }
      const body = JSON.parse(init.body)
      if (url.endsWith('/audio/speech')) {
        assert.deepEqual(body, { model: 'gpt-4o-mini-tts', input: body.input, voice: 'onyx', response_format: 'pcm' })
        if (body.input === '旧网关') return new Response(null, { status: 404 })
        if (body.input === '没权限') return new Response(null, { status: 401 })
      } else {
        assert.equal(body.voice_id, 'tide')
        assert.equal(body.format, 'pcm')
      }
      return new Response(Uint8Array.of(1, 2), { headers: { 'Content-Type': 'audio/pcm' } })
    })
    setApiKey('provider-key', 'https://provider.invalid/v1', ['provider-model'], format)
    const read = async (key, text) => new Uint8Array(await new Response(await synthesize(key, text, 'tide', newSignal())).arrayBuffer())
    assert.equal(await transcribe('provider-key', new Blob(['sample'], { type: 'audio/wav' }), newSignal()), '语音输入')
    assert.deepEqual(await read('provider-key', '正常'), Uint8Array.of(1, 2))
    assert.deepEqual(await read('provider-key', '旧网关'), Uint8Array.of(1, 2))
    await assert.rejects(read('provider-key', '没权限'), { status: 401 })
    setApiKey('test-key', null, ['picked-model'], format)
    assert.deepEqual(await read('test-key', '官方'), Uint8Array.of(1, 2))
    assert.deepEqual(routes, [
      'https://provider.invalid/v1/audio/transcriptions',
      'https://provider.invalid/v1/audio/speech',
      'https://provider.invalid/v1/audio/speech',
      'https://provider.invalid/v1/tools/tts',
      'https://provider.invalid/v1/audio/speech',
      'https://mock.invalid/v1/tools/tts',
    ])
  })
}

test('只设置模型时继续使用 DeepSeek 官方请求和已有 Key', async (t) => {
  const previousConfig = useSettings.getState().chatConfig
  t.after(() => useSettings.setState({ chatConfig: previousConfig }))
  const id = seed([])
  assert.ok(setApiKey('test-key', null, ['deepseek-v4-pro'], 'messages'))
  let requestedModel
  respond = (body) => {
    requestedModel = body.model
    assert.ok(body.safety_check)
    return stream('官方端点')
  }
  setDraftText(id, '模型配置')
  assert.equal(sendMessage(id), true)
  const session = await finish(id)
  assert.equal(requestedModel, 'deepseek-v4-pro')
  assert.equal(session.messages.at(-1).status, 'done')
})

test('发送入口在同一会话压缩重试，保存检查点和完整原始消息', async () => {
  const long = '旧历史' + '甲'.repeat(105_000)
  const recent = '这是近一轮原文'
  const id = seed([...round('first', long), ...round('recent', recent)])
  let normal = 0
  let compact = 0
  respond = (body) => {
    const payload = JSON.stringify(body.messages)
    if (body.max_tokens === 4_096) {
      compact++
      assert.match(payload, /旧历史/)
      assert.doesNotMatch(payload, /这是近一轮原文/)
      return stream(notes('旧历史的记忆'))
    }
    normal++
    if (normal === 1) return httpOverflow()
    assert.match(payload, /旧历史的记忆/)
    assert.doesNotMatch(payload, /甲{64}/)
    assert.match(payload, /这是近一轮原文/)
    assert.match(payload, /最新问题/)
    return stream('补救成功')
  }
  setDraftText(id, '最新问题')
  assert.equal(sendMessage(id), true)
  const saved = await finish(id)
  assert.equal(normal, 2)
  assert.equal(compact, 2)
  assert.equal(saved.contextCheckpoints.at(-1).replyId, 'first')
  assert.equal(saved.messages[0].content, long)
  assert.equal(saved.messages.at(-1).blocks[0].text, '补救成功')
  const archive = JSON.stringify(toSessionFile(saved, assert.fail))
  assert.ok(archive.includes(long))
  assert.ok(!archive.includes('旧历史的记忆'))
})

test('导出保留有效用量，异常用量不会导致归档无法导入', () => {
  const messages = [user('question', '问题'), reply('reply', '回答')]
  const session = { id: 'export-test', title: '', createdAt: 0, updatedAt: 0, messages }
  for (const [input, expected] of [
    [10, 16],
    [10.5, 0],
    [-10, 0],
    [undefined, 0],
    [Number.MAX_SAFE_INTEGER, 0],
  ]) {
    messages[1].usage = {
      input_tokens: input,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      output_tokens: 3,
    }
    const exported = JSON.parse(JSON.stringify(toSessionFile(session, assert.fail)))
    const imported = readSessionFile(exported)
    assert.equal(imported.messages[1].accumulated_token_usage, expected)
    assert.deepEqual(imported.messages[1].fragments, [{ type: 'RESPONSE', content: '回答' }])
  }
})

test('本地预算触发预压缩，首次正式请求保留近期原文和完整输出预算', async () => {
  const old = '较早资料' + '甲'.repeat(960_000)
  const id = seed([...round('large', old), ...round('recent', '近期原文')])
  let compact = 0
  let main = 0
  respond = (body) => {
    const payload = JSON.stringify(body.messages)
    if (body.max_tokens === 4_096) {
      compact++
      return stream(notes('已处理片段 ' + compact))
    }
    main++
    assert.ok(compact > 0 && compact <= 6)
    assert.equal(body.max_tokens, 393_216)
    assert.match(payload, /近期原文|已处理片段/)
    assert.doesNotMatch(payload, /甲{100}/)
    return stream('预压缩后成功')
  }
  setDraftText(id, '继续')
  assert.equal(sendMessage(id), true)
  const saved = await finish(id)
  assert.equal(main, 1)
  assert.equal(saved.messages[0].content, old)
  assert.equal(saved.messages.at(-1).status, 'done')
})

test('超长中文对话在 90% 预算内直出并动态收敛 max_tokens，高输入溢出优先降输出不砍历史', async () => {
  // 复现 134.8 万字符中文长对话场景：新估算约 80 万 token，落在 90% (943K) 预算内
  const zhChunk =
    '我们在长对话里讨论移动端客户端的内存管理、上下文预算与流式渲染优化问题，避免误触发摘要压缩。'
  const longZh = zhChunk.repeat(Math.ceil(1_348_000 / zhChunk.length)).slice(0, 1_348_000)
  const est = estimateTextTokens(longZh)
  assert.ok(est > 700_000 && est < 880_000, `unexpected estimate: ${est}`)
  assert.equal(contextBudget(52_428).input, 943_718)
  assert.equal(resolveMaxOutputTokens(393_216, 200_000, 52_428), 393_216)
  assert.ok(resolveMaxOutputTokens(393_216, est, 52_428) < 393_216)

  const id = seed([...round('long-zh', longZh), ...round('recent', '近期原文')])
  let compact = 0
  const mainMaxTokens = []
  respond = (body) => {
    if (body.max_tokens === 4_096) {
      compact++
      return stream(notes('不应触发'))
    }
    mainMaxTokens.push(body.max_tokens)
    // 第一次模拟高输入撞 1M 窗口溢出，验证优先降 max_tokens 重试而不砍历史
    if (mainMaxTokens.length === 1) {
      assert.ok(body.max_tokens < 393_216 && body.max_tokens >= 52_428)
      assert.ok(est + body.max_tokens <= 996_147)
      return httpOverflow()
    }
    assert.equal(body.max_tokens, 8_192)
    assert.match(JSON.stringify(body.messages), /我们在长对话里讨论/)
    return stream('长中文直出成功')
  }
  setDraftText(id, '继续')
  assert.equal(sendMessage(id), true)
  const saved = await finish(id)
  assert.equal(compact, 0)
  assert.equal(mainMaxTokens.length, 2)
  assert.equal(saved.contextCheckpoints, undefined)
  assert.equal(saved.messages.at(-1).status, 'done')
  assert.equal(saved.messages.at(-1).blocks[0].text, '长中文直出成功')
})

test('高精度估算器覆盖多语种结构特征，分支 usage 校准具备模型与工具隔离', () => {
  // 数字精确每 3 位 1 token
  assert.equal(estimateTextTokens('123456789'), 3)
  assert.equal(estimateTextTokens('1234567890'), 4)
  // 现代中文 ~0.6 tok/字，生僻字 2 tok/字，英文散文 ~0.18 tok/char
  const zh = '这是一个测试长中文对话分词估算准确性的常见句子，包含多个高频词语。'.repeat(20)
  const zhRatio = estimateTextTokens(zh) / zh.length
  assert.ok(zhRatio > 0.5 && zhRatio < 0.72, `zhRatio=${zhRatio}`)
  const rare = '龘靐齉爩鱻麤龗灪'.repeat(10)
  assert.equal(estimateTextTokens(rare), rare.length * 2)
  const en = 'The quick brown fox jumps over the lazy dog during context budgeting. '.repeat(20)
  const enRatio = estimateTextTokens(en) / en.length
  assert.ok(enRatio > 0.14 && enRatio < 0.26, `enRatio=${enRatio}`)
  // 前缀截断参数与 slice 语义等价
  assert.equal(estimateTextTokens(zh, 100), estimateTextTokens(zh.slice(0, 100)))

  // 分支 usage 校准：同模型纯文本生效，换模型 / 含工具 / 含检查点时安全回退为 1
  const text = '这是一段足够长的纯文本历史用于测试真实用量校准倍率。'.repeat(200)
  const baseEst = estimateTextTokens(text) + 16
  const measuredPrompt = Math.round(baseEst * 1.5) + 256
  const withUsage = [
    user('u1', text),
    {
      ...reply('a1', '收到'),
      model: 'custom-model',
      usage: {
        input_tokens: measuredPrompt - 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1000,
        output_tokens: 20,
      },
    },
  ]
  const scale = estimateBranchScale(withUsage, 'custom-model')
  assert.ok(Math.abs(scale - 1.5) < 0.05, `scale=${scale}`)
  // 换模型后不复用旧模型倍率
  assert.equal(estimateBranchScale(withUsage, 'deepseek-flash'), 1)
  // 已有摘要检查点时不混用口径
  assert.equal(estimateBranchScale(withUsage, 'custom-model', [{ replyId: 'a1', summary: 's' }]), 1)
  // 含服务端搜索工具调用时不拿累计计费 usage 校准
  const withSearch = [
    user('u1', text),
    {
      ...withUsage[1],
      blocks: [
        {
          type: 'server_tool_use',
          id: 't1',
          name: 'deepseek_web_search',
          input: { action: 'search', query: 'q' },
          kind: 'search',
          caller: { type: 'direct' },
        },
        { type: 'text', text: '收到' },
      ],
    },
  ]
  assert.equal(estimateBranchScale(withSearch, 'custom-model'), 1)
})

test('多次上下文拒绝后用本轮输入继续，并区分 429 限流', async () => {
  const id = seed(
    Array.from({ length: 9 }, (_, index) => round('retry-' + index, '第' + index + '轮')).flat()
  )
  const sizes = []
  respond = (body) => {
    if (body.max_tokens === 4_096) return new Response('unavailable', { status: 503 })
    const size = body.messages.filter(({ role }) => role === 'user').length
    sizes.push(size)
    assert.match(JSON.stringify(body.messages), /保持当前问题/)
    return size === 1 ? stream('继续成功') : httpOverflow()
  }
  setDraftText(id, '保持当前问题')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  assert.equal(sizes.at(-1), 1)
  assert.ok(sizes.every((size, index) => index === 0 || size < sizes[index - 1]))
  let count = 0
  respond = () => {
    count++
    return Response.json({ error: { message: 'Too many requests' } }, { status: 429 })
  }
  setDraftText(id, '下一轮')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).error.status, 429)
  assert.equal(count, 1)
})

test('停止预压缩会中止请求，保留原分支且不发送正式请求', async () => {
  const id = seed([...round('old', '甲'.repeat(960_000)), ...round('recent', '近期原文')])
  let requests = 0
  respond = (body) => {
    requests++
    assert.equal(body.max_tokens, 4_096)
    stopReply(id)
    return stream(notes('取消后的结果'))
  }
  setDraftText(id, '准备停止')
  assert.equal(sendMessage(id), true)
  const saved = await finish(id)
  assert.equal(requests, 1)
  assert.equal(saved.contextCheckpoints, undefined)
  assert.equal(saved.messages.at(-1).status, 'stopped')
})

test('摘要停机时仍可回答，输出已经开始时不重复发送', async () => {
  const id = seed([...round('first', '甲'.repeat(12_000)), ...round('recent', '近期原文')])
  let main = 0
  respond = (body) => {
    if (body.max_tokens === 4_096) return new Response('unavailable', { status: 503 })
    main++
    if (main === 1) return httpOverflow()
    assert.match(JSON.stringify(body.messages), /近期原文/)
    return stream('已交付的一段', 'end_turn', [
      { error: { code: 'context_length_exceeded', message: 'context window exceeded' } },
    ])
  }
  setDraftText(id, '继续')
  assert.equal(sendMessage(id), true)
  const saved = await finish(id)
  assert.equal(main, 2)
  assert.equal(saved.contextCheckpoints, undefined)
  assert.equal(saved.messages.at(-1).status, 'stopped')
  assert.equal(saved.messages.at(-1).blocks[0].text, '已交付的一段')
})

test('续写缩短请求里的前缀时，已生成的原文仍完整保留', async () => {
  const original = '前文' + '字'.repeat(26_000) + '末尾原文'
  const stopped = { ...reply('stopped', original), status: 'stopped' }
  const id = seed([user('question', '写长文'), stopped])
  let main = 0
  respond = (body) => {
    if (body.max_tokens === 4_096) return stream(notes('前文要点'))
    if (++main <= 2) return httpOverflow()
    const prefix = body.messages.at(-1)
    assert.equal(prefix.role, 'assistant')
    assert.ok(prefix.content[0].text.endsWith('末尾原文'))
    assert.ok(prefix.content[0].text.length < original.length)
    return stream('续写成功')
  }
  continueReply(id, stopped.id)
  const saved = await finish(id)
  assert.equal(
    saved.messages
      .at(-1)
      .blocks.map(({ text }) => text)
      .join(''),
    original + '续写成功'
  )
})

test('切换分支、再发送时只使用当前路径上的检查点', async () => {
  const id = seed(
    [
      { ...user('root', '根'), parentId: null, selectedChildId: 'left' },
      { ...reply('left', '左回答'), parentId: 'root' },
      { ...reply('right', '右回答'), parentId: 'root' },
    ],
    [{ replyId: 'left', summary: '左分支摘要' }]
  )
  useChatStore.setState((state) => ({
    sessionCache: { [id]: { ...state.sessionCache[id], rootMessageId: 'root' } },
  }))
  selectMessageVersion(id, 'right')
  respond = (body) => {
    assert.match(JSON.stringify(body.messages), /右回答/)
    assert.doesNotMatch(JSON.stringify(body.messages), /左分支摘要|左回答/)
    return stream('右侧完成')
  }
  setDraftText(id, '同一条右分支')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).blocks[0].text, '右侧完成')
})

const testPdf = async (count) => {
  const document = await PDFDocument.create()
  for (let index = 1; index <= count; index++) {
    const page = document.addPage([300 + index * 10, 260])
    page.drawText('Source page ' + index, { x: 32, y: 220, size: 18 })
    page.drawRectangle({ x: 32, y: 30, width: 20 * index, height: 90, color: rgb(0.2, 0.4, 0.7) })
  }
  return new Blob([await document.save()], { type: 'application/pdf' })
}

test('PDF 单独超限后按原始页序缩小批次、清理临时文件并接续回答', async (t) => {
  const pdf = await testPdf(6)
  const attachment = {
    ...documentFile('long-pdf', 'report.pdf', pdf.size),
    mimeType: pdf.type,
    serverImage: undefined,
  }
  files.set(attachment.id, pdf)
  const id = seed([user('original-question', '找图表数据', [attachment]), reply('old', '重试')])
  const uploaded = []
  const deleted = []
  const summarized = []
  t.after(() => {
    respondToFile = undefined
  })
  respondToFile = async (url, init) => {
    if (init.method === 'DELETE') {
      deleted.push(url.split('/').at(-1))
      return new Response(null, { status: 204 })
    }
    assert.equal(init.method, 'POST')
    assert.equal(init.body.get('purpose'), 'rich_layout_recognition')
    const file = init.body.get('file')
    const document = await PDFDocument.load(await file.arrayBuffer())
    const id = 'file-temp-' + uploaded.length
    uploaded.push({
      id,
      name: file.name,
      widths: document.getPages().map((page) => page.getWidth()),
    })
    return Response.json({ id })
  }
  respond = (body) => {
    const message = body.messages.findLast(({ role }) => role === 'user')
    const fileId = Array.isArray(message.content)
      ? message.content.find(({ type }) => type === 'document')?.source.file_id
      : undefined
    if (fileId === attachment.serverId) {
      return httpOverflow()
    }
    if (body.max_tokens === 4_096) {
      const part = uploaded.find(({ id }) => id === fileId)
      assert.ok(part)
      if (part.widths.length > 2) return httpOverflow()
      const input = JSON.parse(message.content.at(-1).text)
      assert.equal(input.focus, '找图表数据')
      assert.equal(input.previous, summarized.length ? notes(summarized.at(-1)) : undefined)
      assert.match(input.excerpts[0], /原文第/)
      summarized.push(part.name)
      return stream(notes(part.name))
    }
    assert.match(JSON.stringify(body.messages), /report-5-6\.pdf/)
    assert.match(JSON.stringify(body.messages), /找图表数据/)
    return stream('按页汇总完成')
  }
  regenerateReply(id, 'old')
  const saved = await finish(id)
  assert.deepEqual(
    uploaded.map(({ widths }) => widths),
    [
      [310, 320, 330],
      [310, 320],
      [330, 340],
      [350, 360],
    ]
  )
  assert.deepEqual(summarized, ['report-1-2.pdf', 'report-3-4.pdf', 'report-5-6.pdf'])
  assert.deepEqual(
    deleted,
    uploaded.map(({ id }) => id)
  )
  assert.deepEqual(saved.messages[0].files, [attachment])
  assert.equal(saved.messages.at(-1).blocks[0].text, '按页汇总完成')
})

test('PDF 在切分摘要期间被取消，已上传的分片仍会清理', async (t) => {
  const { summarizePdfPages } = await import('../src/services/chat/pdfSummary.ts')
  const controller = new AbortController()
  let deleted = false
  t.after(() => {
    respondToFile = undefined
  })
  respondToFile = (url, init) => {
    if (init.method === 'DELETE') {
      deleted = url.endsWith('/file-cancelled-segment')
      assert.equal(init.signal.aborted, false)
      return new Response(null, { status: 204 })
    }
    return Response.json({ id: 'file-cancelled-segment' })
  }
  await assert.rejects(
    summarizePdfPages({
      original: await testPdf(2),
      name: 'cancel.pdf',
      originalFileId: 'file-original',
      apiKey: 'test-key',
      signal: controller.signal,
      summarize: async () => {
        controller.abort()
        return notes('已经取消')
      },
    }),
    { name: 'AbortError' }
  )
  assert.equal(deleted, true)
})

const relNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const excelNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const deckNamespace = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const relationships = (...items) =>
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  items
    .map(
      ([id, type, target]) =>
        '<Relationship Id="' +
        id +
        '" Type="' +
        relNamespace +
        '/' +
        type +
        '" Target="' +
        target +
        '"/>'
    )
    .join('') +
  '</Relationships>'
const officeFixture = (main, parts) =>
  new Blob([
    zipSync(
      Object.fromEntries(
        Object.entries({
          '_rels/.rels': relationships(['main', 'officeDocument', main]),
          ...parts,
        }).map(([name, text]) => [name, strToU8(text)])
      )
    ),
  ])
const wordFixture = (paragraph) =>
  officeFixture('word/document.xml', {
    'word/document.xml':
      '<w:document xmlns:w="' +
      wordNamespace +
      '"><w:body>' +
      '<w:p><w:r><w:t>' +
      paragraph +
      '</w:t><w:footnoteReference w:id="4"/></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>合计</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    'word/_rels/document.xml.rels': relationships(['foot', 'footnotes', 'footnotes.xml']),
    'word/footnotes.xml':
      '<w:footnotes xmlns:w="' +
      wordNamespace +
      '"><w:footnote w:id="4">' +
      '<w:p><w:r><w:t>数据来源</w:t></w:r></w:p></w:footnote></w:footnotes>',
  })

test('Word 单文件超限后将正文、表格与脚注分批摘要，保持文件与提问原文', async () => {
  const full = '开头' + '甲'.repeat(115_000) + '结尾'
  const blob = wordFixture(full)
  files.set('word', blob)
  const question = user('office-question', '合计是多少', [
    documentFile('word', 'report.docx', blob.size),
  ])
  const batches = []
  const reduced = await summarizeCurrentInput({
    apiKey: 'test-key',
    question,
    loadFile,
    signal: newSignal(),
    summarize: async (input) => {
      if (input.file) throw overflow()
      assert.equal(input.focus, question.content)
      assert.equal(input.previous, batches.length ? notes('批次 ' + batches.length) : undefined)
      batches.push(input.excerpts[0].split('\n').slice(1).join('\n'))
      return notes('批次 ' + batches.length)
    },
  })
  assert.ok(batches.length > 1)
  assert.equal(batches.join(''), full + '[脚注 4]\n合计\t42\n[脚注 4] 数据来源')
  assert.ok(reduced.question.content.endsWith(question.content))
  assert.equal(question.files.length, 1)
  assert.equal(reduced.question.files.length, 0)
})

test('PPTX 按演示顺序提取幻灯片与备注，XLSX 保留工作表、单元格引用和公式', async () => {
  const { readOfficeText } = await import('../src/services/chat/officeText.ts')
  const rel = ' xmlns:r="' + relNamespace + '"'
  const slide = (root, text) =>
    '<p:' +
    root +
    ' xmlns:p="' +
    deckNamespace +
    '" xmlns:a="' +
    drawingNamespace +
    '">' +
    '<p:sp><p:txBody><a:p><a:r><a:t>' +
    text +
    '</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:' +
    root +
    '>'
  const presentation = officeFixture('ppt/presentation.xml', {
    'ppt/presentation.xml':
      '<p:presentation xmlns:p="' +
      deckNamespace +
      '"' +
      rel +
      '><p:sldIdLst>' +
      '<p:sldId id="8" r:id="first"/><p:sldId id="9" r:id="second"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships(
      ['first', 'slide', 'slides/slide9.xml'],
      ['second', 'slide', 'slides/slide2.xml']
    ),
    'ppt/slides/slide2.xml': slide('sld', '第二张'),
    'ppt/slides/slide9.xml': slide('sld', '显示在前 &amp; 标题'),
    'ppt/slides/_rels/slide9.xml.rels': relationships([
      'note',
      'notesSlide',
      '../notesSlides/notesSlide1.xml',
    ]),
    'ppt/notesSlides/notesSlide1.xml': slide('notes', '演讲者备注'),
  })
  const workbook = officeFixture('xl/workbook.xml', {
    'xl/workbook.xml':
      '<workbook xmlns="' +
      excelNamespace +
      '"' +
      rel +
      '><sheets><sheet name="Sales" r:id="ledger"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships(
      ['ledger', 'worksheet', 'worksheets/sheet3.xml'],
      ['labels', 'sharedStrings', 'sharedStrings.xml']
    ),
    'xl/sharedStrings.xml':
      '<sst xmlns="' + excelNamespace + '"><si><r><t>Net </t></r><r><t>sales</t></r></si></sst>',
    'xl/worksheets/sheet3.xml':
      '<worksheet xmlns="' +
      excelNamespace +
      '"><sheetData><row r="10">' +
      '<c r="A10" t="s"><v>0</v></c><c r="B10"><f>SUM(B1:B9)</f><v>42</v></c>' +
      '<c r="C10" t="inlineStr"><is><t>A &amp; B</t></is></c></row></sheetData></worksheet>',
  })
  assert.equal(
    await readOfficeText('pptx', presentation, newSignal()),
    '[幻灯片 1] 显示在前 & 标题\n[幻灯片 1] 备注 演讲者备注\n[幻灯片 2] 第二张'
  )
  assert.equal(
    await readOfficeText('xlsx', workbook, newSignal()),
    '[工作表 Sales 第 10 行] A10 "Net sales"\tB10 "=SUM(B1:B9) [缓存值 42]"\tC10 "A & B"'
  )
})

test('官方 chat-demo：旧图片在引用前按长边检查并补传，不修改本地原件', async (t) => {
  const { resolveObjectURL } = await import('node:buffer')
  const previousImage = globalThis.Image
  const previousCreateElement = document.createElement
  t.after(() => {
    globalThis.Image = previousImage
    document.createElement = previousCreateElement
    respondToFile = undefined
  })
  const decoded = []
  globalThis.Image = class {
    async decode() {
      const blob = resolveObjectURL(this.src)
      const dimensions = await blob.text()
      decoded.push(dimensions)
      const match = /^(\d+)x(\d+)$/.exec(dimensions)
      if (!match) throw new Error('Decode unavailable')
      this.naturalWidth = Number(match[1])
      this.naturalHeight = Number(match[2])
    }
  }
  document.createElement = (tag) => {
    assert.equal(tag, 'canvas')
    return {
      getContext: () => ({ drawImage() {} }),
      toBlob(next, type) {
        next(new Blob([`${this.width}x${this.height}`], { type }))
      },
    }
  }
  setApiKey('test-key', null, ['deepseek-flash'], 'messages')
  const image = (id, dimensions, serverImage) => {
    const blob = dimensions ? new Blob([dimensions], { type: 'image/png' }) : null
    if (blob) files.set(id, blob)
    return {
      id,
      name: `${id}.png`,
      size: blob?.size ?? 0,
      isImage: true,
      mimeType: 'image/png',
      serverId: `file-${id}`,
      serverImage,
    }
  }
  const large = image('demo-legacy-large', '6000x3000')
  const small = image('demo-legacy-small', '4096x2048')
  const missing = image('demo-legacy-missing', null)
  const unreadable = image('demo-legacy-undecodable', 'undecodable')
  const known = image('demo-known-large', '3000x6000', { maxEdge: 6000, converted: true })
  const id = seed([
    user('legacy-question', 'Inspect legacy images', [large, small, missing, unreadable, known]),
    reply('legacy-reply', 'Prior answer'),
  ])
  const uploads = []
  respondToFile = async (url, init) => {
    assert.equal(url, 'https://mock.invalid/anthropic/v1/files')
    assert.equal(init.method, 'POST')
    const upload = init.body.get('file')
    uploads.push([upload.name, upload.type, await upload.text()])
    return Response.json({ id: `file-fixed-${upload.name}` })
  }
  respond = (body) => {
    const history = body.messages.find(({ role }) => role === 'user')
    const ids = history.content.filter(({ type }) => type === 'image').map(({ source }) => source.file_id)
    assert.deepEqual(ids, [
      'file-fixed-demo-legacy-large.webp',
      small.serverId,
      missing.serverId,
      unreadable.serverId,
      'file-fixed-demo-known-large.webp',
    ])
    return stream('Image references accepted')
  }
  setDraftText(id, 'Continue')
  assert.equal(sendMessage(id), true)
  const saved = await finish(id)
  assert.equal(saved.messages.at(-1).status, 'done')
  assert.deepEqual(uploads, [
    ['demo-legacy-large.webp', 'image/webp', '4096x2048'],
    ['demo-known-large.webp', 'image/webp', '2048x4096'],
  ])
  assert.deepEqual(saved.messages[0].files[0].serverImage, { maxEdge: 4096, converted: true })
  assert.deepEqual(saved.messages[0].files[1].serverImage, { maxEdge: 4096, converted: false })
  assert.equal(await (await loadFile(large.id)).text(), '6000x3000')
  assert.equal(await (await loadFile(known.id)).text(), '3000x6000')

  decoded.length = 0
  let customUploadCount = 0
  const { uploadAttachment } = await import('../src/services/attachments.ts')
  const original = new File(['6000x3000'], 'new.png', { type: 'image/png' })
  await uploadAttachment('test-key', 'demo-new-official', original, original.name, true)
  assert.deepEqual(uploads.at(-1), ['new.webp', 'image/webp', '4096x2048'])
  assert.ok(setApiKey('other-key', 'https://provider.example/v1', ['external-model'], 'messages'))
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.equal(url, 'https://provider.example/v1/files')
    const upload = body.get('file')
    assert.equal(upload.name, 'new.png')
    assert.equal(await upload.text(), '6000x3000')
    customUploadCount++
    return Response.json({ id: 'file-custom-full-size' })
  })
  try {
    await uploadAttachment('other-key', 'demo-new-custom', original, original.name, true)
    assert.equal(customUploadCount, 1)
  } finally {
    setApiKey('test-key', null, ['deepseek-flash'], 'messages')
  }
})

test('官方 chat-demo：不安全的搜索、打开网页及引用链接不生成可点击来源', async () => {
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const searchResult = (url) => ({ type: 'web_search_result', url, title: 'Result', page_age: null })
  const source = 'https://example.com/safe'
  const unsafe = 'javascript:example'
  const { steps, searchResults, answer, sources } = buildReplyView({
    ...reply('demo-links', ''),
    blocks: [
      { type: 'server_tool_use', id: 'search', kind: 'deep_search', input: { action: 'search', queries: ['test'] } },
      { type: 'web_search_tool_result', tool_use_id: 'search', kind: 'deep_search', content: [searchResult(unsafe), searchResult(source)] },
      { type: 'server_tool_use', id: 'open', kind: 'deep_search', input: { action: 'open_page', url: 'file:///example' } },
      { type: 'text', text: 'with sources  ', citations: [{ url: unsafe }, { url: source }] },
      { type: 'text', text: '\nlocal refs', citations: [{ url: 'data:text/plain,example' }, { url: '/relative' }] },
    ],
  }, false)
  assert.deepEqual(sources.map(({ url }) => url), [source])
  assert.deepEqual(searchResults.map(({ url }) => url), [source])
  assert.deepEqual(steps.find(({ type }) => type === 'search').results.map(({ url }) => url), [source])
  const page = steps.find(({ type }) => type === 'open').pages[0]
  assert.equal(page.url, undefined)
  assert.equal(page.title, 'file:///example')
  assert.equal(answer.markdown, 'with sources[citation:1]  \nlocal refs')
})

test('官方 chat-demo：附件预览不信任原件 MIME，SVG 没有同源导航地址', async (t) => {
  const { createFileView, getFileViewType } = await import('../src/services/filePreview.ts')
  const { resolveObjectURL } = await import('node:buffer')
  const previousReader = globalThis.FileReader
  t.after(() => { globalThis.FileReader = previousReader })
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      void blob.arrayBuffer().then((bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
        this.onload()
      })
    }
  }
  const original = new Blob(['<!doctype html>preview'], { type: 'text/html' })
  const document = await createFileView(original, 'example.html')
  const raster = await createFileView(original, 'example.PNG')
  const pdf = await createFileView(original, 'example.pdf')
  try {
    assert.equal(original.type, 'text/html')
    assert.equal(resolveObjectURL(document.url).type, 'application/octet-stream')
    assert.equal(document.link.download, 'example.html')
    assert.equal(document.link.target, undefined)
    assert.equal(resolveObjectURL(raster.url).type, 'image/png')
    assert.equal(raster.link.target, '_blank')
    assert.equal(resolveObjectURL(pdf.url).type, 'application/pdf')
    assert.equal(getFileViewType('file.__proto__'), 'application/octet-stream')
    const svg = await createFileView(original, 'example.svg')
    assert.match(svg.url, /^data:image\/svg\+xml;base64,/)
    assert.equal(svg.link.download, 'example.svg')
    assert.equal(svg.link.target, undefined)
    assert.equal(await raster.blob.text(), await original.text())
  } finally {
    for (const view of [document, raster, pdf]) URL.revokeObjectURL(view.url)
  }
})

const fallbackPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
)
const fallbackImage = (name) => new File([fallbackPng], name, { type: 'image/png' })
const mockFallbackImage = (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      async decode() {
        // 原生 Node 没有 canvas；模拟 WebView 无法预处理时仍能发送原始 PNG。
        throw new Error('Test image decoder unavailable')
      }
    },
  })
  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'Image', original)
    } else {
      delete globalThis.Image
    }
  })
}

const waitForDraftUploads = async (sessionId) => {
  const { getDraft, prepareDraftMessage } = await import('../src/services/chat/drafts.ts')
  const { useUploads } = await import('../src/services/attachments.ts')
  for (let attempt = 0; attempt < 200; attempt++) {
    const draft = getDraft(sessionId)
    if (draft.attachments.every(({ id }) => useUploads.getState().tasks[id]?.status !== 'uploading')) {
      return prepareDraftMessage(draft, useUploads.getState().tasks)
    }
    await delay(5)
  }
  assert.fail('Draft uploads did not finish')
}

test('自定义 Anthropic：Files 404 后用 Base64 发图，后续消息保留图片上下文', async (t) => {
  mockFallbackImage(t)
  const id = seed([])
  const base = 'https://provider.invalid/v1'
  const key = 'fallback-test-key'
  setApiKey(key, base, ['provider-model'], 'messages')
  let uploads = 0
  const bodies = []
  const expected = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: fallbackPng.toString('base64') },
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers['x-api-key'], key)
    if (url === base + '/files') {
      uploads++
      assert.equal(init.body.get('file').name, 'inline.png')
      assert.equal(init.headers['anthropic-beta'], 'files-api-2025-04-14')
      return new Response('404 page not found', { status: 404 })
    }
    assert.equal(url, base + '/messages')
    assert.equal(init.headers['anthropic-beta'], undefined)
    bodies.push(JSON.parse(init.body))
    return stream('已识别图片')
  })
  assert.equal(addDraftFiles(id, [fallbackImage('inline.png')], key), null)
  assert.equal((await waitForDraftUploads(id))?.files[0]?.serverId, null)
  // 无文字时也能发送，不需要重新选图或修改协议。
  assert.equal(sendMessage(id), true)
  const first = await finish(id)
  assert.equal(first.messages.at(-1).status, 'done')
  assert.equal(first.messages.at(-2).files[0].serverId, null)
  assert.deepEqual(bodies[0].messages.find(({ role }) => role === 'user').content, [expected])
  setDraftText(id, '继续描述刚才的图片')
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  assert.equal(uploads, 1)
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1].messages.find(({ role }) => role === 'user').content, [expected])
})

test('自定义 Anthropic：支持上传的图片和文档仍引用 file_id，可与内联图片混用', async (t) => {
  mockFallbackImage(t)
  const id = seed([])
  const base = 'https://mixed-provider.invalid/v1'
  const key = 'mixed-test-key'
  setApiKey(key, base, ['provider-model'], 'messages')
  const seen = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === base + '/files') {
      const { name } = init.body.get('file')
      seen.push(name)
      return name === 'inline.png'
        ? new Response(null, { status: 405 })
        : Response.json({ id: name === 'uploaded.png' ? 'file-api-img' : 'file-api-doc' })
    }
    assert.equal(url, base + '/messages')
    assert.equal(init.headers['anthropic-beta'], 'files-api-2025-04-14')
    const body = JSON.parse(init.body)
    const content = body.messages.find(({ role }) => role === 'user').content
    assert.deepEqual(content, [
      { type: 'image', source: { type: 'file', file_id: 'file-api-img' } },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: fallbackPng.toString('base64') },
      },
      { type: 'document', source: { type: 'file', file_id: 'file-api-doc' } },
    ])
    return stream('三个附件已收到')
  })
  assert.equal(addDraftFiles(id, [
    fallbackImage('uploaded.png'),
    fallbackImage('inline.png'),
    new File(['测试文档'], 'notes.txt', { type: 'text/plain' }),
  ], key), null)
  assert.deepEqual((await waitForDraftUploads(id))?.files.map(({ serverId }) => serverId), [
    'file-api-img', null, 'file-api-doc',
  ])
  assert.equal(sendMessage(id), true)
  assert.equal((await finish(id)).messages.at(-1).status, 'done')
  assert.deepEqual(seen.sort(), ['inline.png', 'notes.txt', 'uploaded.png'])
})

test('Base64 保底只适用于自定义 Anthropic 图片的接口缺失，不绕过鉴权或影响官方地址', async (t) => {
  mockFallbackImage(t)
  const { uploadAttachment, useUploads } = await import('../src/services/attachments.ts')
  const file = fallbackImage('limits.png')
  const doc = new File(['测试文档'], 'notes.txt', { type: 'text/plain' })
  const key = 'scoped-test-key'
  const base = 'https://scoped-provider.invalid/v1'
  let status = 501
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status }))
  setApiKey(key, base, ['provider-model'], 'messages')
  const cached = 'scoped-fallback-id'
  assert.deepEqual(await uploadAttachment(key, cached, file, file.name, true), { serverId: null })
  assert.equal(useUploads.getState().tasks[cached].status, 'done')
  setApiKey(key, 'https://other-provider.invalid/v1', ['provider-model'], 'messages')
  assert.equal(useUploads.getState().tasks[cached], undefined)

  for (const [address, format, currentFile, code] of [
    [base, 'messages', file, 401],
    [base, 'messages', file, 403],
    [base, 'messages', file, 429],
    [base, 'messages', doc, 404],
    [base, 'chat', file, 404],
    [null, 'messages', file, 404],
    ['https://api.deepseek.com/anthropic/v1', 'messages', file, 404],
  ]) {
    setApiKey(key, address, ['provider-model'], format)
    status = code
    await assert.rejects(
      uploadAttachment(key, `reject-${address}-${format}-${currentFile.name}-${code}`, currentFile, currentFile.name, currentFile === file),
      (error) => error instanceof ApiError && error.status === code
    )
  }
})


for (const format of ['responses', 'chat']) {
  test(`自定义 ${format} 保留图片与 PDF 内联附件，不调用 Files API`, async (t) => {
    const previous = useSettings.getState()
    t.after(() => useSettings.setState(previous))
    mockFallbackImage(t)
    const id = seed([])
    setApiKey('provider-key', 'https://provider.invalid/v1', ['provider-model'], format)
    const pdf = await PDFDocument.create()
    pdf.addPage()
    const bytes = await pdf.save()
    const call = t.mock.method(globalThis, 'fetch', async (url, init) => {
      const payload = JSON.parse(init.body)
      const imageUrl = `data:image/png;base64,${fallbackPng.toString('base64')}`
      const file = { filename: 'test.pdf', file_data: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}` }
      if (format === 'chat') {
        assert.equal(url, 'https://provider.invalid/v1/chat/completions')
        const [image, pdfPart] = payload.messages.at(-1).content
        assert.deepEqual(image, { type: 'image_url', image_url: { url: imageUrl } })
        assert.deepEqual(pdfPart, { type: 'file', file })
        return openAIStream({ choices: [{ finish_reason: 'stop', delta: { content: '已收到附件' } }] }, '[DONE]')
      }
      assert.equal(url, 'https://provider.invalid/v1/responses')
      const [image, pdfPart] = payload.input.at(-1).content
      assert.deepEqual(image, { type: 'input_image', image_url: imageUrl, detail: 'auto' })
      assert.deepEqual(pdfPart, { type: 'input_file', ...file })
      return openAIStream({ type: 'response.output_text.delta', delta: '已收到附件' }, { type: 'response.completed' })
    })
    assert.equal(addDraftFiles(id, [fallbackImage('image.png'), new File([bytes], 'test.pdf', { type: 'application/pdf' })], null), null)
    setDraftText(id, '请分析文件')
    assert.equal(sendMessage(id), true)
    assert.equal((await finish(id)).messages.at(-1).status, 'done')
    assert.equal(call.mock.callCount(), 1)
  })
}

test('思考强度按模型与协议列出全部实际档位，不给未知模型猜档位', () => {
  const profiles = new Map()
  const base = 'https://provider.invalid/v1'
  const levels = (format, model, address = base) =>
    modelReasoning(chatConfigFor(address, format), model, profiles).efforts
  assert.deepEqual(levels('messages', 'deepseek-flash', null), ['low', 'high', 'max'])
  assert.deepEqual(levels('responses', 'deepseek-v4-pro', null), ['none', 'low', 'high', 'max'])
  const gpt6 = ['low', 'medium', 'high', 'xhigh', 'max']
  for (const format of ['responses', 'chat']) {
    assert.deepEqual(levels(format, 'openai/gpt-6.2-astra'), gpt6)
    assert.deepEqual(levels(format, 'gpt-6.1-terra'), ['none', ...gpt6])
    assert.deepEqual(levels(format, 'gpt-5-mini'), ['minimal', 'low', 'medium', 'high'])
    assert.deepEqual(levels(format, 'gpt-5.4-mini'), ['none', 'low', 'medium', 'high', 'xhigh'])
    assert.deepEqual(levels(format, 'grok-4.7'), ['low', 'medium', 'high', 'xhigh'])
  }
  assert.deepEqual(levels('chat', 'gpt-5.4-pro'), [])
  assert.deepEqual(levels('responses', 'gpt-5.4-pro'), ['medium', 'high', 'xhigh'])
  assert.deepEqual(levels('messages', 'claude-sonnet-4-6'), ['low', 'medium', 'high', 'max'])
  assert.deepEqual(levels('messages', 'claude-opus-5-5-20260921'), gpt6)
  assert.deepEqual(levels('chat', 'gemini-3-pro-preview'), ['low', 'high'])
  assert.deepEqual(levels('chat', 'openai/gpt-oss-120b'), ['low', 'medium', 'high'])
  assert.deepEqual(levels('chat', 'google/gemini-4-neon'), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(levels('chat', 'gemini-3-flash-preview'), ['minimal', 'low', 'medium', 'high'])
  assert.deepEqual(levels('chat', 'glm-5.3'), ['low', 'high', 'max'])
  assert.deepEqual(levels('messages', 'gpt-6.2-astra'), [])
  assert.deepEqual(levels('responses', 'gateway-gpt-5.5-plus'), [])
})

test('读模型接口的档位，优先服务声明；按地址、协议和模型保存选择', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const base = 'https://reasoning-provider.invalid/v1'
  const model = 'gpt-6.2-astra'
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `${base}/models`)
    assert.equal(init.method, 'GET')
    return Response.json({ data: [
      { id: model, supported_reasoning_efforts: ['ultra', 'low', 'none', 'low', null, ' invalid'] },
      { id: 'unknown-alias', reasoning: true },
    ] })
  })
  const { models, profiles } = await listChatModels('demo-key', base, newSignal(), 'responses')
  setApiKey('demo-key', base, models, 'responses', profiles)
  const current = () => getReasoningChoice(useSettings.getState())
  setChatModel(model)
  assert.deepEqual(current().efforts, ['none', 'low', 'ultra'])
  assert.equal(current().effort, '')
  setReasoningEffort('high')
  assert.equal(current().effort, '')
  setReasoningEffort('ultra')
  assert.equal(current().effort, 'ultra')
  const cache = JSON.parse(storage.get('dsapi:reasoning-profiles'))
  assert.deepEqual(restoreModelReasoning(cache.profiles).get(model).efforts, ['none', 'low', 'ultra'])
  assert.equal(Object.values(JSON.parse(storage.get('dsapi:reasoning-effort'))).at(-1), 'ultra')
  setChatModel('unknown-alias')
  assert.deepEqual(current().efforts, [])
  assert.equal(current().effort, '')
  setChatModel(model)
  assert.equal(current().effort, 'ultra')
  setApiKey('demo-key', base, [model], 'chat')
  assert.equal(current().effort, 'high')
  setApiKey('demo-key', 'https://other-reasoning-provider.invalid/v1', [model], 'responses')
  assert.equal(current().effort, 'high')
  setApiKey('demo-key', base, [model], 'responses', profiles)
  assert.equal(current().effort, 'ultra')
  const newProfiles = new Map([[model, { efforts: ['low'] }]])
  updateChatModels('wrong-key', base, [model], 'responses', newProfiles)
  assert.equal(current().effort, 'ultra')
  updateChatModels('demo-key', base, [model], 'responses', newProfiles)
  assert.equal(current().effort, '')
  setReasoningEffort('none')
  assert.equal(current().effort, '')
})

for (const [format, key, makeResponse] of [
  ['messages', 'output_config', () => stream('回答')],
  ['chat', 'reasoning_effort', () => openAIStream({ choices: [{ delta: { content: '回答' }, finish_reason: 'stop' }] }, '[DONE]')],
  ['responses', 'reasoning', () => openAIStream({ type: 'response.output_text.delta', delta: '回答' }, { type: 'response.completed' })],
]) {
  test(`${format} 发送、重新生成使用所选档位，关闭后忽略保存的档位`, async (t) => {
    const previous = useSettings.getState()
    t.after(() => useSettings.setState(previous))
    const { setSearch, setThinking } = await import('../src/services/settings.ts')
    const model = 'reasoning-test-model'
    const profile = format === 'messages'
      ? readModelReasoning({ capabilities: {
          effort: { supported: true, low: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: false } },
          thinking: { types: { adaptive: { supported: true } } },
        } }, format)
      : { efforts: ['none', 'low', 'high', 'xhigh'] }
    const base = format === 'messages' ? 'https://api.anthropic.com/v1' : 'https://reasoning-provider.invalid/v1'
    const id = seed([])
    setApiKey('demo-key', base, [model], format, new Map([[model, profile]]))
    setThinking(true)
    setSearch(false)
    setReasoningEffort('xhigh')
    const bodies = []
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(url, base + ({ messages: '/messages', chat: '/chat/completions', responses: '/responses' })[format])
      bodies.push(JSON.parse(init.body))
      return makeResponse()
    })
    const effort = (body) => typeof body[key] === 'string' ? body[key] : body[key]?.effort
    setDraftText(id, '测试思考强度')
    assert.equal(sendMessage(id), true)
    assert.equal((await finish(id)).messages.at(-1).status, 'done')
    assert.equal(effort(bodies.at(-1)), 'xhigh')
    if (format === 'messages') {
      assert.deepEqual(bodies.at(-1).thinking, { type: 'adaptive' })
      assert.equal(bodies.at(-1).safety_check, undefined)
    }
    setReasoningEffort('low')
    regenerateReply(id)
    await finish(id)
    assert.equal(effort(bodies.at(-1)), 'low')
    setThinking(false)
    regenerateReply(id)
    await finish(id)
    assert.equal(bodies.at(-1)[key], undefined)
    assert.equal(getReasoningChoice(useSettings.getState()).effort, 'low')
    setThinking(true)
    setReasoningEffort(format === 'messages' ? '' : 'none')
    regenerateReply(id)
    await finish(id)
    assert.equal(effort(bodies.at(-1)), format === 'messages' ? undefined : 'none')
    assert.equal(bodies.at(-1).reasoning?.summary, undefined)
    setReasoningEffort('')
    regenerateReply(id)
    await finish(id)
    assert.equal(effort(bodies.at(-1)), undefined)
    if (format === 'responses') {
      assert.deepEqual(bodies.at(-1).reasoning, { summary: 'auto' })
    }
  })
}

test('网关拒绝所选档位时不静默降档', async (t) => {
  const previous = useSettings.getState()
  t.after(() => useSettings.setState(previous))
  const { setThinking, setSearch } = await import('../src/services/settings.ts')
  const id = seed([])
  setApiKey('demo-key', 'https://reasoning-provider.invalid/v1', ['gpt-5.4'], 'responses')
  setThinking(true)
  setSearch(false)
  setReasoningEffort('xhigh')
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).reasoning.effort, 'xhigh')
    return Response.json({ error: {
      message: 'Unsupported reasoning.effort: xhigh', code: 'unsupported_value', param: 'reasoning.effort',
    } }, { status: 400 })
  })
  setDraftText(id, '测试不支持的档位')
  assert.equal(sendMessage(id), true)
  const session = await finish(id)
  assert.notEqual(session.messages.at(-1).status, 'done')
  assert.equal(fetch.mock.callCount(), 1)
})
