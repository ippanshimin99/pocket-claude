import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { query } from '@anthropic-ai/claude-agent-sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))

const defaults = {
  port: 3200,
  // Leave empty to use your Claude Code default model.
  // Set e.g. "claude-fable-5" or "opus" to pin one.
  model: '',
  // "default"          → tool permissions are relayed to the web UI (Allow/Deny buttons)
  // "acceptEdits"      → file edits auto-approved, the rest relayed
  // "bypassPermissions"→ everything auto-approved (unattended use; trusted dirs only!)
  permissionMode: 'default',
  // The project directory Claude works in.
  cwd: process.cwd(),
}

const configPath = join(__dirname, 'config.json')
const config = existsSync(configPath)
  ? { ...defaults, ...JSON.parse(readFileSync(configPath, 'utf8')) }
  : defaults

// ---- SSE broadcast -------------------------------------------------------
const clients = new Set()
const history = [] // replay buffer so reconnecting browsers catch up
const HISTORY_MAX = 500

function broadcast(ev) {
  history.push(ev)
  if (history.length > HISTORY_MAX) history.shift()
  const data = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of clients) res.write(data)
}

// ---- permission relay ----------------------------------------------------
const pendingPermissions = new Map()
let permissionSeq = 0

// Never show absolute paths in the UI: screen captures shouldn't leak
// usernames or machine layout. cwd → "." and home → "~", both slash styles.
const HOME = homedir()
function redactPaths(s) {
  if (typeof s !== 'string' || !s) return s
  let out = s
  for (const root of [config.cwd, config.cwd.replaceAll('/', '\\'), config.cwd.replaceAll('\\', '/')]) {
    if (root) out = out.split(root).join('.')
  }
  for (const home of [HOME, HOME.replaceAll('\\', '/')]) {
    if (home) out = out.split(home).join('~')
  }
  return out
}

function toolSummary(input) {
  if (input == null) return ''
  let s
  if (typeof input.command === 'string') s = input.command
  else if (typeof input.file_path === 'string') s = input.file_path
  else if (typeof input.pattern === 'string') s = input.pattern
  else s = JSON.stringify(input)
  s = redactPaths(s)
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

async function canUseTool(toolName, input) {
  const id = String(++permissionSeq)
  broadcast({ type: 'permission', id, tool: toolName, summary: toolSummary(input) })
  return new Promise((resolve) => {
    pendingPermissions.set(id, (allow) => {
      pendingPermissions.delete(id)
      broadcast({ type: 'permission_resolved', id, allow })
      resolve(
        allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Denied by the user from the pocket-claude UI.' }
      )
    })
  })
}

// ---- persistent SDK session (streaming input mode) -----------------------
let slashCommands = [] // filled from the SDK's system/init message
const queue = []
let wake = null

function pushUserMessage(text) {
  queue.push(text)
  if (wake) {
    wake()
    wake = null
  }
}

async function* userMessages() {
  while (true) {
    while (queue.length === 0) {
      await new Promise((resolve) => (wake = resolve))
    }
    const text = queue.shift()
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    }
  }
}

const q = query({
  prompt: userMessages(),
  options: {
    ...(config.model ? { model: config.model } : {}),
    cwd: config.cwd,
    permissionMode: config.permissionMode,
    includePartialMessages: true,
    canUseTool,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append:
        'When mentioning file paths in your responses, always use paths relative to the working directory. Never print absolute paths (they may be screen-captured).',
    },
  },
})

;(async () => {
  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      const ev = msg.event
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        broadcast({ type: 'text', text: ev.delta.text })
      } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        broadcast({ type: 'tool', name: ev.content_block.name })
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          broadcast({ type: 'tool_input', name: block.name, summary: toolSummary(block.input) })
        }
      }
    } else if (msg.type === 'result') {
      broadcast({
        type: 'done',
        subtype: msg.subtype,
        num_turns: msg.num_turns,
        duration_ms: msg.duration_ms,
      })
    } else if (msg.type === 'system' && msg.subtype === 'init') {
      if (Array.isArray(msg.slash_commands)) slashCommands = msg.slash_commands
      // Only the folder name — never the full path (capture-safe).
      broadcast({ type: 'init', model: msg.model ?? config.model ?? 'default', cwd: basename(config.cwd) })
    } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      broadcast({
        type: 'info',
        text: `(compacted: ${msg.compact_metadata?.pre_tokens ?? '?'} tokens summarized)`,
      })
    }
  }
})().catch((err) => {
  broadcast({ type: 'error', message: String(err) })
  console.error(err)
})

// ---- HTTP ----------------------------------------------------------------
const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders()
  for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

app.post('/message', (req, res) => {
  const text = req.body?.text
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text required' })
  }
  // /clear resets the SDK context — wipe the UI log and replay buffer too,
  // so reloads (and other connected browsers) start blank as well.
  if (text.trim() === '/clear') {
    history.length = 0
    broadcast({ type: 'clear' })
  }
  broadcast({ type: 'user', text })
  pushUserMessage(text)
  res.json({ ok: true })
})

app.post('/permission', (req, res) => {
  const { id, allow } = req.body ?? {}
  const resolve = pendingPermissions.get(String(id))
  if (!resolve) return res.status(404).json({ error: 'no such pending permission' })
  resolve(Boolean(allow))
  res.json({ ok: true })
})

app.get('/commands', (_req, res) => {
  res.json({ commands: slashCommands })
})

app.post('/interrupt', async (_req, res) => {
  try {
    await q.interrupt()
    broadcast({ type: 'info', text: '(interrupted)' })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

app.listen(config.port, '127.0.0.1', () => {
  console.log(`pocket-claude on http://127.0.0.1:${config.port}`)
  console.log(
    `model=${config.model || '(CLI default)'} cwd=${config.cwd} permissionMode=${config.permissionMode}`
  )
})
