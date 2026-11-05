/**
 * Execution world settings plugin, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader; the browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration. The stored preference is resolved by the app boot
 * bridge into `$DSH_EXEC_WORLD` on the next start
 * (`@deepseek-ai/dsh-exec-world-settings`), degrading to the local family
 * when the VM provider probe is unhealthy.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
