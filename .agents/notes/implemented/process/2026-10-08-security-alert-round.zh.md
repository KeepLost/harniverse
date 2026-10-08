# Agent Note: 收口 2026 年 10 月的安全告警

Status: implemented

[English](2026-10-08-security-alert-round.md) | 中文

## 问题

GitHub 报告了 8 个 Dependabot 告警和 1 个 secret scanning 告警；代码扫描尚无任何分析。告警涉及 `@modelcontextprotocol/sdk` < 1.31.0（OAuth 客户端把凭据发给由 MCP 服务器指定的授权服务器）、`sharp` < 0.35.5（librsvg 内存安全缺陷，glibc Linux 上可远程执行代码）、`compression` < 1.8.2（响应提前关闭时内存泄漏）、`katex` < 0.18.2、`smol-toml` <= 1.8.0（二次时间解析）、`source-map-js` < 1.2.2、`@vue/server-renderer` < 3.5.42，以及 `sprintf-js` <= 1.1.3。其中两个包对应的 Dependabot 版本 PR 无法关闭告警：`smol-toml` 的 override 把版本固定在低于升级目标的 1.7.1；`katex` 0.16.47 经由 `mermaid` 与 `micromark-extension-math` 引入，其版本线内没有修复版。secret 告警是测试里一个形似 Telegram token 的字面量。

[此前的下限钉扎](2026-09-05-pin-transitive-security-floors.md)用同一机制处理过另一批告警。

## 决策

直接依赖升到首个修复版本。`mcp-client` 与 `ssh` 要求 `@modelcontextprotocol/sdk` `^1.31.0`，把声明的下限抬到易受攻击区间之上，lockfile 解析为 1.31.0。`attachment-local`、`apps/desktop`、`webserver`、`ui-primitives` 分别采用 `sharp` `^0.35.5`、`compression` `^1.8.2`、`katex` `^0.18.2`；根包采用 `smol-toml` `^1.9.0`。

没有 manifest 声明的部分由 `pnpm-workspace.yaml` 的 overrides 覆盖：`smol-toml: 1.9.0` 取代旧的 1.7.1 钉扎，`katex: 0.18.2` 把 0.16 与 0.18 两条版本线合并为一个版本，`source-map-js: 1.2.2` 覆盖 `postcss` 与 Vue 编译器的消费方，`vue: 3.5.42` 带动它精确钉住的 `@vue/*` 包（仅影响 VitePress 文档构建）。

`attachment-local` 通过 `requireSharp` 加载 `sharp`，并在每个进程中一次性屏蔽 libvips 的 `VipsForeignLoadSvg` 操作。SVG 不是受支持的附件格式，因此不可信字节不会进入 librsvg，连被拒绝之前的解码也不会发生。位图解码不变。

`sprintf-js` 没有修复版（1.1.3 已是最新），只经 `electron-builder` → `@electron/get` → `global-agent` → `roarr` 这条桌面打包链进入 workspace。该告警按可容忍风险关闭，而不用 fork 绕开。

测试在运行时拼出形似 token 的夹具（`123456789:${'x'.repeat(35)}`），使任何字面量都不匹配服务商的 secret 模式。

所有 workflow 统一使用 `actions/download-artifact@v8`，与 Python 发布 workflow 一致。release、vendor release、Landlock release 三个 workflow 只按 `name` 或 `pattern` 下载，因此 v5 对按 ID 下载单个 artifact 的路径变更不适用。

## 考虑过的替代方案

**逐个合并 Dependabot PR。** 否决：五个 PR 都改写 `pnpm-lock.yaml`，会依次冲突且各自等待一次完整 CI；其中两个还会让告警继续开着。

**只靠 `sharp` 升级。** 否决：升级关闭了该公告，但 SVG 解码器不服务任何受支持的格式，移除它没有代价，还能缩小下一个 librsvg 缺陷的攻击面。

**采用 Dependabot 的 `actions/download-artifact` v7。** 否决：Python workflow 已使用 v8，每个 action 只用一个主版本能让 workflow 保持一致。

**fork 或内置 `sprintf-js`。** 否决：唯一的消费方是打包期链路，fork 意味着要自己维护一个上游尚未发布修复的库。

## 结果

lockfile 中除 `sprintf-js` 外，不再解析出落在这八个告警区间内的版本。`katex` 在所有位置统一为 0.18 版本，包括文档站点的 `mermaid`。`sprintf-js` 告警保持关闭，直到上游发布修复；届时撤销关闭只需加一个 override。

`pnpm run build`，以及 `mcp-client`、`ssh`、`webserver`、`ui-primitives`、`attachment`、`tool-fs`、`chat` 的测试套件在新的解析上全部通过。`image.spec.ts` 通过 `requireSharp` 固定 SVG 屏蔽的行为。
