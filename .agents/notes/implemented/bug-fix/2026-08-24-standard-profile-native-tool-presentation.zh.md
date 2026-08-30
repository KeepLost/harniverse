# Agent Note: 保持 Code Mode opt-in 并将 run_code 暴露为能力成员

Status: implemented

[English](2026-08-24-standard-profile-native-tool-presentation.md) | 中文

## Problem

Web UI 显示的 Standard Profile 将所有工具都包进了 `run_code`，尽管随发布的 Standard 组合是 native。能力目录从所有 Profile 构建一个 recipe universe，并且对全局目标使用「任意 Profile 加载该行」作为默认值。由于只有 Code Profile 包含 `tool-presentation`，全局目录就把 Code Mode 当成了默认能力。这使 Profile 局部的呈现选择很容易被错误继承，也让 UI 状态产生误导。

能力适配器也没有把 `run_code` 描述为 presentation capability 的 member。虽然可以切换该行，但实际面向模型的传输并没有作为可独立选择的 member 显示出来；对于插入的顶层 recipe，自定义 member 选择也无法禁用它。

## Decision

全局目录现在把所有能力都视为 native default 未加载。全局目标提供显式的继承 override，不是无关 Profile native defaults 的并集。以 Profile 为目标的目录仍从该 Profile 的 source row 读取 `defaultLoaded`，因此 Standard 默认保持 native，Code 默认保持 Code Mode。

`@deepseek-ai/dsh-agent-tool-presentation` 贡献一个可见的 `run_code` member。插入行和 source 行统一编译 member 选择：选中 `run_code` 会插入启用的 presentation row；显式隐藏它会插入禁用的 row，因此 generation 不会在没有该 member 的情况下静默激活 Code Mode。

## Testing

composition 单元测试现在证明：全局目录保持 Code-only presentation opt-in、暴露 `run_code`、Standard native defaults 不会插入 Code Mode，并且能编译启用与禁用的 `run_code` member 选择。

真实 Web composition 测试挂载两个随发布的 Profile 并组装 system prompt：Standard 含 native `read` 且不含 `run_code`，Code 的 wire tool 集合恰好是 `[run_code]`。测试使用真实 Profile recipe 文件和 Loader 路径，而不是手工构造的服务 fixture。

HTTP/RPC carrier 与 session gateway 测试也通过，覆盖了调试该问题所需的 session list/status/create/history 路径。

## Alternatives considered

**保留全局并集默认值并特判 Code Mode。** 否决，因为未来任何 Profile-local 能力都会以同样方式泄漏。全局目标语义不同，不能从某一个 Profile 的 source row 推断部署默认值。

**把 `run_code` 仅视为呈现细节。** 否决，因为它是真正面向模型的传输，操作员在组装 Profile 时需要看到并控制它。

**只在 member 隐藏时禁用 presentation row。** 否决，因为对插入 recipe，旧编译器在 member 选择后强制把 `disabled` 重置为 false。现在插入行和 source 行都保留 member 选择结果。

## Consequences

Standard 和其他 native Profile 不会再因为 Code Profile 存在于同一 recipe universe 中就继承 Code Mode。Code Mode 仍可通过 Code Profile 使用，也可以通过 `run_code` 能力显式选择为全局或 Profile 能力。

全局组合页面现在表示显式的全局 override，而不是 Profile-native defaults 的并集；各 Profile 页面仍是其随发布 native 组合的权威视图。
