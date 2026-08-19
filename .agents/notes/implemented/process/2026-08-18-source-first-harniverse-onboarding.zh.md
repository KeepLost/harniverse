# Agent Note: Harniverse 源码优先的首次使用流程

Status: implemented

[English](2026-08-18-source-first-harniverse-onboarding.md) | 中文

## 问题

仓库根目录把当前 checkout 介绍成 DeepSeek Harness 官方产品，并把安装上游包的 npm 命令作为首要入口。Harniverse 读者因此可能运行另一个发行物、克隆另一个仓库，或者只让 Web 服务器成功监听，却不知道第一台浏览器仍需取得 owner Grant（授权）并配置模型，才能真正完成任务。

## 决策

根 README 将 Harniverse 明确为源码优先的 DeepSeek Harness 下游项目，并负责提供一条从前置条件直到首条 assistant 回复的可执行路径。该路径检查 Git、Node.js 与 pnpm，克隆 `KeepLost/harniverse`，安装并构建 checkout，启动 `pnpm dsh web`，从使用同一 `DSH_HOME` 的第二个终端批准第一台浏览器，配置并选择模型，选择工作区，再发送一条验证提示词。

README 明确区分当前 checkout 中的 `pnpm dsh` 与解析到官方 npm 包的 `npx @deepseek-ai/dsh`。它把终端打印 Web 地址视为中间状态，而不是首次使用成功：新的 home 没有已批准浏览器、已配置模型路由或已选工作区。预期现象与聚焦的排错说明紧邻所服务的步骤。

发布的 Web 指南负责更完整的注册与远程服务说明；模型指南负责特定提供方的凭据、端点与模态配置。根 README 对首次使用保持自包含，但通过链接把进阶情况交给这些下级文档，而不复制其内容。包与 capability（能力）清单仍位于各自的权威参考中，[PLUGINS.md](../../../../PLUGINS.md) 负责下游基线与组合记录。

容器首次使用由仓库提供 `pnpm run web:container` 路径。它会在 `$DSH_HOME/tls` 下持久化开发 CA 与服务器证书，在镜像允许时把 CA 安装进 Linux 容器系统信任库，提供非回环 HTTPS 参数，并保留正常的认证与 owner 注册流程。`DSH_WEB_TLS_HOSTS` 同时提供证书 SAN 与 Host 信任，可覆盖 Tailscale IP 或 MagicDNS 名称等浏览器 authority。明确配置的跨 Origin UI 可通过 `DSH_WEB_TRUSTED_ORIGINS` 或 `--trusted-origin` 加入；Host 信任仍是必需条件。Enrollment 接受人类可读的 Unicode 设备名称；预期的输入错误与名称冲突会作为可处理响应送达浏览器，意外的 registry 故障则保持为 500 响应，并在服务器日志中记录原因。Web 组合挂载 Cordis 控制台 exporter 来显示运行时 warning、信任拒绝以及连接／认证通过或拒绝事件。日志包含非机密的 peer、Host、Origin、path／channel 与 Grant 身份，不包含凭据或请求体；最小化的准入结果仍保留在 `$DSH_HOME/auth/access.jsonl`。容器外的浏览器信任仍属于宿主机边界；当宿主机能够访问已挂载的 home 时，`pnpm run web:container:trust` 会通过宿主系统信任工具安装生成的 CA，部署也可以改由受信任的反向代理终止 TLS。

中英文 README 使用相同技术结构。Harniverse 支持链接指向 Harniverse 仓库，架构入口以及文档站标题、仓库链接和编辑链接也明确标识下游项目。上游 DeepSeek Harness、继承包名、Cordis 与许可证链接仍明确表示归属，不会被重新标成下游资源。

本决策取代已归档的[产品优先根 README](../../archived/process/2026-07-22-product-first-root-readme.md)结构。其长期约束在这里继续保留：根目录仍是产品入口而不是包目录，完整清单留在其他权威文档，两种语言保持结构对齐，并且页面不使用容易与可执行命令分别漂移的截图或第二套营销叙事。

## 考虑过的替代方案

**保留上游 README 形态，只修改名称和 URL。** 这样能缩小 diff，但流程仍会停在服务器启动，遗漏决定 Harniverse 能否回答请求的 owner 注册、模型与工作区前置条件。

**只在文档网站提供完整首次使用流程。** 单一教程属主能够减少重复，但仓库访客首先看到根 README。如果在披露 npm 命令会安装另一个产品之前，还要求读者继续跳转页面，这不是安全的入口路径。

**先发布一键式 Harniverse 包，再修改文档。** 专用包能够简化安装，但当前没有下游包名、release tag、兼容策略或发布渠道。文档不能声称尚未交付的发行物已经存在。

**替换所有上游 DeepSeek Harness 名称和链接。** 这样会抹去有意保留的来源信息，并错误描述继承的包身份。只有用途是获取、支持或编辑 Harniverse 的链接才转向下游仓库。

## 结果

新读者可以逐步验证安装、服务器启动、设备准入、模型就绪、工作区就绪和首次成功推理，并区分这些状态。根 README 会变长，也会与 Web 指南重复最低限度的首次使用顺序；但两份文档各自服务不同入口，并把进阶细节链接到单一属主。

在 Harniverse 发布独立发行物前，源码设置必然比 `npx` 成本更高：用户需要保留 checkout，并在更新后重新构建。未来只有在真实包或产物存在时，发布工作才能替换该路径，并且必须同时更新双语 README、Web 指南与分发元数据。
