# Agent Note: 将 typecheck 与工件打包拆分

Status: implemented

[English](2026-10-26-typecheck-artifacts-check-split.md) | 中文

## Problem

`pnpm run typecheck`(`pre-push` 钩子与 node-compat CI 泳道都会运行)串行执行完整的 Host lib 阶段 —— Host `tsc -b`、完整的 Host tsdown 打包、然后才是 Client `tsc -b`。在一台负载较高的开发机上实测:Host `tsc -b` 94 秒,Host tsdown 66 秒,Client `tsc -b` 72 秒,冷态合计 231 秒;全部最新时也要 68.4 秒,其中 Host tsdown 打包占 66 秒。这条链路里藏着两笔不同的开销:

- Host **打包**(全部运行时 chunk)是类型检查永远读不到的工件工作;Client tsc 从 Host 阶段真正消费的只有包声明和生成的 Typert 工件,而生成器自身的分析表明 66 秒的 tsdown 过程约 60 秒是 Typert 生成、约 6 秒才是打包。
- 即便它读取的输入毫无变化,生成也每次全量执行 —— 这是未改动树上 `typecheck` 的主要开销。

## Decision

`pnpm run typecheck` 现在是 `tsx scripts/typecheck.ts`:Host 聚合构建(`tsc -b tsconfig.host.json`,堆上限仍为 6144 MiB)与源码态 Typert 生成**并发**运行;两者都成功后,Client 聚合构建才运行。任一生产者失败则 Client 检查不启动,其诊断不会叠在一个失败的生产者之上。

`scripts/generate-typert.ts` 独立从源码运行 Typert 生成 —— 不经 tsdown、不打包 —— 通过生成器 tsdown 插件模块导出的 `generateWorkspaceArtifacts()` 执行,插件的 workspace 模式现在也调用该入口。两个生产者写入字节相同的工件,因为它们共享同一实现。生成由 `node_modules/.cache/dsh/generate-typert.json` 的指纹缓存守护:对 Host 聚合传递引用到的全部项目树的所有文件(内容哈希;排除 `lib`、`node_modules`、`tests` 子树)加上 `tsconfig.host.json`、`tsconfig.base.json` 与所装 TypeScript 版本做 SHA-256。指纹命中且记录的工件全部存在则跳过生成;工件被删除则无视指纹强制重新生成。生成失败时旧缓存保持原样。

`build:lib:host` 与 `build:lib:client` 不变,仍负责工件生产,包括 tsdown 打包;[api-remotes 生成式契约构建](2026-08-08-api-remotes-generated-contract-build.md)的 Host 先于 Client 顺序在那里继续成立。`typecheck:contracts-ready`(仅 Client tsc)不变,仍是 Typert contracts 泳道之后的 CI 门;CI 门图未做任何改动。

## Measurements

同一台开发机,冷态各一次采样(每次冷跑前 `pnpm run clean`),热态为未改动树上的数字:

| 场景 | 之前 | 之后 |
|---|---|---|
| 冷态 `pnpm run typecheck` | 231 秒 | 188 秒 |
| 热态 `pnpm run typecheck` | 68.4 秒 | 3 秒 |
| 独立重新生成(缓存未命中) | — | 73 秒 |
| 独立跳过(缓存命中) | — | 2 秒 |

负控制:Host 包内类型错误使 Host 步骤失败且 Client 步骤不启动(退出码 2,无 `client tsc` 行);Client 根程序类型错误使 Client 步骤失败(退出码 2);对 Host 源码只加一行注释即改变指纹并触发重新生成;指纹其余匹配但删除一个工件会强制重新生成。改动之后 `pnpm run build` 照常完成(tsdown 过程重新生成相同的 Typert 工件),随后生成在共享指纹上跳过,证明两个生产者对状态的判定一致。

## Trade-offs

- typecheck 路径不再刷新 Host **打包**工件;需要打包的场景仍照旧运行 `build:lib` / `build`。`typecheck` 对类型错误依旧完整:两个聚合根程序仍被检查,包源码仍经同样的 `tsc -b` 调用编译。
- Host `tsc -b` 与生成并发,瞬时内存约为一个 tsc 进程与一次生成器分析之和;Client 步骤只在两者都退出后开始。
- 指纹对生成器输入做过近似(整个项目树减 `lib`/`node_modules`/`tests`,加两个根配置与 TypeScript 版本):Host 引用项目内不影响 Typert 的改动也会触发重新生成 —— 但绝不会反向遗漏。聚合根文件(测试、脚本、网站)刻意不在指纹内;它们不参与包反射。
- 异常的 host-tsc 中断之后,过期的缓存不可能掩盖类型错误:生成只产出声明,重编译什么由 tsc 自身的增量状态决定。

## Alternatives considered

- **去掉 tsdown 但不做缓存:** 单独生成每次仍要约 60 秒,热态路径停在 62 秒附近,拆分几乎买不到什么。
- **两个 `tsc -b` face 并发:** 它们共享叶子项目,并发构建模式会在相同 `tsbuildinfo` 文件上竞态;Host 在前的顺序保留。
- **让 tsdown 增量化:** 对配置与入口变更很脆弱,也不能把生成器的全量分析从热态路径中移走。
- **为 `build` 本身引入上游式 run-gates 步骤图:** CI 门图已经通过 `typecheck:contracts-ready` 让 typecheck 门不重复 Host 阶段;本地串行痛点不需要重构 CI。

## Consequences

`pre-push` 钩子和每次本地 `pnpm run typecheck` 不再为打包与未变化的生成付费:冷态检查省约 43 秒,未改动树上的检查从 68 秒降到约 3 秒。生成器包导出 `generateWorkspaceArtifacts()` 作为唯一生成入口,tsdown 插件、脚本与将来的消费者不会彼此漂移。

验证:`scripts/generate-typert.spec.ts` 覆盖引用遍历、指纹的稳定性与敏感性(源码、基础配置、TypeScript 版本;排除 lib 与 tests)、跳过条件(指纹匹配、工件存在)、生成失败时的缓存处理;`scripts/typecheck.spec.ts` 覆盖计划形状、并发阶段顺序、生产者失败短路、退出码传播;生成器包测试套件覆盖共享的 `generateWorkspaceArtifacts` 重构。
