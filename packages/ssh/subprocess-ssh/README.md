# `@deepseek-ai/dsh-subprocess-ssh`

English | [中文](README.zh.md)

Provides ordinary managed processes and terminals over the SSH execution world. Output is pulled through bounded chunks, stdin and terminal input are backpressured, terminal resize is remote, and disposal joins the remote process range.

## Model Experience

Indirectly, through [`dsh-tool-bash`](../../shell/tool-bash/README.md) and the terminal and LSP consumers, which render this remote provider's process outcomes, bounded output tails, and terminal streams exactly as they render local spawns.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **The process range is connection-scoped** — every remote child joins the helper lease; transport loss or disposal kills the range, and no detached survival past the connection exists.
- **Output streaming is polled** — chunks are pulled over bounded RPC frames on a fixed cadence rather than pushed; latency-heavy consumers needing push frames are deferred.
- **No remote shell profile loading** — spawned argv runs without a login shell; PATH enrichment and shell initialization files stay the consumer's explicit env concern.
