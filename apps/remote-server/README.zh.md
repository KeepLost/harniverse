# @deepseek-ai/dsh-remote-server

[English](README.md) | 中文

本参考说明已安装的远程服务器应用及其原生目录产物。应用通过 [`app-boot`](../../packages/boot/app-boot/README.md) 按自身清单组合 base、web-app 和远程层。它获取与 CLI 相同的 Harness 主目录独占租约，修复已安装依赖的解析入口，并在该主目录下创建私有临时配置来启动。释放时先停止插件树，再删除临时配置并释放所有权。

## 运行时

启动时将 `DSH_HOME` 指向远端专用状态目录。可执行入口仅接受 `--port 0` 和 `--help`，并向现有 Web 启动插件传递 `--port 0`。远程层固定使用 `authenticated` 认证和 `127.0.0.1:0` 监听地址。进程脱离终端及服务生命周期由监督程序或 SSH 协调器负责。

该层禁用本地凭据、harness-source、自动目录选择器和客户端 HMR，并插入加密凭据、浏览式目录选择器与 [`remote-runtime`](../../packages/ssh/remote-runtime/README.md)。Web 界面上下文被禁用。AgentLoop 额外等待 `remoteRuntime`，因此其工厂无法在锁定准入策略安装前变为可用。应用不加载自动发现的 `.env` 文件，而是使用继承的启动环境快照和现有 HTTP 代理安装器。

对 `@deepseek-ai/dsh` 的依赖保留其构建后的 CLI、完整的 `config/agent-presets` 文件树及这些预设需要的插件依赖。应用将 `agent-presets` 指向该安装目录，不导入 CLI 源码或未公开的 `profile-boot` 导出。启动后通过 `DSH_HOME/server/endpoint.json` 发现实际端点；其格式与控制接口由运行时参考定义。

## 产物与构建命令

安装锁定的工作区依赖后，在目标操作系统和架构上运行构建器。Linux、macOS、Windows 分别需要原生宿主机。指定的 Node 二进制必须与构建进程的平台、架构及原生扩展 ABI 一致，默认使用 `process.execPath`。

```sh
node_modules/.bin/tsx scripts/build-remote-server.ts \
  --pnpm /absolute/path/to/installed/pnpm/bin/pnpm.cjs \
  --output /absolute/path/to/new/remote-server-directory
```

默认流程执行仓库构建、编译应用项目并运行其包级 tsdown 配置。`--skip-build` 要求已有产物，包括生成的 Typert 契约、Web 前端和客户端插件包。`--node /absolute/path/to/node` 可指定现有且兼容的二进制。构建器不安装 pnpm、不调用 `pnpm exec`、不覆盖已有输出，也不修改工作区锁文件。

部署使用现代 `pnpm deploy --prod --offline`，仅在一次性工作区副本中启用依赖注入模式。它使用共享锁文件和已安装工作区的存储。清单必须已经与锁文件一致；协调器尚未完成集成时，部署前即失败。临时输入包含包清单和所选包的构建资源，排除源码、测试、`.env` 文件和工作区已安装链接。不使用旧版 deploy，因为它可能脱离共享锁文件重新解析依赖版本范围。

输出目录包含：

- Linux/macOS 上的 `node` 或 Windows 上的 `node.exe`；
- `app/lib/bin.js`、应用清单、远程补丁及部署后的生产 `node_modules` 依赖闭包；
- 闭包中的构建后 CLI、随附 Agent Presets、Web 前端、插件产物与宿主机原生扩展；
- `manifest.json`，记录应用版本、Node 版本和 ABI、启动参数以及每个负载文件的 SHA-256；
- `manifest.sha256`，记录清单自身的 SHA-256。

构建器逐文件比较随附预设与源产物，检查前端和生成的 Remote 产物，用复制的 Node 加载运行时、认证及原生扩展包，并运行构建后应用的 `--help`。产物链接必须可迁移且不离开输出目录。目录即部署单元；归档传输和服务注册由协调器负责。

从产物根目录启动：

```sh
DSH_HOME=/absolute/remote/state ./node app/lib/bin.js --port 0
```

Windows 上在服务环境中设置 `DSH_HOME`，以产物根目录为工作目录，使用参数 `node.exe`、`app/lib/bin.js`、`--port`、`0`。目标机器不需要全局 Node 或 pnpm。

## 公钥授权引导

部署后的应用直接依赖 `@deepseek-ai/dsh-authentication-local`。协调器可在 `artifact/app` 工作目录中启动复制的 Node，传入 `--input-type=module`、`-e` 和下列代码，并通过 stdin 写入授权输入 JSON：

```js
import { createAuthenticationClientGrant } from '@deepseek-ai/dsh-authentication-local'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const grant = await createAuthenticationClientGrant(JSON.parse(input), { dshHome: process.env.DSH_HOME })
process.stdout.write(JSON.stringify(grant) + '\n')
```

输入为 `{ name, publicKey, capabilities, expiresInMs? }`。`publicKey` 是经 base64url 编码的 P-256 SPKI DER 公钥。首次所有者引导必须包含 `harniverse.authorize`；运行时控制还需要 `harniverse.administer`，状态读取需要 `harniverse.observe`。现有辅助函数负责验证与审计。协调器将签名私钥保留在本地；辅助函数和运行时都不接受该私钥。无需专用的可执行入口认证模式。

## 验证与集成

```sh
node_modules/.bin/vitest run --config apps/remote-server/vitest.config.ts
DSH_REMOTE_ARTIFACT=/absolute/artifact node_modules/.bin/vitest run \
  --config apps/remote-server/vitest.config.ts apps/remote-server/tests/built-smoke.spec.ts
```

产物冒烟测试使用复制的普通 Node 启动实际应用，检查锁定准入，以临时测试材料解锁，关闭 HTTP 连接，释放插件树并再次以锁定状态启动。测试创建独立主目录，在子进程退出后删除。未设置 `DSH_REMOTE_ARTIFACT` 时，该测试明确跳过。

协调器负责工作区锁文件、新项目的 Host 聚合注册、SSH 包与应用的源码别名，以及常规仓库文档和目录注册。如需聚合构建直接构建本应用，根 tsdown 需包含应用；部署构建器也会显式构建包级配置。共享 bundle 不需要启动器特例。包级测试和 README 保持在 remote-runtime、应用及构建脚本范围内。

## 模型体验

应用选择已有 base/Web 插件和随附 Agent Presets，不新增模型可见内容。远程准入和设置行为由运行时插件负责。

#### KV 缓存影响

除所选现有插件及模型设置外，没有直接影响。

## 已知限制与延后工作

- 原生平台验证需要对应的 Linux、macOS 或 Windows 宿主机；构建器不交叉编译。
- 完整发布需要协调器完成锁文件与聚合集成，并准备好离线 pnpm 存储。缺少编译产物或原生扩展时构建会失败。
- 转发请求的重连等待与远程进程监督由协调器负责，不属于本应用。
