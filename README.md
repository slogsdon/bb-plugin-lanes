# bb-plugin-lanes

Every model lane's headroom in one place.

bb natively tracks Claude Code and Codex subscription windows. It knows nothing
about OpenCode Zen Go or OpenRouter, so the lanes you are most likely to exhaust
by surprise are the ones with no gauge. This adds them, normalised into the same
shape bb already uses.

```bash
bb lanes           # human-readable
bb lanes --json    # for agents deciding where to route work
```

Also renders as a settings section — see *Placement* below for why it is not on
the Usage limits page.

## The distinction it encodes

The four lanes are not the same kind of thing, and the display says so:

- **subscription** — Claude Code, Codex, and **OpenCode Go**. A quota window that
  *refills*. Exhausting one costs you waiting until `resetsAt`. Go is a $10/mo
  plan with rolling/weekly/monthly caps, so it belongs here despite being an API.
- **metered** — OpenRouter. A balance that *depletes*, with no auto-reload. It
  does not throttle; it runs dry and the lane stops working. Rendered with
  remaining dollars and deliberately **no countdown**, because nothing refills it
  and a timer would be a lie.

## LiteLLM is deliberately not a lane

It is the router your Zen and OpenRouter traffic flows *through*, so listing it
beside them would double-count. Its useful axis is attribution — which alias
burned the budget — which needs one LiteLLM virtual key per lane, since
`/global/spend/report` groups by `team`/`customer`/`api_key` but not by model.
Not implemented.

## It displays. It does not alert.

bb has no notification system of any kind: no settings, no push code in the
server bundle, no notification tables, nothing in the plugin catalog, and nothing
reaches the desktop app or the PWA. This plugin polls every 5 minutes into
plugin kv and shows you the result **when you look**.

Alerting is a separate job. If you need to be told before you look, run a poller
of your own against the same endpoints (see *Sources*) and push through ntfy or
similar. If you already have one, do not delete it on the assumption that this
plugin covers it.

## Gotchas worth knowing

**Credentials are read from `~/.bb/env.json` *before* `process.env`, and the
order matters.** `process.env` is a snapshot taken when the bb server started, so
after a key rotation it serves a revoked credential until the whole server
restarts. The file on disk is what you actually edit. Reading env first produced
a live 401 on OpenRouter minutes after a rotation while the file was already
correct.

**Zen rejects some default user agents outright.** Requests send an explicit
`User-Agent`; without one, `https://opencode.ai/zen/go/v1/usage` returns 403 with
a valid key. Identical key, 403 with urllib's default and 200 with any ordinary
identifier. It looks exactly like an auth failure and is not.

**Context windows are unverified.** Zen's `/models` advertises only `id` and
`owned_by`, so nothing here reports Go context limits.

## Placement

The natural home is bb's built-in **Settings → Usage limits**, beside Codex and
Claude Code. That page is host-owned and no slot targets it —
`PluginSettingsSectionRegistration` has no page selector — so this lands under
**Extensions → Plugins → Lanes** instead. Filed upstream at
[get-bb/bb](https://github.com/get-bb/bb) asking for a contribution slot; the
data already shares bb's `{label, usedPercent, resetsAt}` shape, so if that
lands the component moves with no rework.

Switching to `homepageSection` (always visible) or `navPanel` (its own sidebar
entry) is a one-line change in `app.tsx`.

## Sources

| Lane | Endpoint |
|---|---|
| Claude Code, Codex | `bb.sdk.system.usageLimits()` |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` |

OpenRouter is read from **credits**, not the key's spend cap — the balance is
what actually stops the lane.

## Developing

Installed from a path, so the backend loads `server.ts` directly — edit and
`bb plugin reload lanes`. Frontend changes need `bb plugin build .` first, or run
`bb plugin dev` to watch.
