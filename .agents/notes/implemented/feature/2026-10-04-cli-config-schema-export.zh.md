# Agent Note：CLI 配置 schema 导出 —— 免启动的组合 profile JSON Schema

Status: implemented

English | [中文](2026-10-04-cli-config-schema-export.md)

范围：`packages/boot/app-boot/src/config-schema/*`、`apps/cli/src/dump-config-schema.ts`、`apps/cli/src/args.ts`、`apps/cli/src/bin.ts`

## 问题

`dsh --dump-config` 以 YAML 打印组合后的配置树，但没有任何东西离线回答「每个插件的 `config` 可以包含什么？」：编辑器、校验器与 patch 作者只能读插件源码，或者启动后靠失败来发现。官方 4eb26f0e71 正为此提供了配置 schema 导出；吸收它意味着把该能力映射到 Harniverse 的加载器解析与 fail-loud 模型上，而不是照搬上游的运行期拦截。8c146d978f 提出的面向模型的实时 Config 查询仍被拒绝，本导出也刻意不是它的复活。

## 决策

- **`generateConfigSchema(profile, layers)`**（app-boot 的 `src/config-schema/`，连同 `ConfigSchemaDump`、`NativeConfigSchema`、`createConfigProjector`、`LOADER_EXPRESSION_SCHEMA`、`ConfigProjection`、`isNativeConfigSchema` 从包根再导出）：用与启动相同的 `composeEntries` 组合调用方的各层，遍历条目树（include 文件按字面读取并持有自己的解析基准与 patch 索引、循环即拒绝、展开 `cordis:group`/`cordis:include` 载体且禁用载体不声明子项），经 `ModuleLoader.fromInternal()` 导入每个具名插件——裸名经由 profile 旁由启动器维护的扁平回退目录解析，与启动完全一致——并将其原生 Schemastery 图（`Config` 导出或 lazy builder 结果，经 `Symbol.for('schemastery')` 校验身份）投影为 JSON Schema 2020-12。`createConfigProjector` 只用 Ajv 校验字面默认值；`@eslint-community/regexpp` 判定哪些原生 pattern 在 Unicode JSON-Schema 语义下仍然可移植；一切无法静态判定的语义（loose 回退、transform 回调、会改写输入的 union 分支、非有限边界、lazy 元数据传播、UTF-16 长度语义）都会放宽生成的校验，并以逐条目 `partial` 状态的警告诊断落地。
- **执行立场。** 插件绝不被应用，`!!js` 绝不被求值——表达式值位置与惰性的 `#/$defs/loaderExpression` 标记取并集。导入、`Config` getter 与惰性 schema 构建器会执行：收集过程运行的是可信模块代码，与启动同等信任，这正是该能力位于 CLI 与库 API 之后、而非模型可见界面之后的原因。
- **完整性是显式的，绝不猜测。** 只要存在 error 级诊断、任一条目为 `partial`/`unsupported`/`error`，或某一插件名解析到多个不同的 schema（取并集并给出警告，因为解析取决于所属树），`x-cordis.complete` 即为 `false`。`x-cordis.entries[]` 记录每一行的状态与 `configRef`；`x-cordis.patchSchema` 指向 `$defs.patchList`；根树 id 目标的 patch 规则由当前索引生成。
- **CLI 模式。** `dsh --profile <name> --dump-config-schema [--patch <file>]...`（也可用于 `dsh web` 之后）把文档作为唯一的 stdout 输出——生成期间插件的 stdout 被重定向到 stderr——诊断写入 stderr，文档不完整时退出码为 1；该 flag 与 `--dump-config`、`--dump-default-config` 互斥，profile 准备与 YAML dump 一致（随附 profile 自动初始化；包含用户层）。
- **相对 4eb26f0e71 的适配**，每一条都由既有的 Harniverse 契约决定：
  1. 没有 `RuntimeResolution`/运行期 Schemastery 拦截——收集依托启动自身使用的加载器解析模型（`ModuleLoader.fromInternal()` 加扁平回退）；
  2. 没有 skipped-bundles 诊断——`loadProfile` 对没有组合包声明的列名包直接报错，不存在被静默跳过的集合可报告；
  3. 没有 `--from-default-profile`——`loadProfile` 会从模板自动初始化缺失的随附 profile，因此 schema dump 与 YAML dump 一样准备 profile，无需合成默认组合；
  4. 没有 volatile-schema 复查——锁定的 Schemastery 3.18.1 没有 volatile schema 可复查；
  5. 相对 `insert` 名称保持相对——解析属于所属 Loader 树，文档只描述名称而不改写。
- **依赖**：`ajv` 与 `@eslint-community/regexpp` 是 app-boot 的运行时依赖；`@deepseek-ai/schemastery` 仅用于开发（身份与类型）。

## 备选方案

**上游的运行期 Schemastery 拦截。** 否决：它靠在真实启动中钩住 schema 构造来收集；我们的组合在不应用插件的情况下解析模块，扁平回退模型已让收集获得与启动相同的解析。

**面向模型的实时 Config 查询（8c146d978f）。** 维持拒绝：它会从模型可见界面执行插件模块代码，而静态导出把可信代码边界留在 CLI/库接缝上，交给模型工具的是一份文档。

**原样输出 Schemastery 图。** 否决：带显式 `x-cordis` 注记的 JSON Schema 2020-12 与校验器无关、可与 `!!js` 位置组合，并把自身限制记录为诊断。

## 后果

编辑器与 CI 无需启动即可依一份导出文档校验 profile 与 overlay YAML；不完整性是一个信号（`x-cordis.complete`、诊断、退出码），而不是一份错误的 schema。代价：收集时执行可信模块代码，且投影在原生语义有副作用处刻意保持部分——两者都由文档自身声明。

## 验证

- `packages/boot/app-boot/tests/config-schema.spec.ts`：有序组合诊断、命名空间/类 Config 序列化（描述、默认值、共享引用）、禁用/条件/匿名行、absent/unsupported/error 区分（导入失败、Config getter 失败、非原生 Config）、递归引用与 lazy builder 失败不丢兄弟条目、绝不调用原生校验与序列化钩子、group 遍历不把普通配置数组当树、按树基准识别外部规范化 Include/Group 别名、报告未知树载体、按自身目录与 patch 索引读取字面 include、`initial` 在内存中展开、循环（包括经目录符号链接）、坏行保留有效兄弟及原位、休眠载体、针对当前索引的 patch 规则（last-id 优先、排除 include 局部 id、丢弃过期约束）、多解析名称显式取并集。
- `packages/boot/app-boot/tests/config-pattern.spec.ts`：Unicode 正则语义下的 pattern 可移植性。
- `apps/cli/tests/dump-config-schema.spec.ts`：完整文档接受已知良好组合并拒绝错误配置值、可信 stdout 噪声不进 JSON 文档、不支持的 Config 输出带位置的 stderr 诊断并把退出码置 1、未命中的 overlay 目标作为警告而不使 dump 失败。
- `apps/cli/tests/args.spec.ts`：三个 dump flag 的互斥与子命令对父级选项的拒绝。
