# `@deepseek-ai/dsh-client-ui-settings-im`

English | [中文](README.zh.md)

The "IM 机器人" settings section: where a user connects Telegram and Feishu bots to Harniverse, watches their health, adjusts what each bot's conversations start with, and pairs the accounts allowed to talk to them. It is a browser-only plugin over the `chatBots` Remote of [`@deepseek-ai/dsh-chat-manager`](../../chat/chat-manager/README.md) (`ctx.remote.chatBots`); the node half registers no host behavior. The section registers its own nav glyph into the keyed `settings.nav.icon` slot under the section id `im`.

## Composition

```yaml
# host rows (the service this section manages) are owned by the web-app bundle
# browser row
- id: ui-settings-im
  name: '@deepseek-ai/dsh-client-ui-settings-im'
```

The plugin injects the `chatBots` namespace service, so a host that does not mount the chat manager never activates it and the section is simply absent. It registers into `settings.section` with id `im` and order `21`, between Agent presets (20) and Voice input (25). The nav glyph is chosen by section id in `ui-settings-general`.

## Behavior

- **Channels are data.** The left column lists the `platforms` of the host snapshot, one entry per platform descriptor; the connect form is rendered from the descriptor `fields` (credentials as password inputs with a show/hide toggle, `options` as a select, `hint` under the input). A platform added on the host needs no client change: it gets a first-letter badge and a generic empty-state sentence. Telegram and Feishu have their own badges and "how to create a bot" copy.
- **One panel per channel.** The header carries the primary "接入机器人" action and an "N / M 在线" tally. Below it, one card per bot shows the platform badge, the inline-editable alias, the masked platform identity, the state as a dot plus words (运行正常 / 连接中 / 重连中 / 异常 / 已停用, the host message appended to an error), and the last check time. An expanded card holds the workspace, the model with its thinking effort, the Agent Preset, and the actions: check connection, retry (while the bot is neither online nor disabled), disable/enable, and remove behind an inline confirmation.
- **Overrides follow the default.** Workspace, model, and preset each offer "跟随默认", which clears the override. The thinking efforts offered are those of the chosen model, and choosing a different model drops the old effort. The workspace chooser offers the registered workspaces, a typed absolute path, and the native directory picker (`ctx.workspaces.pickDirectory`) when the runtime has one; the model and preset lists come from `llm.models` and `agentPresets.list`.
- **Pairing.** The "已绑定的账号" block lists the channel's paired owners with an unpair action. "生成配对码" requests a one-time code and shows it with an expiry countdown, a copy button, and the `/pair <代码>` instruction for a private chat with the bot. The code is global (not per platform) and the countdown ends in an expiry notice.
- **Polling.** While the section is mounted (the settings shell mounts only the active section) the snapshot is read now and every 3 seconds; ticks are skipped while the page is hidden and a read runs when it becomes visible again. Every mutation refetches the snapshot when it settles, and a read overtaken by a newer one is dropped.
- **Failures.** Connect failures stay inline in the form: `invalid-credentials`, `unreachable`, and `duplicate-bot` have their own Chinese sentences, and any other code shows the host's wording. The host reports every `chatBots` failure under the wire code `chat-bot-failed` with the business reason in `details.reason`; the controller reads the reason and falls back to the wire code. A first failed read shows an error with a retry; a later failed read keeps the last snapshot on screen with a warning. A banner reports a starting, failed, or (once a bot exists) stopped chat bridge; a stopped bridge with no bots is the idle state, since the host starts it with the first bot.
- **Accessibility.** Controls are native buttons, inputs, and selects with labels; the connect form is a labeled `form` with `aria-busy`; statuses are `role="status"` and failures `role="alert"`; the state is always spoken as words (the dot is decorative); the card toggle is an `aria-expanded` button; the removal confirmation starts focus on its safe choice; Escape inside the alias editor cancels the rename without closing the settings panel.

## State and wiring

`createImStore()` declares the section's shared viewing state (latest snapshot and read phase, selected channel, expanded cards, the connect form, pending operations, per-bot outcome notes, the issued code, and the model/preset catalogs); the component reads it through `useStore` and writes through the declared actions only. The operation layer (`controller.ts`) drives the Remote and the catalog wire and publishes outcomes through those actions; it reaches the Remote through one binding point, `ctx.get('remote.chatBots')`, typed from the host's generated namespace. The `/client` entry exports only `apply`, `inject`, and types.

## Model Experience

None, as this package is a browser-side management surface over the `chatBots` Remote; the chat bridge owns every model-visible effect of a bot conversation.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- The snapshot is polled every 3 seconds; a forwarded-event push (the Remote event allowlist) is the sanctioned upgrade and would remove the fixed cadence.
- The pairing code is global: the host mints one code for any platform, so the instruction does not name a bot and the block repeats under every channel.
- The directory chooser takes registered workspaces, a typed path, or the native picker; there is no in-app directory browser, so a runtime without a native picker needs the path typed.
- Preset names are the roster's file names; the localized names of the shipped presets live in the Agent presets section and are not shared across plugins.
