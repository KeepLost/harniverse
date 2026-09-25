# Agent Note: Harniverse RC 前端品牌呈现

Status: implemented

[English](2026-09-25-harniverse-rc-frontend-branding.md) | 中文

## Problem

浏览器客户端、认证文档、安装元数据和文档站需要统一的 Harniverse RC 呈现，同时不改变提供方身份、package 名称、环境变量或插件原生组合模型。继承的鱼形标识不代表批准使用的产品图稿，欢迎声明也仍然描述较早的产品阶段。

## Decision

浏览器持有的资源是 `apps/web/public/harniverse-brand.png` 中完整的已提供图稿，保持原始 1254×1254 尺寸复制，并在空白会话 Hero 与两个认证文档中不裁切地渲染。PWA manifest 使用同一构图仅调整尺寸得到的 192×192 与 512×512 PNG。Web 入口和文档站有意不声明产品 favicon，并移除继承的鱼形 favicon 文件。

侧边栏在收起轨道中保留可访问、由布局持有的面板切换控件，展开时以文本渲染纯 `Harniverse` 字标。`FishLogo` 组件及其公共导出被移除。认证页头使用图稿与 Harniverse 产品名称，桌面端蓝色 H 保持不变。

产品持有的欢迎声明改为双语 Harniverse RC 文案，确认版本为 `2026-09-25.1`；该确认版本独立于 package 与 product version。提供方名称、model id、API key 标签、环境变量、package 名称和内部标识继续保持既有约定。

本笔记只持有呈现决策。[浏览器认证生命周期笔记](../architecture/2026-09-08-browser-authentication-lifecycle.md)继续持有认证状态和状态位置，[Web 安装 manifest 笔记](2026-08-06-web-install-manifest.md)继续持有安装语义，[文档站 chrome 笔记](../process/2026-08-12-documentation-site-navigation-and-chrome.md)继续持有 VitePress 导航和 chrome 行为。这些笔记原先的品牌事实由本笔记部分取代；其余约定继续有效。

## Alternatives considered

**小型简化字形：**拒绝，因为批准的源文件是完整的方形构图，安装图标必须仅通过调整尺寸保留该构图。

**在新图稿旁保留继承的鱼形标识：**拒绝，因为这会让官方标识继续存在于客户端，并产生两个相互竞争的产品身份。

**为每个表层生成不同图稿：**拒绝，因为一个仓库持有的源文件即可让 Hero、认证页与 PWA 安装元数据保持一致，也无需引入 logo 生成系统。

## Consequences

未认证 Web 外壳在插件加载前提供一个根相对图稿 URL，因此认证页与 Hero 不依赖认证路由或插件资源。固定图像尺寸会预留布局空间；图稿的呈现不依赖按主题切换的 SVG 标识，因此在明暗主题中都可用。在认证样式表既有的手机断点内，图稿尺寸为 88×88，管理操作独占页头的一整行。

收起轨道只有一个可操作的面板切换控件，不再有静止的装饰性鱼形状态。Web 入口和文档站没有产品 favicon，而 PWA manifest 保留完整图稿 PNG 安装图标。欢迎声明因为含义改变而会为已有用户重新显示一次；Host 镜像文案与 client 文案携带相同版本和文本。构建后的 PWA manifest 与浏览器验收检查会在生成 web dist 后验证复制的资源及其 192/512 尺寸。

## Verification

源文件与派生 PNG 已识别为 1254×1254、192×192 与 512×512 的 sRGB PNG。定向 client 测试覆盖纯文本字标、侧边栏切换控件、Hero 图稿 URL、认证图稿与名称、常驻编辑器行为，以及双语声明的精确文案。构建后 Web 验证需要新生成的 web dist：PWA 测试检查安装元数据、PNG 尺寸及 favicon 资源缺席；组装后的浏览器检查验证认证前后的图稿，以及明暗主题下的响应式布局。
