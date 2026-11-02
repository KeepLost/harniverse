/**
 * Shell backend settings plugin, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader; the browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration. The stored preference is resolved by the app boot
 * bridge into `$DSH_SHELL_BACKEND` on the next start
 * (`@deepseek-ai/dsh-shell-backend-settings`).
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
