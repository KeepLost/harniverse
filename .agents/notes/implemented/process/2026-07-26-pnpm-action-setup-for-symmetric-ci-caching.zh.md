# Agent Note: 经由 pnpm/action-setup 提供 CI 的 pnpm

Status: implemented

[English](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md) | 中文

## 问题

除 `landlock-run.yml` 外，每个安装 pnpm 的工作流都曾用 `corepack enable` 手工提供 pnpm，其中五个还各自重复着一套手写（hand-rolled）的缓存设置——`pnpm store path --silent >> $GITHUB_OUTPUT`、再加上以 `pnpm-lock.yaml` 为缓存键的 `actions/cache@v4`：`e2e.yml`、`docs-pages.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 node-compat、serial-linux 与 benchmark 作业。与之等价、由官方维护的做法——`pnpm/action-setup@v4`（从 package.json 读取 `packageManager`）加带 `cache: pnpm` 的 `actions/setup-node`——当时已在仓库内的 `landlock-run.yml` 中得到验证，而 corepack 被从较新 Node 发行版中移除，使每一处 `corepack enable` 都成了已知的未来失效点。

## 决策

`pnpm/action-setup@v5` 是 CI 中提供 pnpm 的唯一机制：没有任何工作流运行 `corepack enable`。JavaScript 工作流基础设施统一采用 Node 24 action 世代（`actions/checkout@v7`、`actions/setup-node@v7`、`actions/cache@v6` 与 `actions/upload-artifact@v7`）。根目录的 `@yarnpkg/cli-dist` 开发依赖另行提供 generated-project e2e 所运行的现代 Yarn CLI（命令行界面）；因此，用于包管理器覆盖率的 Yarn 不会沿用 runner 镜像里的 Yarn Classic。缓存仍是叠加在 pnpm 提供机制上的按作业策略，保留三种有意采用的形态：

- **内建对称缓存**（既恢复也保存）：带 `cache: pnpm` 的 `actions/setup-node@v7`——`e2e.yml`、`pi-ai-provider-e2e.yml`、`build-exe-for-python-sdk.yml`，以及 `ci.yml` 的 Node 兼容作业。
- **带前缀回退的对称缓存**（手写的 `actions/cache@v6` 步骤）：三个主要 Linux 作业和基于 Wine 的必需 Windows 作业会在 action 可替换安装目录之外配置 store，按锁文件精确键或同平台最新前缀恢复，并在未命中后保存当前合并引用的键。
- **无缓存**（不使用 store 缓存 action）：独立的原生 Windows 作业与 `sandbox.yml` 从冷的 runner 本地 store 安装。解压含有大量文件的 pnpm store 归档比 Windows 全新安装更慢，而 Sandbox 运行频率也不足以证明传输 store 的成本合理。

## 曾考虑的替代方案

- **保留手写步骤。** 它们能用，但那是会各自漂移的设置样板副本，而且对 corepack 的依赖是已知的未来失效点。
- **把所有作业都转换成 `cache: pnpm`。** 否决，因为主要作业需要在锁文件变化时使用 `restore-keys` 前缀回退，而 setup-node 的内建缓存不暴露这一能力。
- **只转换带缓存的工作流，留下其余出现 `corepack enable` 的位置。** 否决：提供 pnpm 与缓存是可分离的关注点，在无缓存作业里留下 corepack 只会保留未来失效点和两套并存的提供方式，毫无收益。
- **依赖 runner 镜像自带的 Yarn。** 否决：Corepack 移除后，托管镜像提供的是 Yarn 1.22，而 generated-project e2e 要求 Yarn 2 或更高版本。锁定版本的根开发依赖让该项覆盖率不再受 runner 镜像内容影响。
- **用一个组合 action 包装 action-setup + setup-node。** 暂不采纳：剩余的按作业差异（Node 版本矩阵、带前缀回退的缓存与无缓存原生作业）是刻意采用的策略而非样板——包装层要么不得不增加与这些差异一一对应的输入，要么抹平真实区别，而两行组合已接近下限。

## 后果

- corepack 依赖已从 CI 中彻底消失；pnpm 在所有工作流中都经由 pnpm 团队的官方 action 提供，版本锁定继续单一来源于 `package.json` 的 `packageManager` 字段。
- generated-project e2e 运行根目录锁定的 Yarn 4 CLI，既不再沿用 runner 镜像中的 Yarn 版本，也不会因此悄然跳过。
- 已转换泳道的缓存键格式变更了一次；各跑一次冷运行重建缓存后，命中率与旧步骤持平。内建缓存键涵盖平台、架构与锁文件哈希，但不含 Node 版本，因此 node-compat 的各个矩阵任务共享同一条 store 缓存记录——这是安全的，因为 pnpm store 与 Node 版本无关。
- `setup-node` 内建的 pnpm 缓存只按精确键恢复，没有 `restore-keys` 前缀回退：`pnpm-lock.yaml` 一旦变更，已转换泳道会从冷 store 起步，而不是利用上一条缓存记录预填充。
- `pnpm/action-setup` 每次运行都会删除其安装目录，并把默认 store 放在由此产生的 `PNPM_HOME` 下。因此，使用显式缓存 action 的作业会把 `PNPM_CONFIG_STORE_DIR` 设在 action 目录之外，并在恢复或保存前解析这一稳定路径。
- Node 24 action 世代要求 Actions Runner 不低于 2.327.1。必需 CI 使用 GitHub 托管 runner；任何自托管备用 runner 必须达到该版本下限后才能启用。
