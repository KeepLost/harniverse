# Agent Note: 终端与浏览器面板作为贡献区段搬进了 Workspace 工作台

Status: implemented

[English](2026-09-23-workbench-section-panels.md) | 中文

## Problem

终端与浏览器面板此前是由侧栏底部触发器打开的 center 视图：两个本属于会话的面板盖在对话之上占据整个中心栏，入口却安在侧栏底部设置旁边——这让 coding agent 的 shell 用起来像浏览器的外壳功能。Harniverse 是 coding agent，不是套壳浏览器或终端；面板是绑定会话的工具，产品决定是把两者移入会话的 Workspace 工作台，作为与文件/变更/搜索并列的页签，同时保留会话绑定与各面板内部的多标签条（页面、终端）。

## Decision

ui-layout 声明两个列表槽 `workbench.section.tab` 与 `workbench.section.panel`（属主份额：`current`、`select`、`request`），与 `center.view` 的声明方式一致——外壳拥有组合点，workbench 条目把它们声明为 children，选中区段记录在 layout store 中，`ctx.layout.openWorkbenchSection(section, request?)` 是一步完成打开与选择的入口，markdown 链接路由现在调用的正是它。ui-browser 与 ui-terminal 各注册一个标签与一个主体；主体仅在其区段显示时挂载（包装组件否则返回 null，面板生命周期——页面画面、输入附件、xterm 挂载——完全随区段激活，与此前随 center 视图占用一致）。选择状态从工作台按 Workspace 的记账移入 layout store，这同时让 `ILayout` 成为程序化打开的唯一通路；按 Workspace 的区段记忆取消，区段页签为全局共享。随之而来三处可达性修复：工作台无论是否解析出 Workspace 都渲染区段（文件/变更/搜索的主体与标签仍需要），blank 会话在工作台与 AppFrame 右栏闸门两处都能解析出自己的 Workspace，以及 blank 会话页头隐藏期间由输入区 dock 胶囊保住工作台入口。键盘漫游从逐按钮处理器移到 tablist 容器，方向键因此覆盖贡献标签；侧栏底部触发器、其组件、视图 store 与相关导出全部删除；调度器保留自己的 center 视图与底部触发器。

## Alternatives considered

保留 center 视图而只把触发器移入工作台被否：面板仍会盖住对话，而这正是本次决定要移除的位置。把区段槽声明在 ui-workspace（工作台属主）造成了真实的项目引用环（ui-conversation 需要该槽做链接路由，而 ui-workspace 已依赖 ui-conversation 的会话槽），何况 `center.view` 的先例——外壳声明的组合点——本就是更合适的家。按 Workspace 持久化选中区段（旧 store 字段的做法）被否，改为 layout store 的单一事实源；markdown 链接的请求与 `centerViewRequest` 一样原样搭在同一 store 里。

## Consequences

两个面板成为工作台区段：标签与文件/变更/搜索并列，主体渲染在工作台 tabpanel 内（多页面/多终端标签条原样保留），blank 会话与无 Workspace 会话同样可达。侧栏底部只剩调度器触发器与设置。markdown 链接经 `openWorkbenchSection` 打开浏览器区段，区段缺席或偏好为 `device` 时与此前完全一致地落回读者本机浏览器。生命周期 golden 记录了新页签与 blank 会话胶囊，也记录了底部触发器的移除。调度器的 center 视图缝隙未动。

## Testing

`pnpm run test:gui`（5259 个通过，一个跳过）；ui-layout、ui-workspace、ui-browser、ui-terminal 的 per-file 覆盖门；`pnpm run typecheck`；终端、浏览器、markdown 链接、lifecycle-chrome 与 workspace-workbench 定向场景通过。PR #144 CI 的两组 Web E2E 与覆盖率任务均通过。本地 `smoke-real` 传输重试用例在准备阶段超时，原因尚未查明，此前的对照没有重新构建基线产物。
