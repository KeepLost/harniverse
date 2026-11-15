# dsh-util-ripgrep

[English](README.md) | 中文

Harness 的打包版 ripgrep 解析与子进程流式读取助手——唯一知晓内嵌 `@vscode/ripgrep` 二进制在各种运行时形态下如何被抵达的地方。

## 模型

- `resolveRgPath()` 惰性地、每进程一次地解析打包二进制:默认取 `@vscode/ripgrep` 平台包,Electron 下取解包后的 ASAR 路径,单文件可执行旁若存在 `-rg` 边车则优先。平台包缺失或损坏让本次调用拒绝(绝不是包加载失败),因此不完整安装只在第一次搜索时失败,而不是在组合装配时。
- `spawnRipgrep(subprocess, spec)` 通过 subprocess 缝起进程,并前置 `--no-config`,使外部的 `RIPGREP_CONFIG_PATH` 无法注入 `--pre` 预处理器。调用方拥有 argv、退出分类与清理。
- `readRipgrepLines(handle, separator, onLine)` 流式读取 UTF-8 stdout 记录而不驻留完整输出;回调返回 `false` 提前终止进程(结果上限的停止路径)。完成、回调失败与流失败都会等进程静止;退出码与取消归属消费方。

消费方:工作区文件搜索(host `apiproxy`)。`grep`/`glob` 模型工具在 `dsh-tool-fs-search` 中保留自己的有界收集运行器——那里拥有面向模型的 schema 与溢写语义;两者的统一推迟到退出分类契约收敛之时。

## 已知限制与待办

- 不回退系统 `rg`,也不做远程执行:助手只解析打包二进制,并通过调用方的 subprocess 提供者起进程,该提供者必须与被搜索的文件系统同位。
