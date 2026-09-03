/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'configurableTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber' | 'invalidPercentage'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'compactionTitle' | 'compactionDescription' | 'compactionThreshold' | 'compactionThresholdHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchProvider' | 'webSearchProviderHint' | 'webSearchProviderUnavailable'
  | 'webSearchProviderDeepSeek' | 'webSearchProviderExa' | 'webSearchProviderPerplexity'
  | 'webSearchProviderTavily' | 'webSearchProviderBrave' | 'webSearchProviderKagi'
  | 'webSearchProviderFirecrawl'
  | 'webSearchFetchProvider' | 'webSearchFetchProviderHint'
  | 'webSearchFetchProviderHttp' | 'webSearchFetchProviderFirecrawl'
  | 'webSearchBooleanTrue' | 'webSearchBooleanFalse'
  | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint'
  | 'webSearchDeepSeekApiKey' | 'webSearchDeepSeekModel' | 'webSearchDeepSeekModelHint'
  | 'webSearchDeepSeekApiVersion' | 'webSearchDeepSeekApiVersionHint'
  | 'webSearchDeepSeekMaxTokens' | 'webSearchDeepSeekMaxTokensHint'
  | 'webSearchDeepSeekMaxUses' | 'webSearchDeepSeekMaxUsesHint'
  | 'webSearchExaApiKey' | 'webSearchExaSearchType' | 'webSearchExaSearchTypeHint'
  | 'webSearchExaSearchTypeAuto' | 'webSearchExaSearchTypeKeyword' | 'webSearchExaSearchTypeNeural'
  | 'webSearchExaNumResults' | 'webSearchExaNumResultsHint'
  | 'webSearchExaHighlightsPerResult' | 'webSearchExaHighlightsPerResultHint'
  | 'webSearchPerplexityApiKey' | 'webSearchPerplexityModel' | 'webSearchPerplexityModelHint'
  | 'webSearchPerplexityMaxTokens' | 'webSearchPerplexityMaxTokensHint'
  | 'webSearchPerplexitySearchRecency' | 'webSearchPerplexitySearchRecencyHint'
  | 'webSearchPerplexitySearchRecencyAny' | 'webSearchPerplexitySearchRecencyDay'
  | 'webSearchPerplexitySearchRecencyWeek' | 'webSearchPerplexitySearchRecencyMonth'
  | 'webSearchPerplexitySearchRecencyYear'
  | 'webSearchTavilyApiKey' | 'webSearchTavilyIncludeRawContent'
  | 'webSearchTavilyIncludeRawContentHint' | 'webSearchTavilyMaxResults'
  | 'webSearchTavilyMaxResultsHint'
  | 'webSearchBraveApiKey' | 'webSearchBraveMaxResults' | 'webSearchBraveMaxResultsHint'
  | 'webSearchKagiApiKey'
  | 'webSearchFirecrawlApiKey' | 'webSearchFirecrawlIncludeSearchContent'
  | 'webSearchFirecrawlIncludeSearchContentHint' | 'webSearchFirecrawlSearchContentMaxChars'
  | 'webSearchFirecrawlSearchContentMaxCharsHint' | 'webSearchFirecrawlMaxChars'
  | 'webSearchFirecrawlMaxCharsHint'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  configurableTab: 'Plugin configuration',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  invalidPercentage: 'Enter a whole percentage from 17 to 100, or leave blank to use each profile\'s setting.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  compactionTitle: 'Context compaction',
  compactionDescription: 'Control when older conversation history is reduced.',
  compactionThreshold: 'Automatic threshold (%)',
  compactionThresholdHint: 'Use 17–100. Leave blank to keep each Agent Profile’s configured threshold.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'Select and configure the active search provider.',
  webSearchProvider: 'Search provider',
  webSearchProviderHint: 'The provider used for new Web searches.',
  webSearchProviderUnavailable: 'This provider is not available in the deployment.',
  webSearchProviderDeepSeek: 'DeepSeek',
  webSearchProviderExa: 'Exa',
  webSearchProviderPerplexity: 'Perplexity',
  webSearchProviderTavily: 'Tavily',
  webSearchProviderBrave: 'Brave',
  webSearchProviderKagi: 'Kagi',
  webSearchProviderFirecrawl: 'Firecrawl',
  webSearchFetchProvider: 'Fetch provider',
  webSearchFetchProviderHint: 'The provider used when a Web page is fetched.',
  webSearchFetchProviderHttp: 'HTTP',
  webSearchFetchProviderFirecrawl: 'Firecrawl',
  webSearchBooleanTrue: 'Enabled',
  webSearchBooleanFalse: 'Disabled',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchDeepSeekApiKey: 'DeepSeek API key',
  webSearchDeepSeekModel: 'Model',
  webSearchDeepSeekModelHint: 'Anthropic-compatible model used for search.',
  webSearchDeepSeekApiVersion: 'API version',
  webSearchDeepSeekApiVersionHint: 'Value sent in the anthropic-version header.',
  webSearchDeepSeekMaxTokens: 'Max answer tokens',
  webSearchDeepSeekMaxTokensHint: 'Upper bound on generated tokens for one search response.',
  webSearchDeepSeekMaxUses: 'Max searches per request',
  webSearchDeepSeekMaxUsesHint: 'How many searches one request may perform before answering.',
  webSearchExaApiKey: 'Exa API key',
  webSearchExaSearchType: 'Search type',
  webSearchExaSearchTypeHint: 'How Exa chooses and ranks retrieval results.',
  webSearchExaSearchTypeAuto: 'Automatic',
  webSearchExaSearchTypeKeyword: 'Keyword',
  webSearchExaSearchTypeNeural: 'Neural',
  webSearchExaNumResults: 'Default result count',
  webSearchExaNumResultsHint: 'Results returned when a request does not set its own limit.',
  webSearchExaHighlightsPerResult: 'Highlights per result',
  webSearchExaHighlightsPerResultHint: 'Highlight sentences requested for each result.',
  webSearchPerplexityApiKey: 'Perplexity API key',
  webSearchPerplexityModel: 'Model',
  webSearchPerplexityModelHint: 'Perplexity model used for search answers.',
  webSearchPerplexityMaxTokens: 'Max answer tokens',
  webSearchPerplexityMaxTokensHint: 'Upper bound on generated answer tokens.',
  webSearchPerplexitySearchRecency: 'Search recency',
  webSearchPerplexitySearchRecencyHint: 'Optional age limit for search results.',
  webSearchPerplexitySearchRecencyAny: 'Any time',
  webSearchPerplexitySearchRecencyDay: 'Past day',
  webSearchPerplexitySearchRecencyWeek: 'Past week',
  webSearchPerplexitySearchRecencyMonth: 'Past month',
  webSearchPerplexitySearchRecencyYear: 'Past year',
  webSearchTavilyApiKey: 'Tavily API key',
  webSearchTavilyIncludeRawContent: 'Include raw content',
  webSearchTavilyIncludeRawContentHint: 'Ask Tavily to include raw content in search results.',
  webSearchTavilyMaxResults: 'Default result count',
  webSearchTavilyMaxResultsHint: 'Results returned when a request does not set its own limit.',
  webSearchBraveApiKey: 'Brave API key',
  webSearchBraveMaxResults: 'Default result count',
  webSearchBraveMaxResultsHint: 'Results returned when a request does not set its own limit.',
  webSearchKagiApiKey: 'Kagi API key',
  webSearchFirecrawlApiKey: 'Firecrawl API key',
  webSearchFirecrawlIncludeSearchContent: 'Include search content',
  webSearchFirecrawlIncludeSearchContentHint: 'Include bounded markdown content with Firecrawl search results.',
  webSearchFirecrawlSearchContentMaxChars: 'Search content limit (characters)',
  webSearchFirecrawlSearchContentMaxCharsHint: 'Maximum characters of content included with each search result.',
  webSearchFirecrawlMaxChars: 'Fetch content limit (characters)',
  webSearchFirecrawlMaxCharsHint: 'Maximum characters returned by a Firecrawl fetch.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '插件',
  title: '插件',
  intro: '配置和查看本部署已安装的插件。',
  tabs: '插件视图',
  configurableTab: '插件配置',
  empty: '本部署没有开放任何插件设置。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
  invalidPercentage: '请输入 17 到 100 的整数百分比；留空则使用各 Profile 的设置。',
  bashTitle: '终端',
  bashDescription: '限制 agent 运行的每一条命令。',
  bashTimeoutMs: '命令超时（毫秒）',
  bashTimeoutMsHint: '单条命令允许运行多久，超时即终止。',
  bashMaxOutputBytes: '单流输出上限（字节）',
  bashMaxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  agentLoopTitle: 'Agent 循环',
  agentLoopDescription: 'Agent 如何派发工具调用。',
  agentLoopMaxParallel: '并行工具调用数',
  agentLoopMaxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  compactionTitle: '上下文压缩',
  compactionDescription: '控制何时缩减较早的对话历史。',
  compactionThreshold: '自动压缩阈值（%）',
  compactionThresholdHint: '范围为 17–100；留空则保留各 Agent Profile 配置的阈值。',
  webSearchTitle: '网页搜索',
  webSearchDescription: '选择并配置当前使用的搜索提供方。',
  webSearchProvider: '搜索提供方',
  webSearchProviderHint: '新的网页搜索将使用这个提供方。',
  webSearchProviderUnavailable: '本部署未提供该搜索提供方。',
  webSearchProviderDeepSeek: 'DeepSeek',
  webSearchProviderExa: 'Exa',
  webSearchProviderPerplexity: 'Perplexity',
  webSearchProviderTavily: 'Tavily',
  webSearchProviderBrave: 'Brave',
  webSearchProviderKagi: 'Kagi',
  webSearchProviderFirecrawl: 'Firecrawl',
  webSearchFetchProvider: '抓取提供方',
  webSearchFetchProviderHint: '抓取网页时使用的提供方。',
  webSearchFetchProviderHttp: 'HTTP',
  webSearchFetchProviderFirecrawl: 'Firecrawl',
  webSearchBooleanTrue: '启用',
  webSearchBooleanFalse: '停用',
  webSearchApiKeyHint: '不写入设置文件。留空表示保持当前密钥。',
  webSearchApiKeySet: '已配置密钥。',
  webSearchApiKeyUnset: '未配置密钥；配置之前搜索不可用。',
  webSearchBaseUrl: '接口地址',
  webSearchBaseUrlHint: '留空则使用提供方默认地址。',
  webSearchDeepSeekApiKey: 'DeepSeek API Key',
  webSearchDeepSeekModel: '模型',
  webSearchDeepSeekModelHint: '搜索使用的 Anthropic 兼容模型。',
  webSearchDeepSeekApiVersion: 'API 版本',
  webSearchDeepSeekApiVersionHint: '随 anthropic-version 请求头发送的值。',
  webSearchDeepSeekMaxTokens: '回答 token 上限',
  webSearchDeepSeekMaxTokensHint: '单次搜索回答最多生成多少 token。',
  webSearchDeepSeekMaxUses: '单次请求最多搜索次数',
  webSearchDeepSeekMaxUsesHint: '一次请求在作答前最多可以搜索多少次。',
  webSearchExaApiKey: 'Exa API Key',
  webSearchExaSearchType: '搜索类型',
  webSearchExaSearchTypeHint: 'Exa 选择和排序检索结果的方式。',
  webSearchExaSearchTypeAuto: '自动',
  webSearchExaSearchTypeKeyword: '关键词',
  webSearchExaSearchTypeNeural: '语义',
  webSearchExaNumResults: '默认结果数',
  webSearchExaNumResultsHint: '请求未指定数量时返回多少条结果。',
  webSearchExaHighlightsPerResult: '每条结果的高亮数',
  webSearchExaHighlightsPerResultHint: '每条结果请求多少个高亮句子。',
  webSearchPerplexityApiKey: 'Perplexity API Key',
  webSearchPerplexityModel: '模型',
  webSearchPerplexityModelHint: '生成搜索回答所用的 Perplexity 模型。',
  webSearchPerplexityMaxTokens: '回答 token 上限',
  webSearchPerplexityMaxTokensHint: '回答最多生成多少 token。',
  webSearchPerplexitySearchRecency: '搜索时效',
  webSearchPerplexitySearchRecencyHint: '可选的搜索结果时间范围。',
  webSearchPerplexitySearchRecencyAny: '不限时间',
  webSearchPerplexitySearchRecencyDay: '过去一天',
  webSearchPerplexitySearchRecencyWeek: '过去一周',
  webSearchPerplexitySearchRecencyMonth: '过去一月',
  webSearchPerplexitySearchRecencyYear: '过去一年',
  webSearchTavilyApiKey: 'Tavily API Key',
  webSearchTavilyIncludeRawContent: '包含原始内容',
  webSearchTavilyIncludeRawContentHint: '要求 Tavily 在搜索结果中包含原始内容。',
  webSearchTavilyMaxResults: '默认结果数',
  webSearchTavilyMaxResultsHint: '请求未指定数量时返回多少条结果。',
  webSearchBraveApiKey: 'Brave API Key',
  webSearchBraveMaxResults: '默认结果数',
  webSearchBraveMaxResultsHint: '请求未指定数量时返回多少条结果。',
  webSearchKagiApiKey: 'Kagi API Key',
  webSearchFirecrawlApiKey: 'Firecrawl API Key',
  webSearchFirecrawlIncludeSearchContent: '包含搜索内容',
  webSearchFirecrawlIncludeSearchContentHint: '在 Firecrawl 搜索结果中包含有长度限制的 Markdown 内容。',
  webSearchFirecrawlSearchContentMaxChars: '搜索内容上限（字符）',
  webSearchFirecrawlSearchContentMaxCharsHint: '每条搜索结果最多包含多少字符的内容。',
  webSearchFirecrawlMaxChars: '抓取内容上限（字符）',
  webSearchFirecrawlMaxCharsHint: 'Firecrawl 抓取最多返回多少字符。',
}
