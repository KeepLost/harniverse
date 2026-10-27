/**
 * Process-entry filesystem threadpool floor. Import this module FIRST from
 * every host-process bin: the Node libuv threadpool (default four threads)
 * backs every filesystem operation in the process, so one wedged network
 * mount can starve all concurrent workspace inspection for every connected
 * client. The floor is raised before any filesystem call runs — the pool
 * sizes itself lazily on first use — and an explicit operator setting always
 * wins.
 * @module @deepseek-ai/dsh-app-boot/threadpool-floor
 */

/** The raised pool size this module installs when the operator set nothing larger. */
export const THREADPOOL_FLOOR = 16
const current = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10)
if (Number.isNaN(current) || current < THREADPOOL_FLOOR) process.env.UV_THREADPOOL_SIZE = String(THREADPOOL_FLOOR)
