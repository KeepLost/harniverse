# Agent Note: 面板浏览器与终端交付了任何部署都无法使用的默认值

Status: implemented

[English](2026-09-23-panel-browser-and-terminal-unusable-defaults.md) | 中文

## Problem

两个 host 面板都以全绿交付，而在 Harniverse 实际运行的姿态下都无法使用。

浏览器面板对每一个目标地址——任何 URL、每一次——都回答 `Remote invocation failed`。Chromium 的 zygote 在以 root 运行时若不传 `--no-sandbox` 便拒绝启动，而 harness 常见的容器姿态正是 root，交付的默认值却是 `sandbox: 'chromium'`，它永不传该标志。于是浏览器在打印 `DevTools listening on ...` 之前就退出，`readEndpoint` 以一个普通 `Error` 拒绝，而 [`packages/api/gateway/src/index.ts`](../../../../packages/api/gateway/src/index.ts) 中的 `rpcFailure` 把任何不是 `RemoteError` 的异常映射为不透明的 `Remote invocation failed`。唯一可据以行动的那一行——`Running as root without --no-sandbox is not supported`——只存在于浏览器的 stderr 中，谁也看不到。

终端面板运行着一个真实 shell，而它的 `clear` 静默地毫无作用。[`packages/subprocess/subprocess-local/src/index.ts`](../../../../packages/subprocess/subprocess-local/src/index.ts) 在每次 `node-pty` 分配上硬编码了 `name: 'dumb'`，而 node-pty 正是用该名字作为子进程的 `TERM` 发布，覆盖了 terminal-controller 叠加进 `spec.env` 的 `TERM: 'xterm-256color'`。在 `TERM=dumb` 下，`clear` 写出零字节并以 0 退出，`tput colors` 回答 `-1`，任何全屏程序都没有可驱动的能力——因此颜色、`clear` 与 curses 风格界面全部失效，且没有任何错误信息。一个消费方的正确选择（面向模型的 PTY 不希望转录中出现转义序列）被硬编码进了 provider 并强加于所有消费方，而这正是 [packages/AGENTS.md](../../../../packages/AGENTS.md) 所禁止的。

两个测试套件始终通过。`browser-panel.e2e.ts` 在自己的 overlay 中固定了 `sandbox: none`，因此该 lane 从未验证交付的默认值；也从未有任何测试询问终端拿到的 `TERM` 是什么。

## Decision

**沙箱依据 harness 自身的权限来决定。** `Config.sandbox` 现为 `BrowserSandbox = 'auto' | 'chromium' | 'none'`，默认 `'auto'`，由 [`packages/api/browser-controller/src/launch.ts`](../../../../packages/api/browser-controller/src/launch.ts) 中的 `sandboxDisabled(sandbox, uid)` 决定：`'none'` 始终传 `--no-sandbox`，`'chromium'` 从不传，`'auto'` 恰在 `uid === 0` 时传——因为那是 Chromium 唯一无法带着自身沙箱启动的情形。控制器读取 `process.getuid?.()`（在没有该调用的平台上为 undefined，即非 root），将其作为 `spec.uid` 传入，并在 `'auto'` 放弃沙箱时记录一条警告，使这一降级在 host 日志中可见，而不是靠推断。

**被拒绝的启动会报告浏览器说了什么。** `BrowserLaunchFailure` 携带浏览器 stderr 的末尾 800 个字符，所有启动拒绝路径（没有诊断流、端点超时、提前退出、中止）都抛出它。[`packages/api/browser-controller/src/index.ts`](../../../../packages/api/browser-controller/src/index.ts) 中的 `browserUnavailable(error)` 把任何尚不是 `RemoteError` 的异常——启动失败与 CDP 连接失败一视同仁——转换为 `RemoteError('browser-unavailable', 'The Session browser could not start: <detail>')`，于是面板显示的是原因，而不是 gateway 的内部兜底。

**终端类型归消费方所有。** `SubprocessTerminalSpawnSpec.term` 命名以 `TERM` 发布的 terminfo 条目。默认值仍为 `'dumb'`，使面向模型的 PTY 输出逐字节保持不变；`subprocess-local` 将 `spec.term ?? 'dumb'` 传给 node-pty，`subprocess-ssh` 转发它，SSH 协议的 `terminal` 对象承载它。terminal-controller——其 PTY 由人驱动——请求 `term: 'xterm-256color'`，并在 `spec.env` 中保留镜像的 `TERM`。

## Testing

browser-panel lane 不再放宽沙箱：容器以 root 运行该套件，因此承载启动的正是交付的 `'auto'` 默认值，而在那里固定 `none` 会再一次把这个 bug 藏起来。`allowPrivateAddresses: true` 仍是该 lane 唯一的放宽项。在同一容器中强制 `sandbox: 'chromium'` 会使该 lane 失败，这正是「该解析逻辑才是它能工作的原因」的反向证据。

`controller.spec.ts` 通过真实 argv 覆盖真值表（root + `'auto'` 传该标志、非 root 的 `'auto'` 不传、root + `'chromium'` 不传），并断言一个在打印 `Running as root without --no-sandbox is not supported` 后死亡的浏览器会把该文本呈现在 `browser-unavailable` 之下。

`subprocess-local` 中由一个真实 PTY 回答终端类型问题：分配终端、`printf` 出子进程的 `TERM`，读回默认的 `dumb` 与请求时的 `xterm-256color`。`terminal-panel.e2e.ts` 以用户的方式驱动面板——`tput colors` 得到 `colors=[256]`，随后打印一个标记，再执行 `clear`，然后该标记从渲染出的字符单元中消失。

## Alternatives considered

**在文档中声明 root 部署必须设置 `sandbox: 'none'`。** 即现状。这是 README 里一句正确的话，而每个 root 运维只有在面板已经以不可读的错误失败之后才会遇到它，且该失败既不点明这个设置，也不点明原因。

**在 `browserArgv` 内部通过 `process.getuid` 检测 root。** 会使这个纯 argv 构建函数依赖环境，并使非 root 情形在 root 机器上无法测试。将 `uid` 穿过 spec 传入，可把决策保留在一个有测试的函数里。

**保持 `'chromium'` 为默认值，只把错误信息做好。** 可读的错误仍然意味着面板不能用；部署姿态就是 root，而 Chromium 在那里没有可回退的沙箱模式。

**让 `spec.env.TERM` 决定终端类型。** node-pty 的 `name` 会覆盖 `env.TERM`，因此看起来权威的那个字段会静默落败。命名 seam 字段使「哪一个胜出」变得显式，provider 的 README 现在也这么写。

**将 `term` 默认设为 `'xterm-256color'`。** 会改变所有既有消费方的面向模型 PTY 输出——颜色与光标序列进入转录——这属于模型可见变更，需要各自的会话事件与快照工作。无能力的默认值保持不变；只有由人驱动的消费方选择退出。

## Consequences

root 部署开箱即得到可用的浏览器面板，代价是页面内容周围少了一层边界——该进程仍是 `ambientEnv: 'scrubbed'` 且 profile 隔离，而希望强制沙箱的运维可以固定 `'chromium'`，并得到一个可诊断的失败而非静默的失败。任何浏览器拒绝现在都以浏览器自己的原话到达用户，其中包含面板错误消息里的 stderr 文本。

PTY 接缝新增了一个字段，因此新的终端消费方现在必须决定自己交给程序的是哪一种终端；弄错是可见的（`clear` 与颜色要么可用要么不可用），而不是静默的。面向模型的 PTY 逐字节保持不变。

两个面板在测试套件通过的情况下交付，原因是每个 lane 都放宽或忽略了恰恰使它们无法使用的那个默认值。该 lane 现在运行交付的默认值，而 e2e 断言是针对用户的动作写的——输入 `clear`，期待屏幕被清空——而不是针对代码设置了什么。
