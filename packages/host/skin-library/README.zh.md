# @deepseek-ai/dsh-host-skin-library

[English](README.md) | 中文

面向浏览器的 Remote 皮肤目录、壁纸存储、`ui-skin` 设置分区与插件加载前的皮肤引导。`SkinLibrary` 注册 `skinLibrary` 服务，并发布六个生成的直连 Remote：由 `harniverse.observe` 保护的 `list` 与 `readWallpaper`，以及由 `harniverse.administer` 保护的 `importPack`、`removePack`、`putWallpaper` 与 `removeWallpaper`。每次调用都在客户端当前指向的机器上执行，因此远程主机经同一个 web-app 行提供它自己的皮肤库。该服务只提供 Remote，不声明同进程的 Cordis `Context` 合并。负载类型位于 `./types`；Typert 生成 `./typert` 与 `./remote` 暴露的 Host 与 Client Remote 工件，客户端经 [`api-remotes`](../../api/remotes/README.md) 消费它们。

## 目录

`list()` 依次返回内置皮肤、按英文名与 id 排序的已导入皮肤包、按最新在前排序的已存壁纸、被拒绝的皮肤包文件及原因，以及 Remote 强制执行的上限。八套内置皮肤是代码：`abyss`、`aurora`、`nebula`、`ember`、`midnight`（深色）与 `ivory`、`mist`、`rose`（浅色）。它们的配色移植自 MIT 许可的 dsh-dream-skin 项目（Copyright (c) 2026 dsh-dream-skin contributors），带有两种产品语言的名称、建议强调色与结构化渐变背景；不携带任何图片或壁纸数据。dream-skin 的品牌色在那里是强调色，在这里却是墨色，因此它供给 `--dsw-accent`、`--dsw-accent-hover` 与 `--dsw-accent-soft`，而 `--dsw-alias-brand-primary` 保持与该皮肤文字色一致的近黑或近白墨色。皮肤注册的主题 id 为 `skin:<id>`。

皮肤包在每次 `list()` 调用时从磁盘扫描，因此手动放入皮肤库的皮肤包文件无需重启即可出现；校验失败的文件会以 `{ file, message }` 形式列在 `rejected` 中，而不会让调用失败。

## 皮肤包格式

`importPack(text)` 接受一份皮肤包文档：下方的原生 `harniverse.skin` 版本 1 格式，或 `dsh-dream-skin/pack` 版本 1 兼容信封。新 id 返回 `imported`，id 已有皮肤包时返回 `replaced`，否则返回 `rejected`，其中每条违反的规则对应一条人类可读的问题；预期内的拒绝从不抛出。

```json
{
  "format": "harniverse.skin",
  "version": 1,
  "id": "my-skin",
  "name": { "zh": "我的皮肤", "en": "My Skin" },
  "author": "Someone",
  "description": "A calm dark skin.",
  "colorScheme": "dark",
  "accent": "#5e6ad2",
  "tokens": {
    "--dsw-accent": "#5e6ad2",
    "--dsw-alias-bg-base": "#101014",
    "--dsw-alias-bg-layer-1": "#1b1e28",
    "--dsw-alias-label-primary": "#f4f5f7",
    "--dsw-alias-label-secondary": "#a5adb8",
    "--dsw-alias-border-l1": "rgba(255, 255, 255, 0.07)",
    "--dsw-alias-border-l2": "rgba(255, 255, 255, 0.13)"
  },
  "background": {
    "kind": "gradient",
    "layers": [
      { "type": "radial", "at": [82, 0], "size": 60, "stops": [["rgba(94, 106, 210, 0.35)", 0], ["transparent", 60]] },
      { "type": "linear", "angle": 165, "stops": [["#121216", 0], ["#101016", 100]] }
    ]
  }
}
```

校验严格而完整：未知的顶层、`name`、`background` 或图层键会被拒绝而不是被丢弃，结果会被规范化（令牌按允许名单顺序排列、强调色转为小写、以单个字符串给出的 `name` 同时用于两种语言）。

| 字段 | 规则 |
|---|---|
| 文档 | 最多 256 KiB 的 UTF-8、合法 JSON、单个对象 |
| `format`、`version` | `harniverse.skin` 或 `dsh-dream-skin/pack`；`1` |
| `id` | `^[a-z0-9][a-z0-9-]{0,39}$`，且不是内置 id |
| `name` | 字符串，或 `{ zh, en }`；各 1 到 60 个字符 |
| `author`、`description` | 可选；分别最多 80 与 240 个字符；空白视为未设置 |
| 文本字段 | 不含控制字符或行分隔符 |
| `colorScheme` | `light` 或 `dark`；决定 `body[data-ds-dark-theme]` |
| `accent` | 可选，`#rrggbb` |
| `tokens` | 最多 40 项的对象；每个名称都在下方允许名单内；每个值都通过颜色语法；七个核心令牌必填 |
| `background` | 可选；`kind: "gradient"`，1 到 6 个图层，每层为 `linear`（`angle` 0 到 360）或 `radial`（`at` 为 `[x, y]`，0 到 100；`size` 1 到 150），带 2 到 8 个 `[颜色, 位置]` 色标，位置 0 到 100 |

颜色语法是一份白名单，每个值最多 64 个字符：`#rgb`、`#rgba`、`#rrggbb`、`#rrggbbaa`；带三个或四个普通数字的 `rgb()`、`rgba()`、`hsl()` 或 `hsla()`（可带 `%`，以逗号或空格分隔，透明度可置于 `/` 之后）；以及 `transparent`。`url()`、`var()`、`calc()`、`color-mix()`、`attr()`、`image-set()`、颜色名、转义、引号、分号、花括号、`!` 以及其他任何字符都不会匹配。

核心令牌为 `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-border-l1`、`--dsw-alias-border-l2` 与 `--dsw-accent`。可换肤的允许名单恰为下列名称，每个都由主题样式表声明：

```text
--dsw-accent --dsw-accent-hover --dsw-accent-soft
--dsw-alias-bg-base --dsw-alias-bg-layer-1 --dsw-alias-bg-layer-2 --dsw-alias-bg-layer-3 --dsw-alias-bg-overlay --dsw-alias-bg-module-platform
--dsw-alias-border-l1 --dsw-alias-border-l2 --dsw-alias-border-l3 --dsw-alias-border-l4
--dsw-alias-label-primary --dsw-alias-label-secondary --dsw-alias-label-tertiary --dsw-alias-label-caption
--dsw-alias-brand-primary --dsw-alias-brand-text --dsw-alias-button-primary-hover --dsw-alias-button-primary-dimmed
--dsw-alias-interactive-bg-hover --dsw-alias-interactive-bg-active
--dsw-alias-markdown-code-block --dsw-alias-markdown-inline-code
--dsw-alias-state-error-primary --dsw-alias-state-success-primary --dsw-alias-state-warn-primary
--dsw-alias-scrollbar-bg-l1 --dsw-alias-scrollbar-bg-l2 --dsw-alias-scrollbar-hover-l1 --dsw-alias-scrollbar-hover-l2
--dsw-specific-input-major --dsw-specific-tip --dsw-specific-bubble --dsw-specific-bubble-highlight --dsw-specific-selector --dsw-specific-menu
--dsw-specific-sidebar-fill --dsw-specific-sidebar-nav-item-active --dsw-specific-sidebar-nav-item-hover
```

兼容信封为 `{ "format": "dsh-dream-skin/pack", "version": 1, "manifest": { id, name, nameZh, author, description, colorScheme, accent, tokens } }`。它转换为原生形态时 id 转为小写并应用同样的规则，区别在于未知的信封键、manifest 键以及允许名单之外的令牌会被无声丢弃，且不计入 40 项令牌上限。dream-skin 的品牌色是强调色，因此缺失的 `--dsw-accent` 取自 manifest 的 `accent`，否则取自 `--dsw-alias-brand-primary`；缺失的 `--dsw-accent-hover` 与 `--dsw-accent-soft` 分别取自 `--dsw-alias-button-primary-hover` 与 `--dsw-alias-button-primary-dimmed`。

## 存储

皮肤库位于配置的 `dir` 之下，web-app 捆绑将其设为 `dshHomePath('skins')`：

```text
<dir>/packs/<id>.json             one native pack per imported skin
<dir>/wallpapers/<sha256>.<ext>   one content-addressed image per wallpaper (png, jpg, webp)
```

目录以 `0o700` 创建，文件以 `0o600` 创建。每次写入都先写到以独占方式创建的隐藏同级临时文件，再重命名覆盖目标，因此读取方看到的要么是旧内容要么是完整的新内容，写入失败也不会留下临时文件。变更逐个执行，因此在并发上传下壁纸数量上限的检查与执行是原子的。已导入的皮肤包无论以哪种格式到达，都以原生形态存储。

`packs/` 中的 `.json` 文件只有在文件名为 `<id>.json` 且内容校验为该 id 的皮肤包时才会被提供；其他 `.json` 文件会连同原因列入 `rejected`，非 `.json` 文件、目录与符号链接则被忽略。壁纸的 `addedAt` 是其文件的 mtime，因此重复上传相同字节会保留首次上传时间。`removePack` 按 id 删除，且无法删除内置皮肤；`removeWallpaper` 按内容地址删除。

## 壁纸

壁纸字节只经由 Remote RPC 通道以 base64 编码传输，没有单独的 HTTP 路由。`putWallpaper(contentBase64)` 先在解码前限制编码长度，要求规范的带填充 base64，把解码后大小限制在 8 MiB，并依据文件签名判断类型（PNG、JPEG 或 WebP；从不依据声明的类型或文件名，也绝不接受 SVG、GIF 或 AVIF）。它返回 `stored`、相同字节此前已存储时的 `existing`，或带 `invalid-encoding`、`too-large`、`unsupported-type`、`limit-reached`（24 张壁纸）之一的 `rejected`。内容地址是字节的小写十六进制 SHA-256。`readWallpaper(hash)` 在确认已存字节仍能哈希到所请求的地址、且仍带有所存类型的签名后，返回 `{ mime, contentBase64 }`；条目未知、格式错误或已损坏时返回 `undefined`。删除壁纸不会改动引用它的 `ui-skin.wallpaper` 设置；`readWallpaper` 找不到时，客户端不显示壁纸。

## 设置与引导

当组合了设置服务时，本包注册 `ui-skin` 命名空间。浏览器包精确镜像这些字段名。

| 字段 | 类型 | 默认值 | 约束 |
|---|---|---|---|
| `accent` | `string` | `''` | 空或 `#rrggbb`；覆盖皮肤的强调色 |
| `wallpaper` | `string` | `''` | 空或 64 位小写十六进制（SHA-256） |
| `wallpaperBlur` | `number` | `0` | 0 到 40，步长 1（px） |
| `panelOpacity` | `number` | `0.82` | 0.4 到 1，步长 0.01；背景之上的面板与侧栏填充 |
| `composerOpacity` | `number` | `0.9` | 0.4 到 1，步长 0.01 |
| `popoverOpacity` | `number` | `0.96` | 0.6 到 1，步长 0.01 |
| `material` | `'off' \| 'frosted' \| 'liquid'` | `'off'` | 玻璃质感 |

被选中的皮肤不存放在这里：`ui-theme.preference` 在 `light`、`dark` 与 `system` 之外还可保存 `skin:<id>`。组合了 web 服务器时，本包挂接 `webServer.tapIndex`。每次渲染索引响应时，它经设置服务读取 `ui-theme.preference`；若其指向内置皮肤或可解析的已导入皮肤包，就在最后一个 `</body>` 之前（HTML 没有该标签时追加在末尾）插入一段内联经典脚本，位置在主题插件自己的引导之后。脚本设置 `document.documentElement.style.colorScheme`，切换 `body[data-ds-dark-theme]`，并对每个令牌调用 `body.style.setProperty(name, value)`。输出只取决于该皮肤；令牌值在输出时按颜色语法重新校验，内嵌的 JSON 会转义 `<`、`>`、`&`、U+2028 与 U+2029。偏好不是皮肤，或皮肤已无法解析时，HTML 保持不变。引导阶段不应用其他任何内容（强调色覆盖、色彩晕染、壁纸、质感）；其余由客户端在其插件加载之后完成。

## 安全模型

- 读取需要 `harniverse.observe`；所有变更都需要 `harniverse.administer`。皮肤包不执行任何东西：它是按固定令牌允许名单与白名单颜色语法校验的数据，因此任何皮肤包的值都无法引用 URL、其他变量或函数，也无法携带分隔符。
- 本包发出的唯一代码是引导脚本，由重新校验过的值构建并转义了不安全字符，因此值无法提前结束 script 元素或 JavaScript 字符串。
- 文件名来自已校验的 id 与内容哈希，从不来自调用方文本，因此请求无法寻址到皮肤库之外的路径。皮肤包与壁纸在读取时先限制大小，再解析或编码字节。
- 图片类型由签名判定并在读取时再次验证；SVG 被排除，因此已存壁纸无法携带脚本或外部引用。

## 配置

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `dir` | `string` | 必填 | 存放 `packs/` 与 `wallpapers/` 的绝对皮肤库目录；首次写入时创建。web-app 捆绑传入 `dshHomePath('skins')`。 |

## 模型体验

无，因为皮肤库为浏览器存放展示资源；其中的任何内容都不会对模型可见。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **没有 HTTP 壁纸路由** —— 图片以 base64 经 JSON RPC 请求体传输，体积增大三分之一，因此能从浏览器上传多大的图片，除 8 MiB 的解码后上限外还受连接的请求体上限约束；读取则在一次响应中返回整张图片。
- **令牌比允许名单少一个名额** —— 皮肤包最多携带 40 项令牌，而允许名单有 41 个名称，因此皮肤包总会至少留一个令牌给基础配色。
- **没有皮肤包数量上限** —— Remote 限制每个皮肤包的大小与壁纸数量，但不限制皮肤库容纳多少皮肤包，且每次 `list()` 都会重新读取并重新校验每个皮肤包文件。
- **被拒绝的文件需手动删除** —— `removePack` 按 id 定位有效皮肤包，因此列在 `rejected` 中的被拒绝文件需直接从 packs 目录删除。
- **引导阶段只涂颜色** —— 用户强调色覆盖、色彩晕染、壁纸与质感都在客户端插件加载后才出现，因此自定义过的皮肤可能先闪现其基础颜色。
- **私有权限依赖 POSIX** —— `0o700` 与 `0o600` 在 Windows 上不起作用，且写入不执行 fsync，因此崩溃可能丢失最近一次写入。
- **库根目录是文件时，Windows 上读到的是空库**：Windows 把在文件之下的读取报告为路径不存在，因此 `list()` 回答空库，而 POSIX 会抛出 `ENOTDIR`；两者的写入都会失败。
