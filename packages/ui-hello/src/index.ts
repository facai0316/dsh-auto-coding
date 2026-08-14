/**
 * ui-hello plugin, Node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader; the browser half ships via
 * `exports["./client"]`, discovered through the package.json `dsh.client`
 * declaration (`{ inject, platform: "web" }`).
 */

/** Host plugin body — no host-side behavior for this UI plugin. */
export function apply(): void {}
