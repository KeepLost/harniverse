# Agent Note：自定义皮肤、强调色、壁纸与玻璃材质

Status: implemented

[English](2026-10-10-custom-skins.md) | 中文

## 问题

Web UI 只有三种外观：浅色、深色与跟随系统。`ui-theme` 虽然早已允许第三方插件注册主题，但产品里没有任何地方使用这个接缝；持久化的偏好只接受三个内置值；所有面板都绘制不透明底色，即便有壁纸也透不出来。来自 [dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin) 的用户希望得到它的配色、自己的强调色、壁纸和玻璃质感。

## 决策

两个新插件承载该功能，颜色偏好仍然只由 `ui-theme` 持有。

**偏好是开放的，调色板不是。** `ui-theme.preference` 接受 `light`、`dark`、`system`，或形如 `<namespace>:<name>` 的 id（皮肤是 `skin:<id>`）。持久化的 id 若其主题尚未注册，则渲染系统配色并保留该偏好，因此较晚加载的插件或被删除的皮肤包绝不会覆盖用户的选择。已注册主题被注销时，ThemeRuntime 不再重置偏好；偏好未解析期间，其快照携带 `pending`。

**组件读取接缝，而非字面量。** `skin-seams.css` 新增 `--dsw-surface-pane|sidebar|composer|popover`（各自默认为其所替代的不透明别名）和 `--dsw-material-panel|composer|popover-filter`（默认 `none`）。侧栏、会话区、详情栏、输入框、工作台与菜单都消费这些接缝，因此默认渲染不变，皮肤改变某个表面也无需改组件。强调色族 `--dsw-accent`、`-hover`、`-soft` 位于读取它们的别名块旁，浅色与深色两段都有。侧栏列表现在用蒙版淡出行内容，而不是在其上铺一层底色，因为叠在半透明栏上的底色会使栏脚变暗。

**`dsh-host-skin-library` 持有目录与字节。** 它保存八个内置皮肤（dsh-dream-skin 的配色，重映射到 41 项 token 白名单，单个皮肤包至多声明 40 项）、以 `packs/<id>.json` 保存的导入皮肤包，以及位于 `dshHomePath('skins')` 下按内容寻址的 `wallpapers/<sha256>.<ext>`。皮肤包是原生 `harniverse.skin` v1 文档或 dream-skin 信封；校验严格且完整，每个颜色都要通过白名单语法，因此其值在 CSS 自定义属性与内联脚本中都是安全的。`skinLibrary` Remote 的 `list` 与 `readWallpaper` 受 `harniverse.observe` 保护，`importPack`、`removePack`、`putWallpaper` 与 `removeWallpaper` 受 `harniverse.administer` 保护。限额：皮肤包 256 KiB，壁纸为 8 MiB 以内的 PNG、JPEG 或 WebP，库内最多保留 24 张壁纸。该包还在 `</body>` 之前注入一段启动脚本，在客户端挂载前绘制已保存的皮肤。

**启动交接没有闪烁。** `ui-theme` 现有的启动脚本紧跟 `<body>` 运行，把皮肤偏好解析为系统配色；随后库的脚本写入皮肤的 token，并把变量名列在 `body[data-ds-boot-tokens]`。快照为 `pending` 时，ui-layout 的呈现器保留这份绘制，之后把这些变量名纳入自己的收回集合并移除该属性，因此首次完整应用不会留下空档。

**`dsh-client-ui-skin` 持有各设置行与背景。** 外观分区（`appearance`，order 5）归 `ui-theme` 所有，颜色模式行（order 10）与字号行（order 20）放在新的 `settings.appearance.item` 槽位。`ui-skin` 追加皮肤图库（30）、强调色（40）、壁纸（50）、材质与透明度（60）和皮肤包（70），并填充 ui-layout 新增的 `shell.backdrop` 槽位，绘制壁纸或皮肤自带的渐变。该条目仅在有背景可绘制时才注册，因为槽位一旦被占用，框架就会把背景包装层挂成其第一个子节点，而默认外观必须让框架的 DOM 保持原样。设置导航图标改为带键的 `settings.nav.icon` 槽位，由各分区的所有者自行提供。`ui-skin` 写入 `ui-skin` 设置 namespace，API 代理现已对外暴露它（`accent`、`wallpaper`、`wallpaperBlur`、`panelOpacity`、`composerOpacity`、`popoverOpacity`、`material`）。

## 备选方案

**原始的 `POST/GET /api/skin/wallpaper` 路由。** 否决，理由与会话导入的上传路由相同：精确路由由页面 Host 服务且从不转发，上传到远程主机的壁纸会落到错误的机器上。Remote 以多约三分之一的字节为代价传输 base64，因此壁纸始终留在提供该库的那台机器上。

**按皮肤重写别名 token，组件保持不动。** 否决：半透明表面无法靠重绑其他规则所读的别名来表达（由别名自身计算得到的值是循环引用），而玻璃效果需要为每个表面设置 `backdrop-filter`。接缝给皮肤提供了一个有名字的改动点。

**在图库里重复“跟随系统／浅色／深色”。** 否决：没有 `ui-skin` 的组合仍需要 ui-theme 的颜色模式行，两个控件控制同一个偏好会在视觉上互相矛盾。图库只列皮肤，并说明选择皮肤会替换颜色模式。

**保留侧栏脚部的底色覆盖层。** 否决：铺在行内容上、渐变到侧栏表面的底色，会叠在该栏自身的半透明底色上，画出一条深色带。在滚动列表上加蒙版，对不透明栏等价，对半透明栏则正确。

**远程 URL 壁纸、自定义字体、密度与桌面标题栏。** 不在范围内：Host 只存本地图片字节。

## 影响

用户打开“设置 → 外观”，选择皮肤、覆盖强调色、上传壁纸、开启磨砂或液态玻璃材质，并导入或导出皮肤包。选择在刷新与 Host 重启后依然保留，刷新时皮肤在客户端挂载前就已绘制。当操作系统要求减少透明效果或高对比度时，面板保持不透明，材质被停用。没有 administer 权限的调用方看到已保存状态和禁用的写入控件；偏好本身仍可在本次会话内切换。

模型看不到这些内容，任何提供方请求或缓存键都不变。

已知限制。`--dsw-alias-label-primary-foreground` 由主题驱动，用户强调色相对它可能对比度偏低，且没有任何检查。与强调色无关的组件内字面量颜色保持固定，不会跟随皮肤：JSON 树与代码的语法配色、固定深色卡片上的提示文字、未解析引用的红色晕染，以及引导页的遮罩。引用块的底色晕染则通过 `--dsw-accent-chip` 跟随强调色，其默认值就是它所取代的原字面量。缩略图首次查看时会读取整张图，因为 Host 不生成缩略图。皮肤包数量没有上限，且 `list()` 每次调用都会重新校验每个皮肤包文件。

验证：host 库（配色、皮肤包语法、壁纸嗅探与限额、存储、启动脚本、设置、生成的 Remote 契约，以及真实 Loader 组合）与客户端包（控制器、写入器、各设置行、背景及真实的 ThemeRuntime）均达到 100% 行与分支覆盖；ui-theme、ui-layout、ui-settings 与同级分区的测试覆盖外观槽位、导航图标、接缝与启动交接；API 代理的暴露；以及生成目录、翻译配对、包 README、CSS token、JSDoc、运行时闭包与 knip 的仓库门禁。一个封闭的 Web 场景在浏览器中驱动真实组合：外观分区黄金快照，应用皮肤并刷新以证明没有默认配色闪烁，强调色覆盖与重置，壁纸存于隔离目录并绘制在框架之后，玻璃材质开关，以及一个皮肤包被拒绝、导入、选中与删除。另一次经由发布启动器、在无头浏览器中以邀请码配对的带认证运行，确认了同样的流程以及 Host 重启后的保留。未验证：辅助技术下的行为、库目录在 Windows 与 macOS 上的路径处理，以及把远程主机作为目标的情形。
