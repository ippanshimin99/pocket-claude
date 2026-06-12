# pocket-claude 📱⚡

**Your phone becomes a complete dev environment.**

Claude Code runs on your PC at home — everything it does shows up in your hand.
Say *"run the game"* and the game running on your PC becomes playable in your
phone browser. Say *"show me the sprite"* and the image appears. You never have
to deploy something just to look at it again.

```
Phone browser ──Tailscale (HTTPS)──▶ your PC ──▶ persistent Claude Code session
   🎤 voice                            │            (official Agent SDK)
   tokens · tools · permissions ◀──SSE─┤            works on YOUR project dir
   live game · images · video  ◀─proxy─┘            (preview tabs)
```

## What you get

- **See your work, not just text.** Three preview tabs:
  - **Web** — Claude starts your dev server and pipes it into a live, tappable
    iframe on your phone (reverse-proxied through your tailnet)
  - **Image** — ask to see any image and it's there; images Claude writes are
    auto-detected too
  - **Movie** — videos play with full seek controls
- **Nothing dumbed down.** Replies stream word by word, you see every command as
  it runs (`⏺ Bash: npm test`), and you can interrupt mid-task. The real CLI
  feel, not a status page.
- **Risky actions ask you first.** Tool approvals arrive as Allow/Deny buttons
  on your phone — no need to run with `bypassPermissions`.
- **Voice input.** Tap 🎤 and talk (Web Speech API, your device language).
- **Slash commands.** Type `/` for autocomplete — `/clear`, `/compact`, plus your
  project's custom commands, straight from the SDK. `/clear` resets everything:
  context, chat log, and all previews.
- **Your subscription, the official way.** Built on the official
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which
  delegates auth to your local Claude Code CLI login. No API key, no OAuth hacks,
  no third-party harness — this is the sanctioned path.
- **Small enough to actually read.** ~650 lines total: `server.mjs` +
  `index.html` + a config file. Audit it in ten minutes, fork it without fear.

## Quickstart

Prerequisites: Node 18+, [Claude Code](https://code.claude.com) installed and logged in.

```bash
git clone https://github.com/KanW123/pocket-claude
cd pocket-claude
npm install
cp config.example.json config.json   # then edit "cwd" to your project path
npm start                            # → http://127.0.0.1:3200
```

### Or let Claude set it up

Open this folder in Claude Code and say **"set this up for me"** —
[`CLAUDE.md`](CLAUDE.md) contains the full setup playbook (prerequisite checks,
config interview, Tailscale exposure, smoke test).

## Phone access (Tailscale)

```bash
tailscale serve --bg 3200
```

Open `https://<machine>.<your-tailnet>.ts.net` on your phone (Tailscale app installed,
same account). HTTPS from `tailscale serve` is also what makes voice input work.

> ⚠️ **Never use `tailscale funnel`.** pocket-claude has no authentication of its own.
> Keep it tailnet-only.

## Config

`config.json`:

| Key | Default | Meaning |
|---|---|---|
| `port` | `3200` | Local port |
| `model` | `""` (CLI default) | Pin a model, e.g. `"claude-fable-5"`, `"opus"` |
| `permissionMode` | `"default"` | `default` = relay prompts to UI · `acceptEdits` = auto-approve edits · `bypassPermissions` = approve everything (trusted dirs only!) |
| `cwd` | server dir | The project directory Claude works in |

Restart the server after changing config (a fresh session is created).

## Usage notes

- One shared session: every connected browser sees the same stream; reconnects
  replay the last 500 events.
- **Stop** interrupts the current turn without killing the session.
- `/clear` resets context, `/compact` summarizes it — useful on long mobile sessions.
- Custom slash commands from your project's `.claude/commands/` or `.claude/skills/`
  appear in the `/` autocomplete automatically.
- **Previews** hold the latest item only (ephemeral by design). Claude sets them
  when you ask to see something; they're also auto-detected when Claude writes
  image/video files. Each tab has a ↻ Reload button (cache-busted), and the Web
  tab takes a manual port too. The web proxy is dev-preview grade: no
  websockets/HMR, plain HTTP only.

## Security model

- Binds to `127.0.0.1` only; reachability comes from your private tailnet.
- Anyone who can reach the page can drive Claude in `cwd` — that's the deal.
  Use your tailnet's device approval, keep `permissionMode: "default"` for
  sensitive directories, and don't point `cwd` at your home directory.
- Auth/billing rides on your local Claude Code login (subscription or API —
  whatever your CLI uses).

## License

pocket-claude is an unofficial community project, not affiliated with or endorsed
by Anthropic. "Claude" is a trademark of Anthropic, PBC.

pocket-claude is MIT. It depends on the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
(© Anthropic PBC, proprietary), which is **not** bundled here — npm installs it
on your machine under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance),
and usage runs on your own Claude Code login.
