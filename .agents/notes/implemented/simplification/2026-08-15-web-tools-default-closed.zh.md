# Agent Note: 基础组合包默认关闭 Web 工具

Status: implemented

[English](2026-08-15-web-tools-default-closed.md) | 中文

## 问题

模型若在获得部署专属路由指引以前就看到 `web_search`，可能会把一种搜索方法当成覆盖所有来源的通用途径，而失败请求也没有给它预先选择方法的策略。在每个随附 preset 中启用固定搜索工具，还会让面向模型的工具 schema 与指引进入每次请求，即使部署通过 Skill、外部程序或其他插件提供联网能力。

Web 服务、提供方、实时 settings 与 credentials 在默认模型暴露之外仍有用途。移除这些配置行会把暴露决策扩大成提供方移除，并丢弃显式选择启用的路径。

## 决策

基础组合包会挂载 `dsh-web`、全部三个官方搜索提供方及 `dsh-tool-web`，但把工具 consumer 配置为 `search: false` 和 `fetch: false`。任何随附 preset 都不会从 base 获得 `web_search`、`web_fetch` 或相应提示词指引。后续 patch 可以在部署选定路由与内容安全策略以后，替换 `tool-web` 的完整配置来启用搜索；抓取还需要额外提供方。

提供方选择、实时 settings 与凭据解析仍保持挂载。`DSH_WEB_SEARCH_PROVIDER` 与 `web.searchProvider` 会选择显式启用的搜索所使用的提供方，而提供方配置行在启动时仍无需密钥。搜索 e2e 场景会先应用显式的 `tool-web` 选择启用 patch，再验证真实提供方与模型可见结果。

本决策部分取代[默认 Web 搜索决策](../feature/2026-07-31-web-default-search.md)中的默认暴露部分。该笔记继续拥有提供方凭据解析、辅助 DeepSeek 请求日志、端点分离及选择启用后的搜索执行行为。

## 考虑过的替代方案

**保持 `web_search` 启用并依赖 Skill 描述。** 不予采纳，因为模型可以在加载 Skill 以前调用可见工具，而且每次请求仍会携带该 schema 与提示词指引。

**加载 Skill 后动态显示 Web 工具。** 不予采纳，因为在会话内改变工具 schema 会改变模型请求前缀并削弱提示词缓存复用，同时引入现有 Skill loader 并不拥有的激活状态。

**从 base 移除 Web 服务与提供方配置行。** 不予采纳，因为默认模型暴露与提供方可用性是两个独立决策。保留休眠提供方可以维持实时配置，并为需要原生工具的部署保留小型显式覆盖层。

**完全移除 `tool-web` 配置行。** 不予采纳，因为启用覆盖层届时必须插入软件包配置行，而不能只替换一项配置；base 也将不再声明受支持的选择启用 consumer。

## 后果

面向模型的工具清单与 Code Mode SDK 默认不包含两个 Web 工具。提供方 settings 仍可见，并在部署启用搜索后生效。原生搜索测试会显式启用 consumer；随附组合、preset 与构建后请求覆盖则固定默认缺席行为。

这不是进程级网络限制。具有 Bash 的 preset 仍可调用具备联网能力的外部程序，除非部署应用沙箱或出站策略；基础组合包只是不暴露自己的原生 Web 工具。
