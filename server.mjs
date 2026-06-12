import { existsSync, readFileSync } from 'node:fs'
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
      append: [
        'When mentioning file paths in your responses, always use paths relative to the working directory. Never print absolute paths (they may be screen-captured).',
        '',
        'The user is on a remote web UI (pocket-claude) with preview tabs: Image, Movie, Web.',
        'When the user asks to see/check an image, video, or a running web app, set it into the matching tab via Bash:',
        `  curl -s -X POST http://127.0.0.1:${config.port}/preview/set -H "Content-Type: application/json" -d '{"kind":"image","path":"./art/player.png"}'`,
        `  curl -s -X POST http://127.0.0.1:${config.port}/preview/set -H "Content-Type: application/json" -d '{"kind":"video","path":"./out/clip.mp4"}'`,
        `  curl -s -X POST http://127.0.0.1:${config.port}/preview/set -H "Content-Type: application/json" -d '{"kind":"web","port":5173}'`,
        'For "web", start the dev server first (in the background), then set its port. After setting, tell the user which tab to open.',
      ].join('\n'),
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
app.use(express.json())

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
  for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

app.post('/message', (req, res) => {
  const text = req.body?.text
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text required' })
  }
  // /clear resets the SDK context — wipe the UI log, the replay buffer,
  // and all previews, so everything starts blank everywhere.
  if (text.trim() === '/clear') {
    history.length = 0
    latestMedia.image = null
    latestMedia.video = null
    webPort = null
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
