# Agent Note: Harniverse client build profile and artifact binding

Status: implemented

[English](2026-08-23-harniverse-client-build-profile.md) | 中文

## Problem

Harniverse 通过两条互不包含的路径产出浏览器产物：Vite 把认证 Web 壳构建到 `apps/web/dist`，共享 tsdown preset 把每个动态加载的 client 插件构建到 `packages/*/*/lib/client.js`。只在一条路径替换构建期值，会使相同业务表达式因所在包不同而产生不同结果，而浏览器没有可在运行时读取的 Node `process`。

release 打包此前直接消费磁盘上恰好存在的浏览器文件。默认构建后请求 release 打包、局部重建插件或修改 bundle，都会产出可发布 tarball，却没有任何证据表明其中的浏览器文件来自同一次完整构建、同一个声明的产品身份。Harniverse 还需要与官方 DeepSeek Harness 区分的发行身份，而继承的占位标题无法提供这一点。

## Decision

`DSH_CLIENT_*` 是允许嵌入浏览器产物的构建期命名空间。业务代码读取静态属性，例如 `process.env.DSH_CLIENT_TITLE`；已设置的值内联为字符串，未设置的名称求值为 `undefined`。该名称本身表示公开性，因此凭据、owner 身份、Grant、capability 和仅供 Host 使用的路径都不得使用它。认证与授权完全由运行时插件决定；build profile 绝不决定谁可以连接、浏览器会话可以做什么。

Vite 配置与共享 tsdown client preset 调用同一个 define 生成器，因此两条产物路径获得完全相同的值。生成器只为 `DSH_CLIENT_*` 生成精确替换，并把其余所有 `process.env` 读取收敛为空对象，浏览器因此没有 `process` 全局、动态键读取和环境枚举能力。

`DSH_BUILD_CLIENT_PROFILE` 是请求具名 profile 的非公开选择器。`harniverse` profile 精确等于 `DSH_CLIENT_BUILD_PROFILE=harniverse`、`DSH_CLIENT_TITLE=Harniverse`，以及携带七位源码 revision 的 `DSH_CLIENT_COMMIT_HASH`。`pnpm run build` 内联调用方自己的公开值，调用方未设置时不使用任何公开值；`pnpm run build:harniverse` 是 CI 与 release 产物构建的跨平台等价命令，会用该 profile 替换继承的公开值，因此开发环境无法泄漏进发行构建。

一次完整根构建写入 `.harniverse-build/client-build-environment.json`，记录精确的公开环境，以及覆盖 Vite 输出和每个动态 client bundle 与 source map 的排序路径和字节的 SHA-256 摘要。`release:pack --family dsh` 要求该记录存在、在当前 revision 上与 Harniverse profile 精确一致且不含额外公开值，并且仍然描述磁盘上的产物。vendored 框架 family 不发布浏览器变体，接受任意构建树。

## Alternatives considered

**只在 Vite 中替换。** 动态插件的 `lib/client.js` 作为独立脚本被拉取，不进入 Vite 模块图，表达式会残留到没有 `process` 的浏览器中。

**公开全部 `DSH_*` 值。** Host、测试和 CI 变量已使用该前缀，其中可能带有凭据或本地路径。更窄的前缀让公开意图可审计。

**把命名空间改名为 `HARNIVERSE_CLIENT_*`。** 该前缀是继承的构建机制而非官方品牌，改名会让下游包为同一目的维护两套互不兼容的 client 构建接口。

**给浏览器提供完整 `process.env` 对象。** 这会允许枚举构建环境，并把兼容垫片变成运行时 API；精确静态替换无需如此即可承载构建选择。

**只对 Web 壳做摘要。** Harniverse 在运行时用动态 client bundle 组合 critical 与 deferred 启动 aggregate，因此仅覆盖壳的摘要会接受被重建或被修改的插件。

**让 release 打包信任工作树。** 版本与 payload 检查无法证明这些浏览器字节由哪个环境产生，而这正是已发布产物不应携带的混淆。

## Consequences

两条产物路径对同一公开值携带相同字符串，未设置的读取得到 `undefined`，非公开值无法通过该机制进入浏览器，业务代码也无法枚举构建环境。Harniverse 构建在初始 HTML 文档、可安装 Web manifest 以及持久 Session 标题旁的浏览器标题中显示 `Harniverse`；普通本地构建显示 `Harniverse Local Build`。CI 在具体的 build gate 内选择 profile，而不是使用 workflow 全局环境，因此源码测试和无关步骤不会观察到公开 client 值。

任何被引用的公开值都会成为可读的产物内容，命名错误即泄露信息。构建选择在产物生成时冻结；需要部署后变化的设置必须使用带校验的运行时配置。该记录把环境绑定到字节和源码 revision，而不是绑定到可信构建者：它既不能证明工作树干净，也不能证明构建可复现或已签名，且可以在修改后的输出上重新写入一份新记录。已发布的侧栏字标与标识在 Harniverse 品牌资产就绪前仍沿用继承的图形。
