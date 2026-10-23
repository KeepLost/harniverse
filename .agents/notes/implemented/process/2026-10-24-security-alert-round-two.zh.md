# Agent Note: 关闭 2026 年 10 月第二轮安全告警

Status: implemented

[English](2026-10-24-security-alert-round-two.md) | 中文

## Problem

GitHub 报出二十五项打开的 Dependabot 告警:十四条 `electron` 公告(43.0.0-alpha.1 至 43.7.x:链接打开窗口的 SameSite 失效、指针锁定 / `openExternal` / HID-USB 权限归属到错误 frame 或 origin、扩展 `tabs.query` 越权返回 URL 与标题、frame 订阅与 macOS 离屏渲染信任 GPU 提供的帧几何),五条 `vite` 6 公告(自定义中间件跨源脚本执行、非 Windows 上 `server.fs.allow` 绕过、三个 `launch-editor` 命令执行缺陷),三条 `dompurify` 净化绕过(`SAFE_FOR_TEMPLATES` 分割模板表达式、`IN_PLACE` 分离子树事件处理器存活、XHTML 媒体类型下 SMIL `attributeName=href` 防护跳过),两条 `@vitest/mocker` 公告(未认证手动 mock 注册、Windows 反斜杠路径绕过其允许清单修复),以及 `ip-address` 10.7.3 的二次方 zone 标识解析。Dependabot PR #203(`ip-address`)与 #204(`electron`)针对同一 lockfile 打开。

## Decision

直接依赖升到首个修复版:`apps/desktop` 钉 `electron` `43.7.6`(覆盖全部十四条公告),四份 `vitest` 清单(root、`apps/web`、`client-runtime`、`acp-snapshot`)取 `^4.1.12`,其解析器带入 `@vitest/mocker` `4.1.12`;两份 `vite` 6 清单升到 `^6.4.4`(`website` 自 `^6.4.3`,`apps/web` 自 `^6.0.0`;均解析为 6.4.5,高于 6.4.4 下限)。

`pnpm-workspace.yaml` overrides 覆盖传递解析:`dompurify` `3.4.17` 替换 3.4.16 钉版(mermaid 与 vitepress 链),`vitepress>vite` `6.4.4` 替换 6.4.3(文档站自带的 vite 6 副本),新增 `ip-address: 10.7.4` 地板钉,约束 `express-rate-limit`、`mcp-client`、`ssh` 与 subagent 包下的全部解析。

## Alternatives considered

**合并打开的 Dependabot PR。** 否决作为主修复:#203 与 #204 只覆盖五个包中的两个,且都在同一 overrides 墙上串行改写 `pnpm-lock.yaml`,各自等待完整 CI;本轮同时取代两者。

**直接 override `@vitest/mocker`。** 否决:它与 `vitest` 每个发行版同版本,把四份 `vitest` 清单抬到 `^4.1.12` 即可解析,无需第二枚钉。

**把 `electron` 跳到 45.x。** 否决:全部公告在 43.7.6 内修复,桌面运行时保持最接近的补丁版而非未经测试的大版本跳跃。

## Consequences

lockfile 不再解析出二十五条告警范围内的任何版本:`electron` 43.7.6、`@vitest/mocker` 4.1.12、`dompurify` 3.4.17、`ip-address` 10.7.4,vite 6 仅存 6.4.4(vitepress 链)与 6.4.5(直接依赖)。vite 6 双副本保持到 vitepress override 退役为止;没有消费者感知差异。新解析下 `pnpm install`、`pnpm run typecheck`、`pnpm run build`、`pnpm run test:gui`(7382 通过、1 跳过)与 `pnpm run test:desktop` 全部通过。#203 与 #204 在其目标告警解除后自动关闭。
