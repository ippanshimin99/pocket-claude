#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { existsSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CONFIG_PATH = join(ROOT, 'config.json')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => rl.question(q, r))

console.log('\n── pocket-claude setup ──────────────────────────\n')

// 1. Node version check
const nodeVer = parseInt(process.versions.node.split('.')[0])
if (nodeVer < 18) {
  console.error(`✗ Node 18+ required (you have ${process.versions.node})`)
  process.exit(1)
}
console.log(`✓ Node ${process.versions.node}`)

// 2. Claude CLI check
try {
  execSync('claude --version', { stdio: 'pipe' })
  console.log('✓ Claude Code CLI found')
} catch {
  console.error('✗ Claude Code CLI not found. Install it from https://code.claude.com')
  process.exit(1)
}

// 3. Existing config warning
if (existsSync(CONFIG_PATH)) {
  const overwrite = await ask('\nconfig.json already exists. Overwrite? [y/N] ')
  if (overwrite.trim().toLowerCase() !== 'y') {
    console.log('Keeping existing config. Done.')
    rl.close(); process.exit(0)
  }
}

console.log('')

// 4. cwd
const defaultCwd = process.cwd()
const cwdInput = await ask(`Project directory to work in\n  [${defaultCwd}] `)
const cwd = cwdInput.trim() || defaultCwd
if (!existsSync(cwd)) {
  console.error(`✗ Directory not found: ${cwd}`)
  rl.close(); process.exit(1)
}
console.log(`  → ${cwd}`)

// 5. model
console.log('\nModel to use:')
console.log('  1) CLI default (recommended)')
console.log('  2) claude-opus-4-8')
console.log('  3) claude-sonnet-4-6')
console.log('  4) Custom (type model name)')
const modelChoice = (await ask('  [1] ')).trim() || '1'
const MODEL_MAP = { '2': 'claude-opus-4-8', '3': 'claude-sonnet-4-6' }
let model = ''
if (modelChoice === '4') {
  model = (await ask('  Model name: ')).trim()
} else {
  model = MODEL_MAP[modelChoice] ?? ''
}
console.log(`  → ${model || '(CLI default)'}`)

// 6. permissionMode
console.log('\nPermission mode:')
console.log('  1) default        — every tool action needs Allow/Deny on your phone (safest)')
console.log('  2) acceptEdits    — file edits auto-approved, everything else asks')
console.log('  3) bypassPermissions — fully autonomous (trusted directories only!)')
const pmChoice = (await ask('  [1] ')).trim() || '1'
const PM_MAP = { '1': 'default', '2': 'acceptEdits', '3': 'bypassPermissions' }
const permissionMode = PM_MAP[pmChoice] ?? 'default'
console.log(`  → ${permissionMode}`)

// 7. port
const portInput = (await ask('\nLocal port [3200] ')).trim()
const port = portInput ? parseInt(portInput) : 3200
if (isNaN(port) || port < 1 || port > 65535) {
  console.error('✗ Invalid port'); rl.close(); process.exit(1)
}

rl.close()

// Write config
const config = { port, model, permissionMode, cwd }
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')

console.log('\n✓ config.json written:\n')
console.log(JSON.stringify(config, null, 2))

// 8. Tailscale hint
console.log('\n── Next steps ───────────────────────────────────')
console.log(`  npm start                  # start the server`)
console.log(`  tailscale serve --bg ${port}   # expose to your phone (optional)`)
console.log('')
try {
  const tsStatus = execSync('tailscale status --json', { stdio: 'pipe' }).toString()
  const ts = JSON.parse(tsStatus)
  const self = Object.values(ts.Peer ?? {}).find(p => p.Self) ?? ts.Self
  if (self?.DNSName) {
    const host = self.DNSName.replace(/\.$/, '')
    console.log(`  Your Tailscale URL (after tailscale serve):`)
    console.log(`  https://${host}\n`)
  }
} catch {
  // Tailscale not installed or not running — skip
}
