# @deepseek-ai/dsh-client-ui-dashboard

English | [中文](README.zh.md)

Dashboard, browser half: one sidebar footer trigger opens the dashboard (仪表盘) center view — a shell carrying the title, the dismissal button, and an in-page tab ring over `dashboard.center.tab` slot contributions. Each management surface is a self-sufficient tab contributed by its own domain package (定时任务 from `ui-scheduler`, 远程主机 from `ui-remote-hosts`, 本机资源 from `ui-governor`, 消息队列 from `ui-queue`); with a single contribution the tab ring stays hidden. The node half registers no host behavior.

## Composition

- Contributes one `sidebar.footer.action` entry (id `dashboard-view`) whose trigger opens the center view through `ctx.layout.setCenterView('dashboard')`.
- Declares the root-scoped `dashboard.center.tab` list slot as the center view's children; a tab registration carries its `order` (the ring) and a `label` (thunk or string) resolved by the shell.
- `inject`: `slots`, `locale`, `layout`.

## Model Experience

None, as the shell only composes other plugins' management surfaces; every tab's data path belongs to its owning package.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work
- Tab selection lives in a per-browser-session store and is not persisted across reloads; persistence can ride the store engine's `persist` key when wanted.
