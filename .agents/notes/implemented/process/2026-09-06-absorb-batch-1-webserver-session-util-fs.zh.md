# Agent Note: 吸收批次 1——webserver gzip、会话面守卫、重复安装安全、路径规范化、模型面 fs

Status: implemented

[English](2026-09-06-absorb-batch-1-webserver-session-util-fs.md) | 中文

## 问题

官方增量中的四个 Absorb-soon 项在 Harniverse 携带真实缺陷或缺口。web server 的所有响应都不压缩，Workbench bundle 全额负载成本。Typert Remote 标记存于模块级 `WeakMap`，协议包装两份时各持独立标记表——经副本 A 执行的装饰器对副本 B 的 `remoteMethods()` 不可见。workspace 注册表直接规范化 `fs.realpath` 的返回——相对路径 `.` 会被 Host cwd 悄悄收养（在仓库根上创建 workspace）、Windows 盘符相对路径从当前盘收养、盘符根得出空默认标题。客户端 workspace 路径拼接恒用 `/`，把 `C:\` + `src\a.ts` 拼成混合分隔符路径。`read_image` 一律拒绝无扩展名路径，未读变更诊断对同一策略违规呈现两种文案。另有两项调查证实为非缺陷：会话面替换端点与压缩跨度的顺序已被我方 `replacementRange`/`assertProvenance`/`validateShadowMetadata` 边界守住，重读后缺失也已是 fs 栈的既定契约。

## 决策

按契约级移植官方修复。web server 增加可选 gzip：`compression: 'none'|'gzip'`（默认 none）、`compressionLevel` 0–9（默认 1）、`compressionThresholdBytes`（默认 1024；未知长度流仍可压缩），经 `negotiator` 在 gzip 与 identity 间按 q 值协商（两种结果都带 `vary: Accept-Encoding`），排除已编码体、`no-transform`、206 content-range、SSE 与无 socket 合成响应；发布 web 组合按上游同款启用 gzip/级别 1/阈值 1024。Typert Remote 标记从模块 `WeakMap` 移到带版本号、冻结、不可枚举的原型描述符（`@deepseek-ai/dsh-typert-protocol/remote-methods` v1），任何已装副本可读，畸形描述符以 `TypeError` 拒绝；下游 `requiredCapability` 扩展原样随行。workspace 包现在在 `realpath` 收养之前拒绝一切非限定路径（POSIX 绝对，或 win32 上真实盘符/UNC 根——`C:` 与 `\work` 仍算相对），默认标题取路径末段、根则取根本身拼写；客户端拼接按 cwd 自身风格选分隔符且仅当 cwd 实含反斜杠。`read_image` 对无扩展名路径嗅探 PNG/JPEG/GIF/WebP 签名，部署媒体类型检查推迟到读字节之后，解码失败有专属文案；未读变更诊断统一为官方单一措辞并链原始错误为 cause。两个非缺陷项按官方回归场景移植为测试以钉住既有守卫，不改代码。

## 考虑过的替代方案

**跟随上游新建 `dsh-util-values` 包承载共享原语。** 否决：这些原语在我方的对应物均已是纯函数、无模块级可变状态，重新打包是无安全收益的折腾；真正有跨副本风险的只有协议描述符修复，它落在协议包内。

**在每个路由或回退席位压缩而非单一中间件。** 否决：逐路由 opt-in 会漏掉后续新增路由，也无法统一应用 negotiator 的 identity-vs-gzip 决策；socket 侧单一中间件边界是官方接缝，路由与错误处理不动。

**以显式基目录解析来收养相对 workspace 路径。** 与官方一致否决：从任何基收养都会在进程换处启动时悄悄搬迁 workspace；在 `realpath` 边界拒绝非限定路径保持唯一性规范完备。

## 结果

部署可以启用 gzip 大幅降低线上传输成本；重复安装的协议副本可互操作；workspace 创建不再捕获 Host-cwd 或盘符相对目录；盘符根得到真实标题；混合分隔符的 Windows 拼接不再到达客户端；模型可以读取无扩展名图片，每个策略违规看到一条稳定诊断。向后兼容：gzip 按组合 opt-in（发布 web bundle 选择启用），既有监听器保持 identity 编码；更严的 workspace 拒绝只影响此前产出错误 workspace 的路径。证据：gzip 组合、原型描述符、路径限定（含复现的 `create('.')` cwd 收养）、分隔符拼接、诊断归一、嗅探的 RED 先行回归在修复前失败、修复后通过；两个非缺陷以对现有代码直接通过的测试钉住。聚焦套件：webserver 8、compaction+session 543、typert/workspace/client/fs 闭包 2037+352 测试绿；`doc-sync` 29/29、`typecheck`、`oxlint`、`knip` 全净；每个触碰源文件 per-file 覆盖 100%。
