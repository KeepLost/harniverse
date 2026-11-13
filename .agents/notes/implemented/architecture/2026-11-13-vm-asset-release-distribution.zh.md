# Agent Note:VM 资产发布分发——钉住的 GitHub Release 实现开箱即用的引导资产

Status: implemented

[English](2026-11-13-vm-asset-release-distribution.md) | 中文

Date:2026-11-13。范围:`packages/vm/vm-qemu-local`(新增 `src/release.ts`、`src/assets.ts`)、app boot 桥(`packages/boot/app-boot` 的 `applyExecWorldBootEnv`)、新增 `VM Assets Release` 工作流。`ctx.vm` 缝、provider、构建脚本不动。

## Problem

世界资产(内核、initramfs、宿主包装器)一直 built-not-vendored 且没有分发故事:在缺少 Rust musl 工具链与锁定下载的宿主上,把 `exec-world.world` 切到 `vm` 的部署只会冷降级回 `local`——真沙箱在开发者检出之外不可达(路线图记录的"资产发布故事是未来工作")。

## Decision

**载体:每代资产一个 GitHub Release,外加两段摘要链。** Release(`vm-assets-v*`)承载三个构建产物和一份 `sha256sum -c` 格式的 `assets-manifest.sha256`。源码钉住清单的 SHA-256(`src/release.ts` 的 `ASSETS_MANIFEST_SHA256`);清单钉住每个文件的摘要。自定义 `$DSH_VM_ASSETS_URL` 镜像必须逐字节一致地提供文件,因为钉住的清单摘要仍然生效;留空该值则禁用下载(离线姿态)。v1 由 e2e 套件运行过的同一份本地构建发布(`vm-assets-v1`,清单 `d33d9905…`);`VM Assets Release` 工作流从同样的摘要锁定输入重建后续代际(构建演练与发布以相同方式产出清单;打印出的摘要即重新钉定时提交的内容)。

**`dsh-vm-qemu-local` 的 `ensureAssets(options)`。** 内核+initramfs 已存在则直接通过、零网络;否则拉取清单、对钉校验,把清单中缺失或摘要不符的每个文件下载到 `.partial` 暂存名、校验后原子改名。一切失败——网络、清单不符、文件不符、清单畸形、缺少引导条目——都以 `{ status: 'unavailable', reason }` 上报而非抛出,调用方因此能诚实降级;`probeWorld` 保持纯同步探测。

**boot 桥消费。** `applyExecWorldBootEnv` 改为异步:存储的 `vm` 偏好在探测到"QEMU 二进制可用但资产未就绪"时,先 await `ensureAssets` 再探测一次——物化成功则组合 `vm`,`unavailable` 则带原因降级 `local`。QEMU 二进制缺失绝不触发下载(无意义流量),显式 env 覆盖路径保持与之前完全一致的免探测免下载。

## Alternatives considered

- **把资产 vendoring 进仓库**——每代 15 MiB 二进制对着摘要锁定的配方;否决。
- **首次启动时构建**——要求每个部署宿主具备 musl/Rust 工具链与网络;最差的首次体验。否决,改为下载即校验。
- **只按工作流记录的摘要校验下载**——断了链:工作流输出不是源码状态;钉必须活在树里才可评审。

## Consequences

- 网络可达、有 QEMU、资产未就绪的宿主上,`vm` 偏好现在引导真世界而非降级——开箱即用的使能缺口闭合。
- 每个部署只信任一个新的工件来源:经钉住清单摘要抵达的钉住 Release;轮换代际是一次同时提升两个常量的提交。
- 桥的异步化使 `applyExecWorldBootEnv` 可 await;`boot()` 本就是异步。原先同步调用的调用方(测试)改为 await。
- 默认拉取器带每请求 10 分钟超时;网络停滞以带原因的 `local` 降级收场,而不是把 boot 永远挂起。

## Testing

- 单测(`vm-qemu-local/tests/assets.spec.ts`,14 例):清单解析(空行、畸形、路径穿越拒绝);present 短路零网络;经清单链的下载含暂存清理;清单拉取后陈旧文件的重下载;env URL 覆盖与留空禁用;钉摘要拒绝;单文件摘要拒绝且不留 partial;清单缺引导条目;拉取失败与清单畸形的包装;默认拉取器对活体本地 HTTP 服务(成功路径与 HTTP 404)。
- 单测(`app-boot/tests/exec-world-boot-env.spec.ts`,13 例):物化四腿(downloaded→vm、unavailable→带原因降级、无 QEMU→不尝试下载、downloaded 但复探不健康→通用降级),外加不变的历史腿。
- 端到端(本机):已发布的 `vm-assets-v1` 经 `ensureAssets` 拉入冷目录;三个文件摘要与 Release 清单逐字节一致。

## Related

工作区导入的产品决策(boot 时宿主工作区暂存)是下一个使能项,单独落地;`applyExecWorldBootEnv` 的锚点(`$DSH_VM_HOST_WORKSPACE_ROOT`)已由 M9 就位。
