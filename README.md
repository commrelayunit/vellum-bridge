# vellum-bridge

An [OpenClaw](https://docs.openclaw.ai) gateway plugin that lets a self-hosted
[Vellum](https://github.com/vellum-writing/vellum) editor talk to an OpenClaw
agent through Vellum's existing OpenAI-compatible `tools`/streamed
`tool_calls` chat-completion loop — no changes needed on Vellum's side.

It implements two independent features:

1. **Forward-only passthrough** — a byte-transparent OpenAI-compatible proxy
   for normal providers (anything with a real `provider/model` id, e.g.
   `google/gemini-2.5-flash`). Preserves `tools`, `tool_choice`,
   `role: tool` follow-ups, and streamed `delta.tool_calls[].index` without
   re-buffering. OpenClaw never executes the tool here — Vellum receives
   `tool_calls` and applies them itself.

2. **Agent tool bridge** — for requests that need OpenClaw's own agent
   runtime (Codex or embedded) to actually reason and decide when to call a
   tool. Ships one bridged tool, `edit_document`. The model's tool call is
   converted into a normal streamed `tool_calls` delta on the same
   connection; Vellum executes it and sends the result back as a new
   request, which resumes the same paused turn.

## Why a plugin, not a patch

The straightforward way to get this behavior is to patch OpenClaw's
installed `dist/` files directly. Don't do that — those files sit on the
shared code path every model call goes through, and hand-patching them (with
no source, no rebuild path, and no way to safely revert) is a good way to
take down every other channel on the gateway while you're debugging one
feature. This plugin does the same thing through the documented plugin SDK
instead, so it survives OpenClaw upgrades and doesn't touch shared runtime
code.

## Requirements

- An OpenClaw gateway (tested against `2026.6.10`).
- TLS enabled on the gateway (`gateway.tls.enabled: true`) is assumed by the
  examples below; adjust if you're running plain HTTP.
- A working provider for whichever models you route through this plugin —
  Feature 1 reuses OpenClaw's own auth-profile system, so nothing new to set
  up there.

## Install

```bash
npm install
npm run build
openclaw plugins install -l /path/to/vellum-bridge
```

`--link` (`-l`) links the plugin by filesystem path (added to
`plugins.load.paths`) rather than copying it — the usual way to run a
locally-developed plugin. It also flips `plugins.entries.vellum-bridge.enabled`
to `true` and adds `vellum-bridge` to `plugins.allow` automatically.

## Configuration

### 1. Allow the agent tool bridge to pick its own model

`subagent.run` model overrides are gateway-security-gated per plugin. Grant
this plugin permission, scoped to only the models you actually want Vellum
sessions to use:

```bash
openclaw config set 'plugins.entries.vellum-bridge.subagent' \
  '{"allowModelOverride": true, "allowedModels": ["google/gemini-2.5-flash"]}'
```

Omit `allowedModels` (or set it to `["*"]`) to allow any model — not
recommended; keep it scoped to what you actually use.

### 2. Make `edit_document` visible to the agent

OpenClaw's tool visibility is governed globally by `tools.profile` +
`tools.allow`, applied as sequential filters — a tool must survive *every*
configured step to be visible to any session, including this plugin's own
`registerTrustedToolPolicy` execution gate (which only decides who is
*allowed to call* an already-visible tool — it doesn't make an invisible
tool visible).

Add `edit_document` to your global `tools.allow`:

```bash
openclaw config set 'tools.allow' '[...your existing entries..., "edit_document"]'
```

If you're using a restrictive `tools.profile` (e.g. `"coding"`), note that
the profile step runs *before* `tools.allow` and can strip a tool that
`tools.allow` would otherwise permit — e.g. `edit_document` isn't part of any
built-in profile's base tool set. If that happens, either add every tool you
need directly to `tools.allow` and unset `tools.profile` entirely (so
`tools.allow` becomes the sole gate — this plugin was developed against that
setup), or accept that plugin-registered tools need `tools.profile: "full"`
to survive the profile step.

### 3. Restart the gateway

```bash
systemctl restart openclaw-gateway   # or however you run it
```

## Vellum-side setup

Point Vellum's OpenAI-compatible `baseUrl` at:

```
https://<your-gateway-host>:<port>/vellum/v1/chat/completions
```

The route requires standard OpenClaw gateway authentication (`auth:
"gateway"`, `trusted-operator` scope) — send your gateway bearer token the
same way you would for any other authenticated gateway API call:

```
Authorization: Bearer <gateway.auth.token>
```

For the agent tool bridge (any request carrying `tools`), also send:

```
x-vellum-session-id: <a stable id for this Vellum document/conversation>
```

so the plugin can correlate multi-round tool-call loops to the same
underlying agent session. Requests without `tools` are treated as plain
passthrough and don't need this header.

## Security notes

- `edit_document` is gated by `registerTrustedToolPolicy`: it only executes
  for sessions that came in through this plugin's own route. It is not
  exposed to any other channel or session.
- The route itself requires real gateway authentication — there is no
  separate, weaker auth path. Anyone with your gateway's bearer token can
  already do far more than call `edit_document`, so this doesn't introduce a
  new privilege.
- Keep `plugins.entries.vellum-bridge.subagent.allowedModels` scoped to
  models you actually intend Vellum sessions to use.

## Development

```bash
npm install
npm run build              # tsc -p tsconfig.json
node --check dist/*.js     # quick syntax sanity check before restarting the gateway
```

There's no automated end-to-end test harness here yet — verify against a
running gateway with `curl` (see the two-round example in this repo's
issue/PR history, or construct one from the OpenAI streaming chat-completions
format) before trusting a change in production.
