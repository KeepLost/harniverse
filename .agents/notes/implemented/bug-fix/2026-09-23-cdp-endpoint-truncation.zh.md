# Agent Note: CDP 启动端点匹配到了半截的 stderr 行

Status: implemented

[English](2026-09-23-cdp-endpoint-truncation.md) | 中文

## Problem

在装有真实 `google-chrome`／`chromium` 的机器上，浏览器面板无法打开并报 `DevTool endpoint ws://… refused the connection`，而 Chrome 本身完全健康。`packages/api/browser-controller/src/launch.ts` 的启动路径从子进程 stderr 抓取 `DevTools listening on ws://…` 行并把捕获的 URL 交给 WebSocket。stderr 是分块到达的，当块边界恰好落在端点行内部时，抓取器仍然宣布匹配成功：在 JavaScript 中带 `m` 标志的 `$` 同时匹配**输入结束**，而不只是行尾，于是半截 URL 在正则看来是完整的。URL 尾部的 GUID 是浏览器自身的 session id，截断的 id 指向不存在的目标，Chrome 拒绝握手——用户看到的报错正来源于此，一字不差。

## Decision

把匹配锚定在真实的换行上：`ENDPOINT_PATTERN` 现在要求捕获的 URL 之后必须有 `\r?\n`，端点只有整行到齐才会被采纳。块内截断只是让正则暂不匹配，等下一块补齐即可。`packages/api/browser-controller/tests/fake-browser.ts` 新增 `splitEndpointTail` 旋钮，可按字节偏移把端点行拆成两次写入；其 WebSocket 服务器也改为按路径（`/devtools/browser/fake`）路由并拒绝未知路径，与真实 Chrome 一致——这正是让失败在修复前可观测的关键。回归用例 `waits for the whole endpoint line when the stream delivers it in two reads` 对未修复的正则复现出与用户完全一致的报错，修复后通过。

## Alternatives considered

第一个假设是给 Chrome 命令行加 `--remote-allow-origins`，此处并不相关：Node 的全局 `WebSocket` 不发送 `Origin` 头，Chrome 111+ 的来源检查根本不会触发。第二个假设是给连接被拒的错误附加上底层原因，同样无效：无论连接被拒还是路径不存在，平台给出的 `ErrorEvent.message` 都是空串，没有可呈现的内容。

## Consequences

启动对端点行上任意块边界稳健，整行到达的行为不变。假浏览器的路径路由也让其余启动测试不再会接受真实 Chrome 会拒绝的端点。

## Testing

`NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/vitest run packages/api/browser-controller/tests --maxWorkers=1 --no-file-parallelism` —— 104 个测试含新的两次读取回归。
