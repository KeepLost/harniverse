# `@deepseek-ai/dsh-sandbox-ssh`

[English](README.md) | 中文

在执行机器上解析沙箱 argv，并向 Host shell Consumer 返回执行完整性和拒绝方言。远程 Runner 继续采用失败关闭策略。

## 模型体验

通过 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md) 与 [`dsh-tool-bash`](../../shell/tool-bash/README.md) 间接影响；二者渲染此远程提供方的执行判定与拒绝签名，而运行器选择保留在机器侧。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **只返回判定**：该提供方解析 argv 并报告执行完整性与拒绝方言；远端沙箱 Runner 的安装、升级与校验仍由部署方负责，Runner 无法解析时失败关闭。
- **仅支持 POSIX 远端**：继承 `dsh-ssh` Helper 的 exec、信号与 pty 假设；Windows 执行机器不在范围内。
