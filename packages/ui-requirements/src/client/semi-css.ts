/**
 * Semi Design's compiled stylesheet (all components, ~800KB min). Physical
 * file only — semi-ui's exports whitelist does not expose the `dist/css`
 * subpath, so this imports it via a relative path (exports restrictions
 * apply to bare specifiers only). The shared tsdown preset's plain-css
 * handler resolves it, inlines the text, and injects a
 * `<style data-plugin>` tag at factory execution.
 */
import '../../node_modules/@douyinfe/semi-ui/dist/css/semi.min.css'
