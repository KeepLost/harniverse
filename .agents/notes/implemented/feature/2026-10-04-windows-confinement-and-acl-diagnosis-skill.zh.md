# Agent Note：Windows 登记工作区隔离与两步 ACL 诊断 skill

Status: implemented

[English](2026-10-04-windows-confinement-and-acl-diagnosis-skill.md) | 中文

范围：`packages/sandbox/sandbox-windows-acl`（`src/token.ts`、`src/acl.ts`、`src/grant.ts`、`src/index.ts`、`src/runner.ts`、`src/acl-skill.ts`、`assets/diagnose-windows-sandbox-acl/`）、`packages/sandbox/sandbox-local`（`Config.confinedWorkspaces` 与 `src/index.ts` 中的 skills 接线）

## 问题

官方同步蓝图行 R15/R16（条目 X10）：上游把它的 Windows ACL 后端无条件降为 Low integrity——每次受限运行都会改写工作区的 SACL——并捆绑一个单命令 skill，在一次经批准的未受限运行中同时诊断并修复 ACL 问题，随后还请求用户把会话作为反馈发送。这两个形态都与 Harniverse 的契约冲突。[ACL 后端设计](2026-08-08-windows-acl-restricted-token-sandbox.md)交付时常驻复用 ACE 已落在操作者自己的工作区上，无条件应用标签会在下一次授权时持久改写每个既有工作区的安全描述符；而我们的批准纪律把只读观察与扩权限写入分开。write-restricted 交集还留下两个已记录的缺口：经父目录 `FILE_DELETE_CHILD` 权限授权的删除，以及环境 DACL 写入（Everyone、硬链接）进入令牌自身级别本应保护的对象。

## 决策

- **登记按工作区选择加入。** `dsh-sandbox-local` 的 `confinedWorkspaces` 配置（默认 `[]`）列出绝对工作区根目录，与会话解析出的根目录做不区分大小写（双侧小写化）的比较；相对或空条目在构造时失败。未登记的根目录逐字节保持登记前行为：runner argv 中没有 `--low-integrity`，只应用 DACL，不启用标签机制。
- **令牌一半。** `restrictTokenIntegrity`（`src/token.ts`）把受限令牌降为低完整性（Low integrity，`S-1-16-4096`，经 `SetTokenInformation`/`TokenIntegrityLevel` 携带 `SE_GROUP_INTEGRITY`），关闭环境 DACL 缺口：即使 Everyone 授权允许写入，Low 令牌也无法向上写入中完整性对象。以 `AclSandbox` 选项 `lowIntegrity` 与 runner 标志 `--low-integrity`（两种模式）暴露；与模块内每个令牌编辑一样 fail-closed。
- **授权一半——单次合并。** 登记根目录上的每次授权在**同一次** `SetNamedSecurityInfoW` 调用中应用：能力 ACE、目录 SACL 上常驻可继承的 Low no-write-up 强制标签（`AddMandatoryAce`、`SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`），以及一条容器继承的 Everyone 对 `FILE_DELETE_CHILD` 的拒绝——能力 ACE 自身的 DELETE 位由此成为根目录内唯一的删除授权。拒绝项只继承到容器：该权限在目录上评估，把它的位继承到文件会拒绝根目录内每一次 `FILE_ALL_ACCESS`/`GENERIC_ALL` 打开。`AclWriteGrant.create(sid, { confined: true })` 携带 seam 侧物化所需的 `lowLabelSid`/`worldSid` 对。
- **持久效果与升级路径。** 标签与拒绝项是按设计在进程之外存续的常驻目录改动——与能力 ACE 同一复用缓存。取消登记会让新的授权不再携带它们，但不会移除已经常驻的内容；受限撤销只有在目录上不再剩任何其他能力授权时才清除标签。幂等跳过要求精确的 ACE、拒绝项**和**标签三者齐备，因此登记机制之前留下的常驻授权会在下一次受限供给时获得标签与拒绝项，而无需重新传播整棵树。受限授权额外要求被授权目录上的 `WRITE_OWNER`（标签位于 SACL；所有者隐式权限只覆盖 `READ_CONTROL` 与 `WRITE_DAC`）——完全控制的工作区目录，即通常情形，两者皆已满足。
- **两步诊断 skill（技能）。** `diagnose-windows-sandbox-acl`（`assets/…/SKILL.md` 与 `scripts/diagnose-windows-sandbox-acl.ps1`）经 win32 门槛的 `ctx.inject(['skills'])` 向 skill 注册表注册（仅当没有操作者 `runnerCommand` 覆写后端时）。第一步是受限的只读工具调用——报告写在工作区内；第二步在诊断证明需要修复时，把打印出的 `REPAIR_COMMAND` 带 `-Repair` 在另行批准下未受限运行。预期中的隔离拒绝只解释、不修复；每次改动都有备份并经重读验证；中途停止的运行仍欠用户一个决定。

## 对官方的偏离

- **门槛隔离 vs 无条件隔离。** 官方对每次受限运行应用 Low 标签（其 sandbox-local 不暴露登记配置）；Harniverse 把令牌降级与标签／拒绝项编辑都关到 `confinedWorkspaces` 门槛之内，因为其效果是对操作者所属目录的持久改写。
- **两步 vs 单次批准运行。** 官方 skill 没有模式——一条经批准的未受限命令在同一次运行中诊断并修复；我们的诊断作为工具调用本身在受限下运行，只在诊断证明需要修复时另行请求批准，因为扩权限写入值得单独一次批准。
- **不上传反馈。** 官方 skill 请求用户把会话作为反馈发送；我们不上传任何内容——报告文件留在磁盘上归所有者所有。

## 备选方案

**照官方一样无条件隔离。** 否决：标签与拒绝项是常驻改写；在下一次授权时静默改写每个既有工作区的 SACL 不是 Harniverse 可以替操作者做的决定——登记权在操作者。

**只加标签、不加环境删除拒绝。** 否决：父目录 `FILE_DELETE_CHILD` 缺口在完整性标签下依然存在；登记根目录内的删除授权必须收敛到能力 ACE。

**单独一次标签应用调用。** 否决：每次授权多一次 `SetNamedSecurityInfoW` 会让急切全树传播翻倍，且授权+标签不再是原子操作；一次合并应用同时携带 DACL 与 SACL 改动。

**每次受限撤销都清除标签。** 否决：同一目录上可能还常驻着另一条能力授权；此时清除会剥夺剩余授权的写入所依赖的标签，因此标签只随最后一条能力授权离开。

**照官方 skill 一样单次批准运行。** 否决：受限的只读诊断不需要任何扩权；把修复折叠进去会让一次批准同时覆盖观察与扩权限写入。

## 后果

登记工作区获得缺失的两项删除与环境 DACL 保护（Low 令牌 + 删除授权唯一化为能力 ACE 的根目录），代价是操作者选择加入的持久 SACL/DACL 改动，且取消登记不能完全撤销（取消后再供给会留下常驻项；标签只随最后一次能力撤销清除）。未登记的部署在登记之前察觉不到任何变化。诊断 skill 让观察留在沙箱内，只在每次修复运行中扩权，报告保留在本地而不上传。

## 验证

- `packages/sandbox/sandbox-windows-acl/tests/acl-confinement.spec.ts`：受限授权在同一次 DACL+LABEL 应用中合并拒绝项+标签与能力 ACE；遗留授权保持逐字节 DACL-only；幂等跳过要求授权+拒绝项+标签；遗留常驻授权的升级路径；受限撤销只在最后一条能力授权离开时清除标签、在外来授权仍在时保留它；遗留撤销绝不触碰标签。
- `token-failure-paths.spec.ts`／`grant-failure-paths.spec.ts`：新增 Win32 调用按命名错误 fail-closed。
- `acl-skill.spec.ts`、`skill-composition.spec.ts`、`diagnose-script.spec.ts`：注册表注册与 HMR dispose、经真实组合验证的打包内容、`-Repair` 是唯一的变更闸门、保留单次运行原版的边界与回滚机制、两步流程的文档不含任何上传请求。
- `packages/sandbox/sandbox-local/tests/acl-grants.spec.ts`：默认配置保持未受限（无 `--low-integrity`、遗留授权——默认关闭）；登记工作区在每种策略形态下受限、授权以 confined 创建；未登记的兄弟工作区保持未受限；相对 `confinedWorkspaces` 条目在构造时失败。
- 真实内核证明仍归 win32 通道：`windows-native` 作业（`check:ci:windows-complete`）与 wine 通道（`check:windows-wine`）。
