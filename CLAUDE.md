# pocket-claude — AI setup guide

You (Claude Code) are likely being asked to set this project up for the user.
This file tells you everything you need. The whole app is 3 source files:
`server.mjs` (Express + Claude Agent SDK bridge), `public/index.html` (the UI),
and `config.json` (user settings, created from `config.example.json`).

## What this is

A tiny local web server that hosts a persistent Claude Code session
(via `@anthropic-ai/claude-agent-sdk`, streaming input mode) and streams
everything — tokens, tool calls, permission prompts — to a plain web UI over SSE.
Exposed to the user's phone via Tailscale. Auth is inherited from the local
Claude Code CLI login; no API key is involved.

## Setup steps (do these for the user)

1. **Check prerequisites**
   - `node --version` → needs Node 18+.
   - `claude --version` → Claude Code CLI must be installed and logged in.
     If not logged in, tell the user to run `claude` once and authenticate.
2. **Install**: `npm install` in this directory.
3. **Create `config.json`**: copy `config.example.json` and ask the user:
   - `cwd` — the absolute path of the project they want Claude to work on. **Required.**
   - `model` — empty string uses their CLI default. `"claude-fable-5"`, `"opus"`, etc. to pin.
   - `permissionMode` — `"default"` relays every tool permission to the web UI
     (Allow/Deny buttons; good first experience). `"acceptEdits"` auto-approves
     file edits. `"bypassPermissions"` approves everything — only for trusted
     directories, warn the user before setting this.
   - `port` — default 3200.
4. **Start**: `npm start`, then verify with:
   ```
   curl -s -X POST http://127.0.0.1:<port>/message -H "Content-Type: application/json" -d "{\"text\":\"Say OK\"}"
   ```
   and check `curl -s -N http://127.0.0.1:<port>/events` shows streaming `text` events.
5. **Remote access (optional but the whole point)**: if the user wants phone access,
   check `tailscale status`. If Tailscale is installed and running:
   ```
   tailscale serve --bg <port>
   ```
   Give the user the resulting `https://<machine>.<tailnet>.ts.net` URL.
   They need the Tailscale app on their phone, same account.
   **Never use `tailscale funnel`** — this app has no authentication of its own
   and must not be exposed to the public internet.

## Troubleshooting

- **Server starts but messages hang**: the Claude CLI is probably not logged in,
  or the model in `config.json` isn't available on the user's plan. Try `model: ""`.
- **Port in use**: change `port` in `config.json` (also re-run `tailscale serve`).
- **Voice button disabled on phone**: speech recognition needs HTTPS — make sure
  they're using the `https://….ts.net` URL, not `http://<ip>:<port>`.
- **Permission prompt never appears**: events are only delivered to open browsers;
  reconnecting replays the last 500 events, so just (re)open the page.
- **Changing `cwd` or `model`**: edit `config.json` and restart the server
  (the session is recreated; context starts fresh).

## Preview tabs (Image / Movie / Web)

The UI has preview tabs fed by `POST /preview/set` (the session's system prompt
teaches the model to call it via curl when the user asks to see something).
`GET /preview/state` returns what's currently set. Media previews hold the
latest item only; `/web/<port>/` reverse-proxies a local dev server into the
Web tab's iframe (plain HTTP, no websockets — dev preview, not a tunnel).

## Notes for future development

- The session is a single shared conversation. Multiple browsers see the same stream.
- `/clear` and `/compact` can be typed in the UI; the `/` key pops up the command list
  (fetched from the SDK's `system/init` message, includes the user's custom commands).
- Keep this project dependency-light on purpose (express + agent SDK only).
