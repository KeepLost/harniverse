# Agent Note：原生密钥文件选择与远程主机界面重构

Status: implemented

[English](2026-09-29-remote-host-key-file-picker.md) | 中文

## 问题

添加主机表单只提供一种私钥供给方式：把 PEM 文本粘贴进文本框。操作者的密钥放在文件里（`~/.ssh/id_ed25519` 之类），因此每次保存都从 `cat` 和剪贴板开始。表单还分别使用密码与口令两个输入框，而一个共享的机密输入框即可；其视觉语言（侧栏按钮几何、页面骨架、按钮与输入框样式）也与相邻中心视图不一致，使整个界面像是临时拼上去的。

选择文件需要在宿主屏幕上打开原生 OS 对话框。仓库已为工作区目录拥有这条能力缝——`ctx.directoryPicker` 的 `native`/`browse` 能力分支，背后是 `host.pickDirectory`——但它只支持目录，也没有设定起始目录的方式。

## 决策

目录选择 seam 增加单文件交互，而不是新增第二个服务。`DirectoryPickerNativeCapability` 扩展出 `pickFile(signal, request?)` 与 `DirectoryPickerFileRequest { title?, defaultDirectory? }`；`browse` 分支不变，未知 kind 的消费方依旧隐藏入口。原生后端按平台实现：macOS 经 osascript 执行 `choose file default location`；Linux 使用 `--file-selection --filename=<dir>/`（Zenity）与 `--getopenfilename <dir>`（KDialog）；Win32 的 `IFileOpenDialog` 子进程增加文件模式与尽力而为的 `SHCreateItemFromParsingName` + `SetDefaultFolder` 种子（不可用的种子降级为对话框自己的起始位置，而不是让选择失败）。宿主无法看到的起始目录在适配器边界被丢弃——否则 osascript 会让整个选择器硬失败。Electron 自有 Host 路径通过与其 `pickDirectory` 相同的父进程回调 IPC 传递 `pickFile`（`file-pick`/`file-result`/`file-cancel` 消息，遵循同样的单飞与中止规则）。

`RemoteHostsProvider.pickKeyFile()` 是消费方面：`remoteHosts` 命名空间下要求 `harniverse.administer` 的 Remote 方法，经 `ctx.get('directoryPicker')` 解析选择器（可选服务——没有 `native` 能力的组合以 `KEY_PICKER_UNAVAILABLE` 快速失败），以 `join(homedir(), '.ssh')` 作为起始目录，返回用于展示与一次性使用的 `{ path, content }`。内容上限 64 KiB（`KEY_FILE_TOO_LARGE`）；拾取后消失或不可读的文件上报 `KEY_FILE_READ_FAILED`；外来选择器失败收敛为 `KEY_PICKER_FAILED`。路径永不持久化——主机配置始终只保存引用。

浏览器界面按定时任务页面的骨架重建：固定头部（含已连接计数摘要与操作区）覆盖在滚动的卡片列表之上；编辑器是右侧抽屉（`role="dialog"`，Escape 关闭）；设计令牌取代临时色板；手机形态遵循框架的 `data-viewport='phone'` 约定而非媒体查询。密钥登录默认走文件选择：抽屉展示 Host 拾取的路径，以及「手动粘贴密钥内容」勾选框，两种状态互斥——勾选启用粘贴并禁用文件按钮，取消勾选则相反。一个共享密码输入框按所选登录方式承载登录密码或私钥口令；拾取会把文件内容装载为被检测的机密，两种来源都通过既有的 `testedFields` 规则使已完成的连通性检测失效。

## 备选方案

- 像附件流那样使用浏览器 `<input type="file">`：被否决，因为它读取的是浏览器所在机器、不展示宿主路径、无法以 `~/.ssh` 为起始目录，且让桌面（Electron）场景读错进程的文件系统。
- 返回任意宿主文件内容的通用 `host.pickFile` RPC：被否决，其安全面超出特性所需；typert Remote 让操作具名、受能力门控，并留在永不代理到已连接远程主机的 remote-hosts 命名空间内。
- 给 `pickDirectory` 加模式开关：被否决，目录与文件选择是同一后端的不同交互，这正是该 seam 可辨识能力联合所建模的；布尔开关会让每个调用方都分支。
- 连接时按路径读取密钥文件（持久化路径）：被否决，持久化的主机配置只保存凭据引用，而路径会在文件移动后静默失效；拾取的内容走既有的一次性 `AuthSecrets` 与凭据存储规则。
- 由客户端播种对话框（浏览器传 `~/.ssh`）：被否决，对话框属于 Host，相关的家目录是 Host 账号的；种子在宿主侧计算。

## 修订：交互探针与客户端回退

第一版强制要求 `native` 能力、否则抛出 `KEY_PICKER_UNAVAILABLE`，这恰恰破坏了最常见的真实部署：`directory-picker-auto` 对绑定非回环、经 SSH 启动或缺少 Linux 选择器二进制的 Host 一律解析为 `browse`，此类 Host 上呈现的是一个死按钮加一句含义不明的 `Remote invocation failed`（普通 `Error` 的 `RemoteHostsError` 不会把错误码带上线路）。两项修正均为插件原生：

- `remoteHosts.keyFilePicker()`（`harniverse.observe`）报告当前组合提供的交互——`native` 或 `client`——登录表单据此渲染对应的入口。`client` 交互即浏览器自身的文件输入：客户端在同样的 64 KiB 上限下读取文件，文件名标注在行内，内容与粘贴文本完全同路地作为一次性凭据。这呼应了缝契约（消费方按 `capability().kind` 分支；不可拾取时降级而不是失败），同时不把 `browse` 能力扩到目录之外。
- `RemoteHostsError` 改为继承 typert `RemoteError`，网关因此把封闭错误码原样保留上线；表单把 `KEY_*` 错误码映射为本地化文案，而不是透出网关泛化文本。

## 后果

密钥文件选择在任何组合下都可用：`native` 时使用 Host 显示器上的原生选择器，其余走客户端文件输入，手动粘贴始终保留。Win32 COM 新增（槽位 11 `SetDefaultFolder`、shell32 解析）通过既有 bindings/worker 假件测试覆盖；真实 COM 路径只在真实 Windows 主机上运行，与既有选择器的测试姿态一致。

文本密钥流程除人机工程外不变：粘贴或拾取的材料都是一次性机密，仅在 `storeCredentials` 下经凭据提供方保存，提交后不再渲染。Electron 外壳与自有 Host 子进程之间的 IPC 协议新增 `file-pick`/`file-result`/`file-cancel`，其精确键校验与目录消息一致。

验证分布在：native-picker 套件（各平台文件适配器、种子目录的启用与丢弃、AppleScript 转义、取消）、win32-dialog logic/bindings 套件（文件模式选项、`SetDefaultFolder` 成功／失败／降级、worker 模式与种子）、desktop-host 组合与生命周期套件（回调穿透、`file-result` 关联、中止）、remote-hosts 协调器套件（正常拾取、取消、消失／超大／不可用选择器、收敛失败）、typert 名册，以及浏览器视图套件（文件拾取装载并失效、取消与失败路径、手动粘贴互斥、共享凭据字段映射、Escape 抽屉）。
