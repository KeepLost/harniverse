# Agent Note: 提供方中立的默认组合

Status: implemented

[English](2026-08-14-provider-neutral-default-composition.md) | 中文

## 问题

基础 profile 会挂载原生 DeepSeek 适配器，Web 客户端还会在尚未配置的安装环境中打开 DeepSeek 凭据弹窗。尽管 LLM 运行时与 Models 页面已能通过 `llm-pi-ai` 支持目录提供方和自定义路由，这些默认行为仍把产品策略绑定到了单一厂商。

## 决策

基础 bundle 默认启用 `llm-pi-ai`，并把 `llm-deepseek` 保留为一条禁用行，供后续 profile 层显式重新启用。通用适配器在 settings 配置目录提供方或自定义提供方之前不会产生路由；组合层不会擅自虚构提供方、模型、端点或凭据。

`ui-settings-models` 会注册 Models 分区和产品声明，但不注册 `deepseek-official` 引导项。提供方凭据需要在 Models 页面中显式配置。部署启用 DeepSeek 提供方后，仍可使用可复用的 DeepSeek 编辑器与适配器实现，且不会恢复针对特定厂商的首次使用提示。本默认组合决策部分取代了 [DeepSeek 凭据引导决策](../feature/2026-07-30-deepseek-onboarding-credential-setup.md)中组装后产品的行为；其中的提供方联接与凭据处理实现对 Models 页面仍然有用。

## 曾考虑的替代方案

**仅在 DeepSeek 适配器被禁用时隐藏弹窗。** 不予采用，因为重新启用可选提供方时，还会同时恢复该提供方对整个产品的首次使用要求。

**选择某个已安装的 pi-ai 提供方和模型作为新默认值。** 不予采用，因为没有任何路由在所有部署中都必然已配置，也没有任何提供方凭据或模型对所有部署都有效。配置完成后，模型选择器才是显式选择位置。

**删除原生 DeepSeek 适配器包。** 不予采用，因为可选的直接提供方支持仍有价值；只要其组合行保持禁用，它就不会强加厂商策略。

## 后果

全新的 Web profile 不会显示 DeepSeek API 密钥弹窗。Models 页面可以配置任意受支持的 pi-ai 目录路由或自定义路由，部署也可以显式启用原生 DeepSeek 行。在可用路由完成配置与选择之前，输入框会要求选择模型，而不会通过虚构的回退值发送请求。

基础 bundle 测试会固定两个适配器行各自的启用与禁用状态；客户端注册测试则固定产品声明是 `ui-settings-models` 唯一贡献的引导项。
