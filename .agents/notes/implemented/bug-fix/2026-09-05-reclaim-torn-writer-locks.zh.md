# Agent Note: 在所有平台上回收残缺的 writer lock

Status: implemented

[English](2026-09-05-reclaim-torn-writer-locks.md) | 中文

## Problem

获取 owner-only writer lock 时，对陈旧持有者的回收是先删除 owner 文件、容忍目录删除阶段一次瞬态 `ENOTEMPTY`/`ENOENT`，然后重试候选 rename。该重试只在 POSIX 上成立——POSIX 的 `rename` 可以替换已存在的空目录。在 Windows 上 rename 无法替换已存在目录，重试会重新读取一个 owner 文件已被回收者自己删除的 lock 目录，把它归类为 invalid writer lock 并中止获取：一次瞬态删除错误就可能让锁永久搁浅。

## Decision

`readLockOwner` 现在区分**残缺**（torn）lock 目录（完全没有 owner 文件——处于“已删 owner 文件、尚未删目录”之间的写入者，不可能有存活持有者）与**结构无效**（多个 owner 文件、记录畸形、文件名不匹配——仍然立即大声报错）。获取循环会清除残缺目录（带同样 `ENOENT`/`ENOTEMPTY` 容错的 `rmdir`，并受既有锁 deadline 约束）后重试，使下一次候选 rename 在所有平台上都能取得锁。结构损坏保持立即的 `invalid writer lock` 拒绝。

## Alternatives considered

**回收一切无效锁。** 拒绝：多余或畸形的 owner 文件可能属于存活的外来写入者，既有契约是立即暴露结构损坏而不是猜测。

**用递归 `rm` 替换“先文件后目录”的两步删除。** 拒绝：它会删掉两步之间被外来写入者重新取得的锁目录，破坏释放路径保持的替换锁保证。

**把该故障当作测试问题并在 Windows 通道跳过。** 拒绝：锁搁浅是真实的获取缺陷，不是测试装置伪影。

## Consequences

删除陈锁时的瞬态失败不再让 Windows 上的获取搁浅；释放两步之间崩溃的进程也能在所有平台上被下一个获取者恢复。残缺清理共享锁 deadline，永远无法清除的残缺会像存活持有者一样超时。`torn writer lock` 分类是 `authentication-local` 私有文件锁的内部语义，不改变任何持久化格式或线上契约。
