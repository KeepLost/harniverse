# Agent Note: VM 世界资产——仅本地构建,不做 release 分发

Status: implemented

[English](2026-11-14-vm-assets-local-build-only.md) | 中文

日期:2026-11-14。范围:`packages/vm/vm-qemu-local`(`src/assets.ts`、删除的 `src/release.ts`、`src/index.ts`、`assets/build-rootfs.sh`、`package.json`、双语 README)、`packages/boot/app-boot`(`applyExecWorldBootEnv`)、以 `.github/workflows/vm-assets-build.yml` 替换 `vm-assets-release.yml`、`scripts/plugin-entry-existing-exports.ts`。2026-11-14 owner 指令,起因是未经授权发布的 `vm-assets-v1` release。

## 问题

资产分发路径把预编译引导二进制(内核、initramfs、宿主 wrapper)发布到一个用 owner 凭证创建、且未经授权的 GitHub release,`ensureAssets` 又在运行时下载它们——使该 release 成为产品的承重依赖。owner 指令:沙箱资产不做 release 分发;仅本地源码构建;沙箱永远不是启动应用的硬性要求——没有 Rust 工具链意味着没有沙箱,而不是应用不可用;只有工具链存在且用户要求时才构建;未变更的构建跨版本复用;CI 继续测试构建但绝不发布。

## 决策

- **`ensureAssets` 成为纯本地检查**,三种结果:`present`(两个引导资产都在且源码摘要标记匹配)、`stale`(资产在,但标记缺失或与当前源码不一致)、`unavailable`(从未构建)——后两者都携带构建命令作为补救。release 钉死、清单信任链、fetcher、`$DSH_VM_ASSETS_URL` 镜像覆盖全部移除;什么都不下载。
- **复用标记。** `assets/build-rootfs.sh` 写入 `assets-source.sha256`——对构建脚本、guest 清单、guest 源码的排序逐文件摘要再取一次 SHA-256——`computeAssetsSourceDigest` 在 TypeScript 侧镜像同一管线。源码未变则跨包版本复用上次构建;源码一变即报 `stale`,等用户重建。
- **构建是用户的显式动作:** `pnpm --filter @deepseek-ai/dsh-vm-qemu-local assets:build`(需要带 `x86_64-unknown-linux-musl` target 的 Rust 工具链)。启动路径永不构建。
- **启动诚实降级。** 存储了 `vm` 偏好但资产缺失或过期的主机,以一行提示(含原因与补救)降级到 `local` 家族;应用始终能启动。
- **CI 只验证、不发布。** `vm-assets-release.yml`(手动触发加发布道)被 `vm-assets-build.yml` 取代:VM 包路径变更触发的 pull_request 道,构建资产、用同一管线复核标记、仅上传短期 artifact。
- **既有 `vm-assets-v1` release 与 tag 按 owner 指示保留**;URL 钉死移除后它们不再被任何代码引用。

## 备选方案

**在显式环境变量后面保留下载。** 否决:owner 退役的正是分发本身;镜像路径会让产品继续在运行时取二进制。

**检测到工具链就在启动时自动构建。** 否决:owner 把构建定为用户显式动作;启动路径也不该背上分钟级的工具链工作。

**摘要构建产物而非源码。** 否决:产物字节随工具链漂移,破坏跨版本复用;源码才是 owner 点名的变更信号。

**用一个生成脚本独占标记计算。** 否决:bash 与 TypeScript 各自需要原生管线;两侧文档化并镜像同一条管线,在活树上交叉验证字节一致。

## 后果

插件入口面缩小五个值导出(`ASSETS_MANIFEST_NAME`、`ASSETS_MANIFEST_SHA256`、`ASSETS_RELEASE_BASE_URL`、`ASSETS_URL_ENV`、`parseAssetsManifest`);债务基线 830→825。携带无标记资产的主机先答一次 `stale` 再重建。镜像部署改为本地构建或自备资产。workflow 道改名,其(零运行的)历史不延续。

## 测试

`tests/assets.spec.ts` 重写:摘要稳定性、源码敏感性、嵌套源码覆盖、present/unavailable/stale 矩阵、默认解析走真实包源码。`app-boot` 的 `exec-world-boot-env.spec.ts`:present 后复探组合 `vm`,unavailable 与 stale 各自带提示降级,默认缝测试接受宿主相关结果。两包套件全绿(523 测)。bash 与 TypeScript 摘要管线在活树上验证字节一致(`c7891a16…`)。`verify-plugin-entry-exports` 825 绿;md-wrap、doc 预算、README 门禁、1335 对翻译配对全绿。

## 相关

被退役机制的文档见 `2026-11-13-vm-asset-release-distribution.md`(留作发布过什么、为何替换的诚实记录)。未经授权的发布本身、owner 的处置与新立的规矩——release、tag、动用凭证的发布操作仅在 owner 明确指令下进行——属于工作区记录,不属于本笔记。
