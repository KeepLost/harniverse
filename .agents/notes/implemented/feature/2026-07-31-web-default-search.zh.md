# Agent Note: 已交付组合中的默认 Web 搜索

Status: implemented

[English](2026-07-31-web-default-search.md) | 中文

## 问题

该 harness 已具备完整的 Web 能力体系：提供方注册表、DeepSeek、Exa 和 Perplexity 搜索提供方、本地抓取、稳定的面向模型工具，以及结构化结果呈现，但已交付的 `dsh web` 组合没有挂载其中任何一项。除非部署提供自定义覆盖层，否则模型无法发现最新信息。仅挂载现有 DeepSeek 提供方仍无法打通 WebUI 链路：Models 页面通过 `ctx.credentials` 存储 `DEEPSEEK_API_KEY`，而搜索提供方只会在插件加载时固定读取进程环境，因此在运行中的 UI 输入或轮换的密钥无法用于搜索。

## 决策

基础组合包明确挂载 `dsh-web`，配置 `searchProvider: deepseek-official`，同时挂载 `dsh-web-search-deepseek`，并以 `search: false`、`fetch: false` 和 `searchTimeoutMs: 60000` 挂载 `dsh-tool-web`。它不挂载 `dsh-web-fetch-http`，也不选择抓取提供方。[默认关闭决策](../simplification/2026-08-15-web-tools-default-closed.md)拥有面向模型的 Web 工具缺席行为；当部署替换 `tool-web` 的完整配置来启用搜索时，本笔记中的提供方、凭据、日志与超时决策开始适用。显式提供方 id 使选择不受注册顺序影响，一分钟部署预算则覆盖一次辅助 DeepSeek Messages 请求及服务端检索。

DeepSeek 搜索使用与官方会话适配器相同的 `DEEPSEEK_API_KEY` 凭据引用。提供方在每次搜索内部通过可选的 `ctx.credentials` 服务解析该引用；只有未挂载该 seam 的组合才会回退到启动进程的环境变量，非空的 `apiKey` 字面值仍作为程序化配置的最后兜底。因此，由 Web 的 Models 页存储或轮换的密钥无需重启即可用于下一次搜索，提供方也无需保留该值。由于 `WebSearchProvider.available()` 是同步方法，它会将已安装解析器视为本地可用；若动态凭据缺失，操作会以提供方专属错误码 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，而稳定的工具 schema 仍保持注册。

搜索端点与 chat completions 保持独立：`DEEPSEEK_SEARCH_BASE_URL` 覆盖 Anthropic 兼容基址，`DEEPSEEK_BASE_URL` 则继续配置会话请求。每次 `web_search` 都会发起一次辅助 DeepSeek Messages 调用，并携带原生搜索服务器工具。发出请求前一刻，提供方会向发起请求的 agent（智能体）会话追加仅用于日志的 LLM（大语言模型）请求事件 `web/deepseek-search-llm-request`，其中包含已解析端点、API 版本，以及不含密钥的精确 JSON 请求体。凭据预检仍留在提供方内部，并与调用方取消存在竞态；这两项关注点都不会扩展通用 Web seam 或凭据 seam。

base 挂载不会创建 Web 专用权限策略，而且不暴露任一 Web 工具。覆盖层启用的 `web_search` 仍会在 bash／文件系统沙箱及审批预设之外执行，并遵循 `dsh-tool-web` 的现有约定。已交付的 `workspace-write` 默认值只管辖文件修改；若产品采取受限网络策略，就需要添加 `tools/pre-execute` 策略或按能力限制网络访问，而不能暗示文件系统访问模式会管辖 Web 调用。

## 考虑过的替代方案

**启用 `dsh-tool-web` 但不挂载提供方。** 不予采纳：稳定的 schema 如果没有已注册提供方，每次启用的调用都会失败。base 通过挂载提供方但禁用两个 consumer 工具，将提供方可用性与模型暴露保持分离。

**从 `cordis.yml` 读取 `$DSH_HOME/.env`，或将其提升到 `process.env`。** 不予采纳：凭据提供方拥有该文件，环境变量值是只读覆盖；提升后存储的密钥将无法轮换，还会绕过经审计的密钥边界。

**在提供方加载时固定读取 `process.env.DEEPSEEK_API_KEY`。** 不予采纳：Web Models 页面通过 `ctx.credentials` 写入密钥；产品文档规定的首次运行路径必须保证下一次操作无需重启即可生效。

**将 Web 工具保留在 `web.cordis.yml` 中。** 不予采纳：这会保留 TUI 与 Web／无头界面之间无法解释的工具清单差异。这些配置行并非界面特有，因此其唯一归属是 `base.cordis.yml`；[工具清单决策](2026-07-31-even-out-shipped-tool-rosters.md)记录了这一共享组合。

**提高 `dsh-tool-web` 的提供方无关超时。** 不予采纳：自定义提供方和部署有各自不同的延迟预期；这一部署预算应归已交付的 DeepSeek 组合所有。

**同时启用搜索和抓取。** 不予采纳：默认启用 `web_fetch` 会允许模型自行选择任意 URL，执行匿名出站 HTTP(S) 抓取。搜索负责发现信息；接受更广泛抓取范围的部署可以在覆盖层中选择启用 `dsh-web-fetch-http`，并将 `dsh-tool-web` 的 `fetch` 选项设为 `true`。

## 后果

每个已交付界面的原生模型请求都会省略两个 Web schema 及其提示词指引。显式搜索 e2e 覆盖层会启用 `web_search`，经由本地 fixture 驱动真实提供方，断言持久化的辅助请求与结构化结果，并固定最终浏览器呈现。搜索仍会增加一次完整的辅助模型调用，并可能多次使用原生服务器工具；发起会话的日志仍可精确重建其不含密钥的请求。随附组合与 preset 测试固定默认缺席行为，提供方测试则固定缺失、已存储及已轮换凭据的行为，以及字面值与环境变量的兼容性。
