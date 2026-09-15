# Agent Note：composer 的独立推理强度 seat

Status: implemented

[English](2026-09-14-composer-effort-button.md) | 中文

## 问题

能力声明改动让自定义模型可以公布推理档位与每模型默认档，composer 的模型 seat 也在其两级菜单里获得了下钻的 Effort 分页。但该设计获批时还点名了第二个 composer 控件：模型按钮正右侧的独立推理强度按钮，把切换档位从「打开模型菜单 → Effort 行 → 选档」压缩为一次点击。这一件曾在未经用户批准的情况下被推迟，本改动完整交付；获批设计的其余部分均已落地，无遗留。

## 决策

- **新命名 seat。** `conversation.input.effort` 与 `conversation.input.plan`、`conversation.input.model` 并列，成为 ui-conversation composer bar 声明的会话作用域单实例 seat，渲染在模型 seat 正右侧（上下文计量之前）。列表 slot 无法表达这一点：`conversation.input.right` 的条目渲染在模型 seat 左侧，而需求是按钮贴着模型按钮右侧。契约与兄弟 seat 相同——仅 `locked` 的 owner share，无人认领时不渲染。
- **同一目录上的第三个入口。** ui-model-selection 以与模型 seat 完全相同的 inject face 把 `EffortButton` 注册进该 seat：每会话一个 `ModelDirectory` 实例、一个 `selectModel` 动词。任一表面上的选择就是另一表面下一次显示的内容；目录加载、其重试面与空目录姿态仍由模型 seat 负责，当前模型未声明推理时按钮自行隐藏（无档位的模型不占布局）。已寻址 subagent 会话依旧两个 seat 都不暴露。
- **共享推导。** 生效档位／标签／行集推导移入 `effort.ts` 纯函数，两个组件共用，两个控件不会漂移，跨文件克隆门保持安静。

## 影响

- seat 是纯增量：无人认领即无布局变化，未装 ui-model-selection 的 bundle 渲染与从前完全一致。
- 新文件按文件覆盖率 100%（EffortButton.tsx、effort.ts），由直挂组件用例覆盖：档位行与预选、仅无模型默认时出现 provider-default 行、重复选择为无操作、被拒选择的 toast 及其消退、锁定/进行中禁用、全部关闭路径。
- 真机走查复用能力走查的 `capwalk` provider：按钮中出现声明的 Off/Low/Medium/High 集且预选 High，选择经共享选择动词提交，模型 seat 触发器文案随之更新。

## 曾考虑的替代方案

- **`conversation.input.right` 列表条目**是被记录的 slot 机制，但输入栏把该列表渲染在模型 seat 左侧；需求是按钮贴在模型按钮正右侧，因此采用命名兄弟 seat（plan/model 模式）才是忠实的组合。
- **只把快捷选择留在模型 seat 菜单里**（不加新 seat）改动更小，但一次点击切换档位仍未交付——正是本改动要闭合的缺口。
- **第二个目录或专用 effort RPC** 会分裂唯一选择事实；两个 seat 共享一个 `ModelDirectory` 和一个 `selectModel` 动词。
