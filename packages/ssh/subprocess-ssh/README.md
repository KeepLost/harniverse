# `@deepseek-ai/dsh-subprocess-ssh`

English | [中文](README.zh.md)

Provides ordinary managed processes and terminals over the SSH execution world. Output is pulled through bounded chunks, stdin and terminal input are backpressured, terminal resize is remote, and disposal joins the remote process range.

## Model Experience

Indirectly, through [`dsh-tool-bash`](../../shell/tool-bash/README.md) and the terminal and LSP consumers, which render this remote provider's process outcomes, bounded output tails, and terminal streams exactly as they render local spawns.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.
