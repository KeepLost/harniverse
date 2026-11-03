# Agent Note: 设置页暴露 Windows Shell 后端偏好

Status: implemented

[English](2026-11-03-settings-shell-backend-section.md) | 中文

## Problem

`shell-backend` 设置命名空间（`@deepseek-ai/dsh-shell-backend-settings`，重启生效）决定模型 shell 工具在 Windows 上用 PowerShell 还是 Git Bash，但持久入口只有手改 `$DSH_HOME/settings.yaml` 或 `DSH_SHELL_BACKEND` 逃生口。设置弹窗没有对应分节，不读包 README 的用户看不到这个能力。

## Decision

交付一个标准的"一命名空间一分节"插件包，与网络代理分节同形同粒度：分节经绑定的 settings scope 只编辑单个 `backend` 字段，文案说明重启生效，Windows-only 的事实以文案呈现。不做实时切换、不做可用性探测——组合在下次启动时重新解析；缺 Git for Windows 会在那时通过 bash 工具暴露，而不是在这个表单里。

## Alternatives considered

- **塞进 `ui-settings-general`：** 通用页聚合的是随时相关的进程偏好；这是 Windows-only、重启生效的组合选择，与实时生效的行放在一起很突兀，而且每个拥有独立命名空间的分节先例都已各自成包。
- **在分节里展示已解析的 `$DSH_SHELL_BACKEND`（活动后端）：** 运行中进程的 shell 家族今天无法通过设置命名空间观测，为展示而发布它会新增一个宿主能力；分节拥有的是存储的偏好。
- **保存前探测 Git Bash 可用性：** 从设置表单探测宿主 PATH 上的 `bash` 会把写入耦合到命名空间从不校验的宿主状态；诚实的上限（缺 Git 在下次启动暴露）记录在 README 里。

## Consequences

- `@deepseek-ai/dsh-client-ui-settings-shell-backend` 贡献 `settings.section` 条目 `shell-backend`（order 14，网络代理之后、插件之前——组合级偏好），承载 PowerShell / Git Bash 单选对；node 半边是 surface no-op。
- 三个必需注册面（tsconfig client 聚合、web-app bundle 行、bundle 依赖）已接通，生成面（`docs/config-catalog.md` bundle 清单、cordis-client-runner 槽目录）已再生成。
- 真实组合证据在 `settings-chrome.e2e.ts`：写入 Git Bash、断言 `settings.yaml` 含 `shell-backend: { backend: git-bash }`、重载确认存储偏好为活动草稿、恢复平台默认。嵌有设置导航的十三个 web 金牌各增加且仅增加一行新导航（refresh 后 replay 验证）。
- 包套件：27 测试，逐文件 100% 覆盖；`pnpm run test:gui` 绿（544 文件）。`hmr-live` 与 `plugin-bootstrap-performance` 在本容器上有无改动均失败（dev:web 冷构建超 60 秒门；bootstrap 基线即 ~5.2–5.6 s 对 5 s 预算）——既有环境上限，由 CI runner 裁决。
