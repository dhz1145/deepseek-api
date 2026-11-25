import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// node --experimental-transform-types --test scripts/test-model-reasoning.mjs
const source = new URL('../src/', import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.startsWith(source.href) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(target)) return next(target.href, context)
    }
    return next(specifier, context)
  },
})

const mirror = 'https://updates.example/updates/reasoning-aliases.json'
const cacheKey = 'dsapi:reasoning-aliases'
const storage = new Map()
globalThis.window = {
  DeepSeekAndroid: {
    reasoningAliasesUrl: () => mirror,
    readApiKey: () => null,
    readAccountProfile: () => null,
  },
}
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
}
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

const { parseApiAddress } = await import('../src/services/api/address.ts')
const { chatConfigFor } = await import('../src/services/api/chatConfig.ts')
const { readModelReasoning, restoreModelReasoning } =
  await import('../src/services/api/modelReasoning.ts')
const { readReasoningAliases } = await import('../src/services/api/reasoningAliases.ts')
const { getChatReasoning, getReasoningChoice, refreshReasoningAliases, useSettings } =
  await import('../src/services/settings.ts')

const baseUrl = 'https://ovone.ai'
const ovone = chatConfigFor(parseApiAddress(baseUrl, 'messages'), 'messages')
const alias = 'deepseek-v4.1-flash'
const levels = ['low', 'high', 'max']
const stateFor = (chatConfig, chatModel, metadata = {}) => {
  const metadataProfile = readModelReasoning(metadata, chatConfig.format)
  return {
    ...useSettings.getState(),
    chatConfig,
    chatModel,
    reasoningProfiles: metadataProfile ? new Map([[chatModel, metadataProfile]]) : new Map(),
    reasoningPreferences: {},
  }
}
const entry = { baseUrl, format: 'messages', model: alias, efforts: ['max'] }
const catalog = (...entries) => JSON.stringify({ schema: 1, entries })

test('OVONE aliases resolve offline without guessing unrecognized model families or other routes', () => {
  assert.deepEqual(getReasoningChoice(stateFor(ovone, alias)).efforts, levels)
  assert.deepEqual(getReasoningChoice(stateFor(ovone, `${alias}-1017`)).efforts, levels)
  assert.deepEqual(getReasoningChoice(stateFor(ovone, 'deepseek-v4.9-unlisted')).efforts, [])
  assert.deepEqual(
    getReasoningChoice(stateFor(chatConfigFor('https://example.org/v1', 'messages'), alias))
      .efforts,
    []
  )
  assert.deepEqual(
    getReasoningChoice(stateFor(chatConfigFor('https://ovone.ai/proxy/v1', 'messages'), alias))
      .efforts,
    []
  )
  assert.deepEqual(
    getReasoningChoice(stateFor(chatConfigFor('https://ovone.ai/v1', 'responses'), alias)).efforts,
    []
  )
})

test('explicit gateway capabilities win, including an empty list and effort unsupported', () => {
  assert.deepEqual(
    getReasoningChoice(stateFor(ovone, alias, { supported_reasoning_efforts: ['low'] })).efforts,
    ['low']
  )
  assert.deepEqual(
    getReasoningChoice(stateFor(ovone, alias, { reasoning_efforts: [] })).efforts,
    []
  )
  assert.deepEqual(
    getReasoningChoice(stateFor(ovone, alias, { capabilities: { effort: { supported: false } } }))
      .efforts,
    []
  )
})

test('gateway canonical IDs use the current protocol and survive profile caching', () => {
  const messages = stateFor(ovone, 'vendor-alias', { canonical_id: 'deepseek-v4.1-flash-1017' })
  messages.reasoningProfiles = restoreModelReasoning(
    JSON.parse(JSON.stringify(Object.fromEntries(messages.reasoningProfiles)))
  )
  assert.deepEqual(getReasoningChoice(messages).efforts, levels)
  const metadata = { canonical_slug: 'openai/gpt-6.2-sol' }
  assert.deepEqual(getReasoningChoice(stateFor(ovone, 'fast', metadata)).efforts, [])
  assert.deepEqual(
    getReasoningChoice(
      stateFor(chatConfigFor('https://ovone.ai/v1', 'responses'), 'fast', metadata)
    ).efforts,
    ['low', 'medium', 'high', 'xhigh', 'max']
  )
})

test('invalid registries are rejected and a scoped update can disable an alias', () => {
  assert.equal(readReasoningAliases('{'), undefined)
  assert.equal(
    readReasoningAliases(catalog({ ...entry, baseUrl: 'http://ovone.ai/v1' })),
    undefined
  )
  assert.equal(
    readReasoningAliases(catalog(entry, { ...entry, baseUrl: 'https://ovone.ai/v1/' })),
    undefined
  )
  assert.equal(readReasoningAliases(catalog({ ...entry, efforts: 'max' })), undefined)
  const state = stateFor(ovone, alias)
  state.reasoningAliases = readReasoningAliases(catalog({ ...entry, efforts: [] }))
  assert.deepEqual(getReasoningChoice(state).efforts, [])
})

test('Android downloads only a public registry, retains the good cache, and sends the original model ID', async (t) => {
  const signal = new AbortController().signal
  const text = catalog(entry, { ...entry, model: 'vendor-fast', efforts: ['high'] })
  const mockedFetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, mirror)
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'error')
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), { accept: 'application/json' })
    return new Response(text)
  })
  await refreshReasoningAliases(signal)
  assert.equal(mockedFetch.mock.callCount(), 1)
  assert.equal(storage.get(cacheKey), text)
  assert.deepEqual(getReasoningChoice(stateFor(ovone, alias)).efforts, ['max'])
  assert.deepEqual(getReasoningChoice(stateFor(ovone, 'vendor-fast')).efforts, ['high'])
  mockedFetch.mock.mockImplementation(async () => new Response('bad file'))
  await refreshReasoningAliases(signal)
  mockedFetch.mock.mockImplementation(async () => {
    throw new Error('offline')
  })
  await refreshReasoningAliases(signal)
  assert.equal(storage.get(cacheKey), text)
  assert.deepEqual(getReasoningChoice(stateFor(ovone, alias)).efforts, ['max'])

  const { streamChatMessage } = await import('../src/services/api/client.ts')
  mockedFetch.mock.mockImplementation(async (url, init) => {
    assert.equal(url, ovone.endpoint)
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'vendor-fast')
    assert.deepEqual(body.output_config, { effort: 'high' })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
  const model = 'vendor-fast'
  const stream = streamChatMessage(
    ovone,
    'test-key',
    {
      model,
      messages: [{ role: 'user', content: 'test' }],
      thinking: { type: 'enabled' },
      max_tokens: 128,
    },
    signal,
    getChatReasoning(stateFor(ovone, model), model)
  )
  assert.deepEqual(await Array.fromAsync(stream), [{ type: 'message_stop' }])
})
