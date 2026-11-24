# Agent Note：通过 inspect 显式选择 PTC 输出

Status: implemented

[English](2026-11-23-ptc-explicit-output.md) | 中文

## 问题

PTC 程序此前只能以捕获的 console 文本加完成值的形式呈现输出：`run_code` 工具把返回值渲染进模型上下文，程序若获取了庞大的中间结果，要么以完成值形式返回一个精简子集，要么全部打印。嵌套 `read_image` 获取的图像完全无法到达模型——嵌套派发内容只进会话日志，外层结果不携带任何图像通道。

## 决策

TypeScript `run_code` 程序通过顶层 `inspect(...values)` 全局选择文本、对象与图像。字符串直接渲染；其他值经 Node 的 `util.inspect` 渲染，不受深度、数组长度或字符串预览限制，因此 undefined 属性、Error 对象与循环引用保持可见。运行时自有的 `Image` 类携带已存附件的持久引用及其程序可读路径；Node 格式化通过 Image 检视钩子收集数组与对象内部到达的图像，每次格式化调用持有自己的收集器。文本与被选图像在同一个有序输出序列中交错，说明性文字保持在它所描述图像的旁边。

执行方请求 `discardCompletion: true`，完成值在 JSON 校验前即被丢弃，`run_code` 只以捕获输出作答——此前的渲染值通道从工具 schema 与结果中移除。直接使用运行时的 workflow 等消费方在未设置该选项时仍获得完成值。

宿主绑定可返回 `PtcImage`（嵌套 `read_image` 恰好以此形式返回一张图像）或 `PtcInspectableValue`：对象/数组值类型的工具结果在未被改动地直接检视时按该工具面向模型的文本渲染，程序仍持有该 JSON 值。seam 的保留绑定全局名在 `console` 之外新增 `inspect` 与 `Image`，命名空间列表在 Node 与 Python 后端间保持可移植。

Node 环境在完整原生 console 之外提供 `inspect`；原生 console 方法保持 Node 自身的格式化，其 stdout/stderr 写入进入捕获输出序列。Python 以 `print` 作为选择机制，并同样获得 `discardCompletion` 选项与有序输出片段；片段拼接同时修复了 `print` 此前产生的双换行。

外层结果在原组合字节预算下携带有序 `PtcOutput` 片段——文本或持久图像引用；ledger 整体收纳图像并保留文本前缀，截断丢弃后续输出而不取消执行，最终化的 `run_code` 内容在规范 logs-only 值之外把被检图像与文本交错渲染。运行时自身实验性 Node 特性产生的警告被过滤出程序输出。

## 备选方案

**在打印输出旁显示完成值。** 末尾表达式将同时控制上下文准入与程序控制流；在校验前丢弃它，程序可以以任意内部值结束，同时显式选择更小的可见结果。

**自动转发每一张获取的图像。** 获取即意味着模型上下文成本，即使程序需要多张图像只为选出一张；显式检视让文本与图像遵循同一选择规则。

**用独立对象遍历发现图像。** 独立遍历必须复制 Node 对集合、symbol 与自定义格式化器的处理，且可能发出文本表示中不存在的图像；Image 钩子把收集绑定到 Node 自身的格式化上。

**被检值的有界预览。** 条目与字符串预览限制可能省略程序显式选择的文件内容；移除它们让被选内容在共享输出预算内保持完整。

**保留五方法 console 垫片。** 缺失的绑定与不完整的替换会破坏程序代码与导入库；原生 console 保留 Node 的方法，同时提示引导通过 `inspect` 选择输出。

## 后果

程序显式选择下一次模型请求所需的输出，包括图像比较与选定的嵌套结果。嵌套 `read_image` 仍执行存储与处理工作；选择只控制其对模型的呈现。运行时持有进程局部图像身份（伪造同属性对象不会获得访问）；工具执行方持有附件引用与可读路径投影（附件存储的 `imageHostPath`，经文件系统提供方映射）。文本与图像元数据共享外层输出预算；`output-limit` 仍是必需完成值的失败。程序保留的 Image 随其所属进程的生命周期结束，已存附件则遵循附件存储的生命周期。

## 验证

Node 运行时：bootstrap/json-wire/output-ledger/process/process-main/persistent\* 套件覆盖 inspect 渲染、图像收集与重入、绑定检视元数据、片段记账、`discardCompletion` 与原生 console。Python 运行时：片段输出、丢弃与边界套件。执行方：inspectable 适配、不可读图像拒绝、交错最终化与丢弃契约；spill 测试锚定截断成功的沉降；无密钥快照（acp、headless、web、python-sdk）已按 inspect 契约重录。

## 偏离记录（harniverse）

移植自官方 `explicit-ptc-output` 线（2026-11-09 注记）。有意偏离：保留可移植保留字约定（不含 `$`、跨后端共享保留全局名），因为本树交付 `ptc-runtime-python`（上游已删除）；未移植 `substituteProgramImages`（MCP 图像内容替换进程序值）——本树 MCP 工具将图像块降级为文本占位符，不存在生产方；官方 `projectContent` 钩子由本树已有的 `finalizeContent` 契约承担；run_code 截断提示保留在规范 logs 值内，而非仅渲染的细节文本。
