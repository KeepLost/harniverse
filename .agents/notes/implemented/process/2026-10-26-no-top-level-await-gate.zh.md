# Agent Note: 顶层 await 禁令门禁

Status: implemented

[English](2026-10-26-no-top-level-await-gate.md) | 中文

## Problem

模块顶层的 `await` 会把模块求值变成异步:所有引用方的求值都要等它;它的 rejection 会变成模块加载失败,而不是模块内可捕获的错误;模块也无法降级成打包器加载的同步 CommonJS 包装。wave-5 调查把官方的 `verify-no-top-level-await` AST 门(row 11)记为廉价卫生类吸收候选;即便没有 WebWorker 镜像,入口失败语义同样适用于我们的包源码。

## Decision

把门禁移植为 `scripts/verify-no-top-level-await.ts`(owner 决策,2026-10-26),接入 `ci-shared-static-gates`(因此每个 CI static 与 primary 聚合都会运行)、`check-all`,以及 `hygiene` 脚本聚合。

门禁用 TypeScript parser 扫描全部 `packages/*/*/src/**/*.{ts,tsx}`,报告最近包围函数体就是模块本身的 `await` 表达式、`for await` 循环与 `await using` 声明——包括嵌在顶层块、条件、循环、计算成员名,以及在模块作用域求值的参数默认值里的形态。字符串、模板与注释永远不是代码。可执行文件按声明排除,绝不按文件名:以 `#!` 开头的文件,以及包 manifest `bin` 字段指名的 `lib/<path>.js` 构建产物对应的源文件。语料自证覆盖:空语料、没有 TSX 的语料、漏掉某个包源码目录的 glob 都会被拒绝,门禁不可能靠少扫通过。

移植门禁时抓到一处真实违规:`packages/ssh/ssh/src/helper-entry.ts` 在模块作用域 `await runSshHelper()`——该文件既是公开的 `./helper` 导出,又是 plain-Node 进程入口。入口改为显式 `main()`,其浮动 promise 保持同样的信号注册、错误上报、`exitCode` 与清理顺序;模块求值重新变为同步,行为不变(其测试套件通过)。

## Alternatives considered

**用 lint 规则替代脚本。** 没有已安装的 linter 规则能以模块作用域精度覆盖 `await using` 与计算成员名位置;AST 遍历很小,且能自带语料保证。

**等下一次缺陷再说。** 这个失败模式是加载期崩溃类,代码评审看不出来;门禁的代价只是对 CI 本就要做类型解析的源码再解析一遍。

## Consequences

- 每个新包的源码自动纳入覆盖:语料守卫在漏掉含 TypeScript 源码的包时直接失败。
- 验证:17 项规格用例覆盖检测形态、排除项、语料拒绝与随发树扫描(2001 个文件、4 个 shebang 可执行文件被排除、零违规);SSH helper 套件(60 项)在入口修复后通过。
