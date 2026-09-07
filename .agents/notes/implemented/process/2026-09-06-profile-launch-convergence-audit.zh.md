# Agent Note: Profile-launch 收敛审计——四个剩余差距的裁定

Status: implemented

[English](2026-09-06-profile-launch-convergence-audit.md) | 中文

## 问题

Wave-2 A8 决策把 profile-launch 收敛限定为四个剩余差距：具名 profile 组合选择（替代文件路径形态的 `command`+`args`）、加载时校验、同版本启动器约束、退役旧 SDK 演示示例。实施前，本审计必须确立这些差距如何映射到 Harniverse 的真实启动基础设施——profile 轨道（`$DSH_HOME/profiles/<name>`、bundle patch 层叠、`dsh --profile`）与 SDK 子进程轨道（经显式 `--config` include 树组合的 stdio JSON-RPC runtime bin）。

## 决策

四个差距全部裁定完毕、零代码变更；每条裁定都立于对照源码验证过的结构事实：

- **具名 profile 组合选择——带具体触发条件暂缓。** 两条轨道按设计分离：profile 轨道服务 `dsh` CLI 面（读取 `ctx.cmdlineArgs` 的 web/headless/auth app 插件），且不存在可 profile 组合的 stdio JSON-RPC server 面——`dsh-jsonrpc-agent` 只作为 `dsh-jsonrpc-demo` bin 及其 `--config` include 根存在（`boot(binName, absoluteConfigPath)` 挂载单文件；`loadProfile`+`composeEntries` 是层叠轨道，且 `DSH_PROFILE` 在树中零出现）。桥接二者意味着先发明可 profile 组合的 server 面——这是基础设施缺口而非配置键更名，超出 A8"有界收敛"范围。当前显式形态已携带官方变更想要的性质：组合来源无歧义（显式 bin 加显式配置路径，或显式子环境中的 `DSH_CORDIS_CONFIG`）。重开触发：某 SDK 部署需要多 profile 复用或安装级组合管理——届时先把 server 面 profile 化，再在其上加薄薄的 `Config.profile` 名字。
- **加载时校验——承重字段已有。** `cwd` 在加载时对照启动目录校验一次（`validateConfiguredCwd`），`maxTokens` 与每个超时上限在加载时校验，目录配置错误在任何 spawn 之前失败。`command` 刻意不在加载时解析：它命名 PATH 可执行文件或打包 exe 路径，其有效性是部署的运行时属性，且 spawn 失败诊断已点名 command。承载存在性校验的 profile 字段尚不存在（上一条）。
- **同版本启动器约束——由显式性达成。** 子进程由配置的 `command` spawn，在树内一切组合中该 command 都是同一安装内的路径（`node … packages/examples/jsonrpc-demo/…`）；父进程从不猜测启动器，故不存在隐式版本漂移路径。打包 exe 按构造钉死于自身。
- **演示退役——不适用。** 与上游的 SDK 用法演示不同，`packages/examples/acp-demo` 与 `dsh-jsonrpc-demo` 是活的传输测试基座：ACP snapshot/e2e 套件、`jsonrpc-agent` 冒烟套件、以及 `subagent-acp`/`subagent-dsh-sdk` 组合直接启动这些 bin。删除它们拆掉的是传输测试面而非过时示例；SDK 用法文档已在 `packages/sdk/client`。第三个包 `agent-spine-demo` 是这些 app 组建所依赖的组合脊柱，保留。

此外，A8 目标语句要求的环境拼装唯一性已复核：子进程环境拼装恰好两个出口，都构建于同一 `scrubbedParentEnv()`（其内部叠加 `proxyEnvironmentForChild`）——`dsh-subprocess` seam 的 spawn 路径，与 SDK client spawn 的记载例外（`run.ts` 自行施加 scrub，因为 SDK client 而非 `ctx.subprocess` 拥有 spawn）。父进程自身的出站流量经 profile boot 中唯一的 `installProxyFromEnvironment` 安装点。

## 考虑过的替代方案

**现在就实现 `Config.profile`，作为经 `resolveProfileDir` 解析并向子环境盖 `DSH_PROFILE` 的名字。** 否决：子进程轨道没有可 profile 组合的 server 面，该名字将解析到一个没有 SDK 子进程能从中启动的目录——一个暗示了树无法兑现的保证的配置键。

**退役演示并重建薄 `sdk-app`/`sdk-minimal` 示例。** 否决：此处演示的角色是测试基础设施而非 SDK 教学；替代示例无法恢复传输套件所启动的 snapshot 组合。

## 结果

A8 以收敛主张被磨锐而非配置面被扩增的方式关闭：既有的 `ResolvedChildProfile` 握手（profile id、revision、digest、模型路由、工具集不可变地跨越委托边界）仍是 profile-launch 收敛的实质，四个残余差距记录为已满足、结构性不适用、或带触发条件暂缓。无插件、bundle、组合变更，故无台账行。证据：各要点中的源码引用（`boot` 签名与 `DSH_PROFILE` 零出现、加载时 `validateConfiguredCwd`、`scrubbedParentEnv` 在 `subprocess-local/src/spawn.ts`、`subagent-dsh-sdk/src/run.ts`、`subagent-claude-code/src/{run,process}.ts` 的调用点、`apps/cli/src/profile-boot.ts` 中的 `installProxyFromEnvironment`）；演示的测试依赖引用在 `examples/acp-agent` 与 `examples/jsonrpc-agent` 套件中逐一枚举。
