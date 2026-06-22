import { existsSync, readFileSync, watchFile, writeFile } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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

// ---- context.md: プロジェクトコンテキスト自動読み込み --------------------
const contextPath = join(__dirname, 'context.md')
function loadContext() {
  return existsSync(contextPath) ? readFileSync(contextPath, 'utf8').trim() : ''
}
// context.md が更新されたら画面に通知（/restart で反映）
watchFile(contextPath, { persistent: false, interval: 2000 }, () => {
  broadcast({ type: 'info', text: '(context.md が更新されました — /restart で新しいコンテキストを反映)' })
})

// ---- 履歴永続化 -----------------------------------------------------------
// history.json に保存しサーバー再起動後も復元する
const historyPath = join(__dirname, 'history.json')
let eventSeq = 0

// ---- SSE broadcast -------------------------------------------------------
const clients = new Set()
const history = []
const HISTORY_MAX = 500

// 起動時に保存済み履歴を復元
if (existsSync(historyPath)) {
  try {
    const saved = JSON.parse(readFileSync(historyPath, 'utf8'))
    history.push(...saved.slice(-HISTORY_MAX))
    eventSeq = history.reduce((m, e) => Math.max(m, e.seq || 0), 0)
  } catch { /* 壊れていたら無視 */ }
}

// 書き込みデバウンス（1秒）
let saveTimer = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    writeFile(historyPath, JSON.stringify(history), () => {})
  }, 1000)
}

function clearHistory() {
  history.length = 0
  eventSeq = 0
  writeFile(historyPath, '[]', () => {})
}

function broadcast(ev) {
  const seqEv = { ...ev, seq: ++eventSeq }
  history.push(seqEv)
  if (history.length > HISTORY_MAX) history.shift()
  scheduleSave()
  const data = `data: ${JSON.stringify(seqEv)}\n\n`
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

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000 // auto-deny if no browser responds within 5 min

// Tools that are always safe to auto-approve
const AUTO_ALLOW_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'Grep', 'Glob', 'LS',
  'TodoRead', 'TodoWrite',
  'WebSearch', 'WebFetch',
])

// Bash patterns that must always prompt (destructive / irreversible)
const DANGEROUS_BASH = [
  /\brm\s+.*-[rf]/,          // rm -rf / rm -fr
  /\brm\s+-[rf]/,            // rm -r or rm -f
  /\bsudo\b/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+push\b.*--force/,
  /\bgit\s+clean\s+-[fdx]/,
  /\|\s*(bash|sh|zsh|fish)\b/, // pipe to shell
  /\b(drop|truncate)\s+table/i,
]

function isSafeBash(command) {
  return !DANGEROUS_BASH.some(p => p.test(command))
}

async function canUseTool(toolName, input) {
  // Auto-allow safe tools without prompting
  if (AUTO_ALLOW_TOOLS.has(toolName)) {
    return { behavior: 'allow', updatedInput: input }
  }

  // Auto-allow Bash unless it matches dangerous patterns
  if (toolName === 'Bash' && typeof input?.command === 'string') {
    if (isSafeBash(input.command)) {
      return { behavior: 'allow', updatedInput: input }
    }
  }

  // Everything else → relay to UI
  const id = String(++permissionSeq)
  broadcast({ type: 'permission', id, tool: toolName, summary: toolSummary(input) })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingPermissions.has(id)) return
      pendingPermissions.delete(id)
      broadcast({ type: 'permission_resolved', id, allow: false })
      broadcast({ type: 'info', text: `(permission timed out: ${toolName} — auto-denied)` })
      resolve({ behavior: 'deny', message: 'Auto-denied: no browser responded within 5 minutes.' })
    }, PERMISSION_TIMEOUT_MS)

    pendingPermissions.set(id, (allow) => {
      clearTimeout(timer)
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

// セッションごとに queue/wake/killed を持たせる。
// モジュール全体で1個の wake を共有すると、新セッション開始時に古い
// generator が永遠に起きられず、配下のSDKサブプロセスがゾンビ化するため。
let activeSession = null // { queue, wake, killed }

function pushUserMessage(text, image = null) {
  if (!activeSession) return
  activeSession.queue.push({ text, image })
  if (activeSession.wake) {
    activeSession.wake()
    activeSession.wake = null
  }
}

async function* userMessages(session) {
  while (true) {
    if (session.killed) return
    while (session.queue.length === 0 && !session.killed) {
      await new Promise((resolve) => { session.wake = resolve })
    }
    if (session.killed) return
    const { text, image } = session.queue.shift()
    let content
    if (image) {
      content = [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        { type: 'text', text: text || '(image)' },
      ]
    } else {
      content = text
    }
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    }
  }
}

let q = null
let sessionId = 0 // セッション世代管理: 古いセッションのループを安全に終了させる

function drainPermissions() {
  for (const [id, cb] of pendingPermissions) {
    broadcast({ type: 'permission_resolved', id, allow: false })
    cb(false)
  }
  pendingPermissions.clear()
}

// 現在のセッションを確実に終了させる（generator kill + interrupt）。
// これを呼ばずに startSession() を再度呼ぶと、古いSDKサブプロセスが
// ゾンビ化して残り続ける（実際に発生した不具合）。
async function killCurrentSession() {
  if (activeSession) {
    activeSession.killed = true
    if (activeSession.wake) { activeSession.wake(); activeSession.wake = null }
  }
  if (q) {
    try { await q.interrupt() } catch { /* セッションが既に終了していれば失敗してよい */ }
  }
}

async function startSession() {
  const myId = ++sessionId
  const session = { queue: [], wake: null, killed: false }
  activeSession = session
  const contextContent = loadContext()

  const appendLines = [
    'When mentioning file paths in your responses, always use paths relative to the working directory. Never print absolute paths (they may be screen-captured).',
    '',
    'The user is on a remote web UI (pocket-claude) with preview tabs: Image, Movie, Web.',
    'When the user asks to see/check an image, video, or a running web app, set it into the matching tab via Bash:',
    `  curl -s -X POST http://127.0.0.1:${config.port}/preview/set -H "Content-Type: application/json" -d '{"kind":"image","path":"./art/player.png"}'`,
    `  curl -s -X POST http://127.0.0.1:${config.port}/preview/set -H "Content-Type: application/json" -d '{"kind":"video","path":"./out/clip.mp4"}'`,
    `  curl -s -X POST http://127.0.0.1:${config.port}/preview/set -H "Content-Type: application/json" -d '{"kind":"web","port":5173}'`,
    'For "web", start the dev server first (in the background), then set its port. After setting, tell the user which tab to open.',
  ]
  if (contextContent) {
    appendLines.push('', '---', contextContent)
  }

  q = query({
    prompt: userMessages(session),
    options: {
      ...(config.model ? { model: config.model } : {}),
      cwd: config.cwd,
      permissionMode: config.permissionMode,
      includePartialMessages: true,
      maxTurns: 100,
      canUseTool,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: appendLines.join('\n'),
      },
    },
  })

  try {
    for await (const msg of q) {
      if (sessionId !== myId) return // 新しいセッションが起動済み → 静かに終了
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
            trackMedia(block)
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
        broadcast({ type: 'init', model: msg.model ?? config.model ?? 'default', cwd: basename(config.cwd) })
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        broadcast({
          type: 'info',
          text: `(compacted: ${msg.compact_metadata?.pre_tokens ?? '?'} tokens summarized)`,
        })
      }
    }
  } catch (err) {
    if (sessionId !== myId) return
    session.killed = true // generatorが生きていれば確実に終了させる
    broadcast({ type: 'error', message: String(err) })
    console.error('[pocket-claude] session error:', err)
    drainPermissions()
    broadcast({ type: 'info', text: '(session crashed — restarting in 5 s…)' })
    setTimeout(startSession, 5000)
  }
}

startSession()

// ---- media preview (latest image / video Claude touched) ------------------
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)$/i
const latestMedia = { image: null, video: null } // absolute paths

function trackMedia(block) {
  // Write/Edit carry file_path; Bash commands often *generate* media too
  // (ffmpeg, image-gen scripts), so scan those for media-looking paths.
  let candidates = []
  if (block.name === 'Write' || block.name === 'Edit') {
    if (typeof block.input?.file_path === 'string') candidates = [block.input.file_path]
  } else if (block.name === 'Bash' && typeof block.input?.command === 'string') {
    candidates = block.input.command.match(/[^\s"']+\.[a-z0-9]{2,4}/gi) ?? []
  }
  for (const c of candidates) {
    const kind = IMAGE_RE.test(c) ? 'image' : VIDEO_RE.test(c) ? 'video' : null
    if (!kind) continue
    latestMedia[kind] = isAbsolute(c) ? c : resolve(config.cwd, c)
    broadcast({ type: kind, label: redactPaths(latestMedia[kind]) })
  }
}

// ---- HTTP ----------------------------------------------------------------
const app = express()
app.use(express.json({ limit: '10mb' }))

// Web preview proxy: /web/<port>/... → http://127.0.0.1:<port>/...
// Lets you poke a local dev server (game build, vite, etc.) from your phone
// through the same tailnet origin. Dev-preview quality: no websockets/HMR.
function proxyTo(port, path, req, res) {
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    }
  )
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).send(`nothing listening on 127.0.0.1:${port}`)
  })
  req.pipe(upstream)
}

app.use('/web/:port', (req, res) => {
  const port = Number(req.params.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).send('bad port')
  proxyTo(port, req.url, req, res)
})

app.use(express.static(join(__dirname, 'public')))

// Fallback for absolute asset URLs (/assets/x.js) requested by proxied pages:
// route them to the port found in the Referer's /web/<port>/ prefix, or to the
// currently previewed web port as a last resort.
app.use((req, res, next) => {
  const m = /\/web\/(\d+)\//.exec(req.headers.referer ?? '')
  if (m) return proxyTo(Number(m[1]), req.url, req, res)
  if (webPort) return proxyTo(webPort, req.url, req, res)
  next()
})

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.flushHeaders()
  // クライアントが既に持っているseqより新しいイベントだけ送る
  const since = Number(req.query.since) || 0
  for (const ev of history) {
    if ((ev.seq || 0) > since) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

app.post('/message', async (req, res) => {
  const text = req.body?.text ?? ''
  const image = req.body?.image ?? null // { data: 'base64...', mediaType: 'image/jpeg' }

  if (typeof text !== 'string') return res.status(400).json({ error: 'text must be string' })
  if (!text.trim() && !image) return res.status(400).json({ error: 'text or image required' })

  // /clear resets the SDK context — wipe the UI log, the replay buffer,
  // and all previews, so everything starts blank everywhere.
  if (text.trim() === '/clear') {
    clearHistory()
    latestMedia.image = null
    latestMedia.video = null
    webPort = null
    broadcast({ type: 'clear' })
  }

  // /restart: context.md を再読み込みしてセッションを新規起動する
  if (text.trim() === '/restart') {
    clearHistory()
    latestMedia.image = null
    latestMedia.video = null
    webPort = null
    drainPermissions()
    broadcast({ type: 'clear' })
    broadcast({ type: 'info', text: '(context.md を読み込んでセッションを再起動します…)' })
    await killCurrentSession()
    setTimeout(startSession, 300)
    return res.json({ ok: true })
  }

  const displayText = image ? `${text || ''}${text ? ' ' : ''}📷` : text
  broadcast({ type: 'user', text: displayText })
  pushUserMessage(text, image)
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

// ---- preview endpoints -----------------------------------------------------
// Claude sets previews explicitly (curl from Bash, see system prompt below);
// trackMedia() also auto-detects as a fallback.
let webPort = null

app.post('/preview/set', (req, res) => {
  const { kind, path, port } = req.body ?? {}
  if (kind === 'image' || kind === 'video') {
    if (typeof path !== 'string' || !path.trim()) return res.status(400).json({ error: 'path required' })
    const abs = isAbsolute(path) ? path : resolve(config.cwd, path)
    if (!existsSync(abs)) return res.status(404).json({ error: `file not found: ${path}` })
    latestMedia[kind] = abs
    broadcast({ type: kind, label: redactPaths(abs) })
    return res.json({ ok: true, shown: `${kind} tab` })
  }
  if (kind === 'web') {
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return res.status(400).json({ error: 'valid port required' })
    webPort = p
    broadcast({ type: 'web', port: p })
    return res.json({ ok: true, shown: 'web tab' })
  }
  res.status(400).json({ error: 'kind must be image|video|web' })
})

app.get('/preview/image', (_req, res) => {
  if (!latestMedia.image || !existsSync(latestMedia.image)) return res.status(404).send('Nothing set')
  res.set('Cache-Control', 'no-store').sendFile(latestMedia.image)
})

app.get('/preview/video', (req, res) => {
  if (!latestMedia.video || !existsSync(latestMedia.video)) return res.status(404).send('Nothing set')
  res.set('Cache-Control', 'no-store').sendFile(latestMedia.video)
})

app.get('/preview/state', (_req, res) => {
  res.json({
    image: latestMedia.image ? redactPaths(latestMedia.image) : null,
    video: latestMedia.video ? redactPaths(latestMedia.video) : null,
    web: webPort,
  })
})

app.post('/interrupt', async (_req, res) => {
  if (!q) return res.status(503).json({ error: 'no active session' })
  try {
    await q.interrupt()
    broadcast({ type: 'info', text: '(interrupted)' })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`pocket-claude on http://127.0.0.1:${config.port}`)
  console.log(
    `model=${config.model || '(CLI default)'} cwd=${config.cwd} permissionMode=${config.permissionMode}`
  )
})

// WebSocket passthrough for the web preview: tunnel upgrade requests to the
// /web/<port>/ target, or to the currently previewed port (browsers don't
// send a path-bearing Referer on WS handshakes, so absolute ws:// URLs from
// the proxied page land here). Raw TCP tunnel — frames pass through untouched.
server.on('upgrade', (req, socket, head) => {
  let port = null
  let path = req.url
  const m = /^\/web\/(\d+)(\/.*)?$/.exec(req.url ?? '')
  if (m) {
    port = Number(m[1])
    path = m[2] || '/'
  } else if (webPort) {
    port = webPort
  }
  if (!port) return socket.destroy()

  const upstream = netConnect(port, '127.0.0.1', () => {
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${k === 'host' ? `127.0.0.1:${port}` : v}`)
      .join('\r\n')
    upstream.write(`${req.method} ${path} HTTP/1.1\r\n${headers}\r\n\r\n`)
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})
