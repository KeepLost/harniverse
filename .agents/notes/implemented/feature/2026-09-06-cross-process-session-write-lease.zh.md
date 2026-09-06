# Agent Note: 会话跨进程写租约

Status: implemented

[English](2026-09-06-cross-process-session-write-lease.md) | 中文

## 问题

JSONL 后端的写入串行化只在单个 `PersistenceCoordinator` 实例内排除第二个写入者。两个进程——两个 CLI 会话，或 host 与 SDK runtime 并存——可以接管同一条会话日志并交错 append，撕裂压缩 frame 和 seq 连续性。这个 seam 需要仲裁者位于所有写入者进程之外的持久跨进程写所有权，因为没有哪个写入者能活过所有故障模式。

## 决策

`SessionWriteLease`（packages/session/session-persistence-jsonl/src/lease.ts）在日志旁对 `session.lock` 持有内核锁：从会话第一次持久写入开始，直到协调器 retire 或删除该 id、或后端 dispose。POSIX 通过直接的 libc 绑定取非阻塞 `flock(2)`（src/posix.ts，与既有 win32.ts 绑定并列的 koffi FFI——与上游 `fs-ext` 的刻意分歧：保留一个 FFI 依赖，而不是引入 node-gyp 原生构建）；Windows 持有一个由规范锁路径派生的内核具名信号量（count 1，src/win32.ts 中的 `CreateSemaphoreW`）。争用映射为 `SessionAlreadyOwnedError`（定义于 `dsh-session-persistence` 协调器，与其他持久化错误一同再导出）；内核在持有者描述符或 handle 关闭时释放锁——包括任何进程死亡——因此崩溃的持有者绝不阻塞后继者，也不存在过期簿记：后继者的第一次写入随即运行既有的 torn-tail（撕裂尾部）恢复（`commitRepair`）。存活但卡死的持有者保留锁直到其进程退出：拒绝剥夺停滞 writer，因为其恢复的 append 会撕裂日志；在 POSIX 上，移除锁文件仍是该情形的显式弃权。由于 POSIX 锁针对 inode 而非路径，获取时会校验被锁 inode 仍是锁路径上的文件（针对重建文件的有界重试），且释放绝不删除锁文件，保留后续加锁者校验所需的稳定 inode。租约在 `appendBatch`/执行修复的 `commitRepair`/`deleteStored` 内惰性获取，位于 `rejectOppositeArtifact` 之后、第一次实体化写入之前——未实体化的会话不留下任何文件系统足迹。释放依托新的可选 `PersistenceBackend` 钩子 `releaseWriteOwnership(id)`：协调器在 retire 或删除丢弃状态后，于同 id 串行链内等待它完成；`close()` 释放在拆卸时仍持有的租约。仲裁原语可按次注入（`LeaseArbitration`），因此 Win32 信号量协议在 Linux 上可测，反之亦然。

## 备选方案

**带续约与 rename 抢占的 TTL 记录（上游最先实现，评审中替换）**——日志旁的 JSON 记录携带 owner token 与过期时间，按间隔续约，过期后原子 rename 接管。它能在所有文件系统上存活，但本质是微缩的分布式算法：续约计时器、失联检测、带再判定与归还的接管——且残余的多方竞态仍允许有界的双写者重叠（一个续约间隔）。内核仲裁连同这套机制一并删除。

**`fs-ext`（上游的 POSIX 选择）**——提供维护良好的 POSIX flock 绑定，但为已经拥有 win32 koffi FFI 的代码树新增 node-gyp 构建依赖；直接绑定 libc `flock(2)` 只需两行 koffi 声明，并让两个平台共用一个原生机制。

**`proper-lockfile`**——staleness-plus-touch 的 TTL 模型，保留 delete-then-recreate 接管竞态，用 mtime/inode 检测被破坏（弱于内核所有权），且 2021 年起未发布。

**Windows 字节范围锁 / 独占打开共享模式**——上游经 CI 证明后拒绝：`LockFileEx` 是强制锁，任何读取者触碰被锁文件即硬失败；`CreateFileW` 拒绝共享会在持有期间钉住锁文件名与目录，阻塞递归目录删除。具名信号量以零文件系统足迹保留内核仲裁。

## 后果

跨进程排他的代价：每个已实体化会话一个锁文件（释放刻意保留）、卡死持有者规则（卡住的进程阻塞该会话的写入者直至其退出）、以及从未 dispose 的上下文所持租约存活到进程退出——使用裸描述符而非 FileHandle，因此不会有任何对象在垃圾回收时被关闭。它换来即时崩溃恢复（无等待期）、零续约流量，并消灭了 TTL 设计管理而非预防的所有接管竞态。Advisory `flock` 在某些网络文件系统（NFSv3）上不可靠；位于此类挂载上的根会退化为仅进程内排他。修复 torn 会话的冷 `load()` 会取得租约并持有到 retire 或 dispose：读取进程已成为写入者，这正是修复所需的排他。删除存活会话的锁文件在 POSIX 上按设计弃权——harness 绝不这样做。上游浏览器 worker 的 fs-ext stub 在此处没有对应物：Harniverse 只在完整 host 进程中挂载该后端。
