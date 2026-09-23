/**
 * Browser panel plugin, node half. Pure UI plugin: the empty apply exists so
 * the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json dsh client
 * declaration. The navigation policy and the page lifecycle belong to
 * `@deepseek-ai/dsh-api-browser-controller`, which runs the browser process on
 * the host.
 */

/** Host plugin body — no host-side behavior for this source plugin. */
export function apply(): void {}
