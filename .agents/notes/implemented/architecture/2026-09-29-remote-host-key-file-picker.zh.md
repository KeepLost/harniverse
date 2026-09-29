# Agent Note：宿主侧密钥选择与远程主机界面的路径制密钥凭据

Status: implemented

[English](2026-09-29-remote-host-key-file-picker.md) | 中文

## 问题

添加主机表单只提供一种提供私钥的方式：把 PEM 文本粘贴进文本域。操作者的密钥放在文件里（`~/.ssh/id_ed25519` 之属），于是每次保存都从 `cat` 和剪贴板开始。表单还把登录密码与私钥口令分成两个输入框，而一个共享的秘密输入框即可；其视觉语言（侧栏触发器几何、页面骨架、按钮与输入框样式）与兄弟中心视图不一致，整个界面像是后钉上去的。

密钥文件存在于 Host 所在的机器上，路径的选取与读取都必须在那里。中间一版在非 `native` 组合上改用浏览器自己的 `<input type="file">` 读取文件——选错了机器：远程或经 SSH 启动的 Host 面对的浏览器机器并不是 Host 机器，且上传的内容无谓地离开了 Host 的边界。最终设计把每一步都留在宿主侧。

## 决策

directory-picker 缝增加单文件交互而不是第二个服务。`DirectoryPickerNativeCapability` 扩展出 `pickFile(signal, request?)`，请求为 `DirectoryPickerFileRequest { title?, defaultDirectory? }`；`browse` 臂不变，未知种类的消费者继续隐藏入口。原生后端按平台实现：macOS 经 osascript 的 `choose file default location`，Linux 为 `--file-selection --filename=<dir>/`（Zenity）与 `--getopenfilename <dir>`（KDialog），Win32 的 `IFileOpenDialog` 子进程增加文件模式并尽力以 `SHCreateItemFromParsingName` + `SetDefaultFolder` 播种起始目录（不可用的种子退化为对话框自己的起始位置而不是让拾取失败）。宿主看不到的起始目录在适配器边界被丢弃——否则 osascript 会让整个选择器硬失败。Electron 自有 Host 路径把 `pickFile` 穿过与 `pickDirectory` 相同的父回调 IPC（`file-pick`/`file-result`/`file-cancel` 消息，同样的单飞与中止规则）。

`remoteHosts.keyFilePicker()`（`harniverse.observe`）是路由探针：宿主能打开自己的选择器时 `{ kind: 'native' }`，否则 `{ kind: 'browse' }`。`remoteHosts.pickKeyFile()`（`harniverse.administer`）是 `native` 半边：经 `ctx.get('directoryPicker')`（可选服务——没有 `native` 能力的组合以 `KEY_PICKER_UNAVAILABLE` 快速失败）解析选择器，以 `join(homedir(), '.ssh')` 播种，返回 `{ path }`——所拾取文件的宿主本地路径，取消时不存在。`browse` 半边是同一命名空间内的具名列表 RPC：`remoteHosts.listKeyFiles(input)`（`harniverse.administer`）每次列出 Host 机器的一个目录层级——目录在前、文件在后、各自按名字排序——以操作者的 `~/.ssh`（不存在时回退家目录）起始，上限 1000 条，触限置 `truncated`。目录进入下一层；文件直接选中，因此选定的凭据始终是具体文件。相对路径以 `INVALID_INPUT` 拒绝；不可读层级上报 `KEY_DIRECTORY_UNREADABLE`。对话框在 ui-remote-hosts 包内，跨包槽位或目录选择器依赖都不再与密钥流耦合。

密钥凭据是宿主本地路径，绝不是上传。`AuthSecrets` 的 key 臂二选一：`privateKey`（内联内容——粘贴文本）或 `privateKeyPath`（绝对 POSIX 或 Windows 路径）；登录表单默认走路径。`storeCredentials` 时记录保留 `keyPath`——命名 Host 机器上文件的普通字符串，与 `dshHome` 等宿主本地路径同列，绝不是秘密——以及加密的口令引用；内联材料照旧流入凭据提供方。Host 在每次使用凭据时——`verify` 与 `connect`——自行读取文件，受 64 KiB 上限约束：超限上报 `KEY_FILE_TOO_LARGE`，使用时消失或不可读上报 `KEY_FILE_READ_FAILED`，外来选择器失败收敛为 `KEY_PICKER_FAILED`。`RemoteHostsError` 继承 typert 的 `RemoteError`，但用载波已注册的 `remote-host-failed` 码，本包自己的封闭错误码放在 `details.reason` 里；表单把可处置的 reason 映射为本地化文案。载波错误码是封闭集合：未注册的码（第一版的 `KEY_FILE_READ_FAILED` 等）会让客户端的响应解析整体失败，界面只显示 schema 报错而非任何诊断——这个 reason 通道正是为替代该回归而设。

浏览器界面重构为定时任务页面骨架：固定头部，含已连接计数摘要与操作区，其下为滚动的卡片列表；编辑器是右侧抽屉（`role="dialog"`，Escape 关闭）；token 取代临时调色板；手机表单遵循框架的 `data-viewport='phone'` 约定而不是媒体查询。密钥登录展示可编辑的路径输入框（`native` 选择器填充完整路径；`browse` 对话框填充目录部分；`absent` 或探针失败保留手动输入——未知交互种类的既定降级规则）与「手动粘贴密钥内容」勾选框，两态互斥——勾选后路径输入与拾取按钮禁用，取消勾选恢复两者并隐藏文本域。一个共享的密码输入框承载登录密码或所选方式的私钥口令；任一受测字段变化都会经既有的 `testedFields` 规则作废已完成的连通性检测。

## 备选方案

- 像附件流那样用浏览器 `<input type="file">`：否决，因为它读的是浏览器机器而密钥在 Host 机器上，不展示宿主路径，无法播种 `~/.ssh`，还无谓地把私钥材料送上线路。
- 返回任意宿主文件内容的通用 `host.pickFile` RPC：否决，其安全面超出特性所需；`pickKeyFile` 保持为 remote-hosts 命名空间内具名、按能力门控的操作，且从不代理到已连接的远程主机，返回的是路径而不是内容。
- 给 `pickDirectory` 加模式标志：否决，目录与文件选择是同一后端的两种交互，这正是缝的判别能力联合所建模的；布尔标志会让每个调用方分支。
- 让持久化的主机配置完全不含路径（只留内容引用）：对密钥否决，因为路径是关于 Host 机器的事实而非秘密——存它就像存 `dshHome`——使用时读取把文件被移动变成 `verify`/`connect` 时封闭、可处置的 `KEY_FILE_READ_FAILED`，而不是留下一份静默过期的密钥副本。内联粘贴材料保持一次性 `AuthSecrets` 与凭据存储规则。
- 从客户端播种对话框（浏览器传 `~/.ssh`）：否决，对话框属于 Host，要紧的家目录是 Host 账户的；种子在宿主侧计算。
- 经跨包槽位复用 browse 目录选择器表面（中间切的 `remoteHosts.keyDirectoryFlow` 第三个洞）：否决；它让选择器包依赖 ui-remote-hosts，交互却更差——只列目录，操作者还得手工补全文件名。具名列表 RPC 保持线上词汇封闭、依赖图扁平、拾取落在具体文件上；选择器包回到两洞注册。

## 后果

密钥选择处处跟随组合出的交互，且始终发生在正确的机器上：操作者坐在 Host 显示器前时走 `native`，`browse` 组合（远程、无头或经 SSH 启动的 Host 的常态）走应用内密钥文件浏览器，手动输入路径或粘贴始终可用。win32 COM 增量（槽位 11 `SetDefaultFolder`、shell32 解析）经既有 bindings/worker 假件测试；真实 COM 路径只在真实 Windows 宿主上运行，与既有选择器的测试姿态一致。

已保存的密钥登录从此引用宿主本地文件；文件被移动或删除会在下一次 `verify`/`connect` 以 `KEY_FILE_READ_FAILED` 显现，只改口令也不再重写已存的密钥材料。Electron 外壳与自有 Host 子进程之间的 IPC 协议增加 `file-pick`/`file-result`/`file-cancel`，精确键校验镜像目录消息。

验证位于：native-picker 套件（各平台文件适配器、播种与丢弃起始目录、AppleScript 转义、取消）、win32 对话框逻辑/bindings 套件（文件模式选项、`SetDefaultFolder` 成功/失败/退化、worker 模式与播种）、桌面 Host 组合与生命周期套件（回调穿线、关联 `file-result`、中止）、remote-hosts coordinator 套件（三种探针如实上报、拾取成功、取消、选择器不可用、路径制 verify/upsert/connect 端到端含读取失败）、secrets 套件（路径存储、使用时读取、大小与读取界限）、typert 名册、keyfiles 套件（默认起始、排序、符号链接归类、条目上限、不可读层级），以及密钥浏览器与浏览器视图套件（按探针路由的入口、层级导航与具体文件拾取、陈旧结算失效、手动粘贴互斥、共享凭据字段映射、`KEY_*` 与连接原因本地化、Escape 抽屉）。
