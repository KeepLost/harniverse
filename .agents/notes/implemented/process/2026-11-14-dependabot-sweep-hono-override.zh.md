# Agent Note: dependabot 清扫——hono 安全底线与四个兼容升级

Status: implemented

[English](2026-11-14-dependabot-sweep-hono-override.md) | 中文

日期:2026-11-14。范围:`pnpm-workspace.yaml`(`hono@4` override 与 `minimumReleaseAgeExclude`)、`pnpm-lock.yaml`、`apps/web/package.json`、`website/package.json`(`@types/node`)、`packages/vm/vm-qemu-local/README.md`(+zh,构建操作命令)。一个清扫分支合入四个兼容 dependabot 升级、拒绝第五个。

## 问题

五个 dependabot 告警开放中——全部是 `hono` 低于 4.13.16,经 `@modelcontextprotocol/sdk` 与 `@hono/node-server` 传递可达——而工作区 override 仍钉在 `'hono@4': '4.13.11'`(此前 GHSA-5r4p-p66f-jhc7 multipart DoS 的修复线)。五个 dependabot PR(#267–#271)开放数日、基于过时 master,CI 被无关道染红。其中一个(#269,vite 6→8.3.4)与工作区 override 里两条文档化保留相抵。

## 决策

- **安全修复落在 override,不在清单声明:** `'hono@4': '4.13.16'`(注释扩展点名两个通告族;`minimumReleaseAgeExclude` 跟随)。所有 hono 解析迁到修复版,五条告警全部清除。无源码直接导入 hono,故无代码改动。
- **四个升级经一个清扫分支带入**(从 dependabot 分支合并,锁冲突向当前 dev 状态归一,再 `pnpm install` 规范化):`yaml` 2.9.0→2.9.1、`micromark-factory-space` 2.0.1→2.1.0、`cytoscape` 3.34.0→3.34.3、`@types/node` 22.20.0→26.6.5(纯类型;所有 importer 解析 26.6.5)。
- **vite 大版本拒绝(#269)。** apps 与 website 按文档化决策保留 vite 6:仅 vitest 链解析 8 线并钉在 8.1.6——它早于受影响的 8.3.0–8.3.2 launch-editor 区间,且更新的工具链会把 v8 覆盖归因挪出内联布尔回调;vite 8 的 rolldown CSS 顺序会打断 scrollbar-theme e2e 级联断言;`vitepress>vite: 6.4.5` override 保持共享单一 vite 副本,使 website 配置的 `ViteDevServer` 类型结构兼容——正是 #269 分支在 `Pack npm tarballs` 上死掉的那个类型错误。三条 8 线 CVE 已被 8.1.6 保留覆盖。
- **README 构建操作命令(owner 要求):** `dsh-vm-qemu-local` 的 Assets 节现在写明一次性工具链前置、两种构建调用形式、增量重建行为与 CI 道——双语。

## 备选方案

**按 dependabot 原样合入 #269。** 否决:与两条 override 文档化保留相抵,且其自身分支 CI 已证明破坏(website 配置在 vite 8 类型下的类型错误)。

**把 vitest 链重钉到最新 8.3.8。** 否决:覆盖率归因保留(`esbuild@0.28: 0.28.1`、`ast-v8-to-istanbul: 1.0.4`)是以 8.1.6 祝圣的;移动它会重开逐文件 100% 门的归因,而无任何通告收益——8.1.6 在所有开放 vite 通告之外。

**按清单逐个 bump hono。** 否决:没有包直接声明 hono;override 是工作区对传递安全底线的唯一执行点。

## 后果

五条 dependabot 告警随 override 升级关闭。#267、#268、#270、#271 作为"经清扫落地"关闭;#269 作为"拒绝采纳"关闭,理由记录于此与 PR 评论。apps/website 的 `@types/node` 大版本全树为 26;CI 道负责穷尽验证。

## 测试

规范化后的清扫分支上:`pnpm run build` 绿;`pnpm run website:build` 绿(website 回到共享 vite 6.4.5 副本);聚焦套件绿(`dsh-vm-qemu-local` 与 `dsh-app-boot` 共 523 测);锁文件无 `hono: 4.13.11`(4.13.16 ×3);README 配对重录(1336 对一致);md-wrap、doc 预算、笔记门禁绿。CI 在 PR 上验证 frozen-lockfile 一致性与全道。

## 相关

override 体制的历史见 `pnpm-workspace.yaml` 注释;vite 保留可追溯至该处点名的 scrollbar-theme e2e 级联与覆盖率归因祝圣。
