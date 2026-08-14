# auto-coding-plugins

Out-of-tree **dsh (Cordis) 插件包** 仓库：pnpm monorepo，一个目录一个插件包，构建产物可挂载进任意 dsh 部署的 profile。

首个包 `@auto-coding/ui-hello` 是界面类插件的最小可运行样板：在 Web GUI 侧边栏脚部（`sidebar.footer.action`，list 型 Slot、零替换风险）注册一个自包含的计数按钮。

## 目录结构

```
.
├── package.json            # 私有根，workspace 脚本
├── pnpm-workspace.yaml     # packages/*；storeDir 指入仓库内（沙箱内 $HOME 只读）
├── tsconfig.base.json      # 严格 TS（bundler 解析、react-jsx、noEmit）
├── vitest.config.ts        # packages/*/tests/**/*.test.ts
├── scripts/
│   └── tsdown.client.ts    # 共享打包 preset：Node 半 + 浏览器半（见下）
└── packages/
    ├── ui-hello/           # @auto-coding/ui-hello：侧边栏脚部按钮（list Slot 样板）
    └── ui-requirements/    # @auto-coding/ui-requirements：顶部会话视图 tab「需求面板」
        │                   #   conversation.view（list Slot，与 chat/trajectory 同环），
        │                   #   面板为内存态需求清单（添加/勾选/删除）
        └── …
        ├── package.json    # exports + dsh.client 声明 + peer 依赖
        ├── tsdown.config.ts
        ├── src/
        │   ├── index.ts            # Node 半（host Loader 从 cordis.yml 行导入）
        │   └── client/             # 浏览器半（Slot UI + CSS Module）
        └── tests/
```

## 常用命令

```sh
pnpm install      # 安装（store 在 .pnpm-store/，已 gitignore）
pnpm typecheck    # 各包 tsc --noEmit
pnpm build        # 各包 tsdown → lib/index.js + lib/client.js
pnpm watch        # 并行 watch
pnpm test         # vitest
```

## 插件包规范（每个 UI 插件两份产物，并排放在 lib/）

- **`lib/index.js`** — Node 半。纯 UI 插件就是一个空 `apply()`，它的存在使插件能作为 cordis.yml 的一行被 Loader 挂载。
- **`lib/client.js`** — 浏览器半。**不是**普通 ESM bundle：它是闭包工厂产物，脚本执行只调用
  `window.__ModuleLoader__.load({ id, factory })`，模块体在物化时运行；平台模块（react、cordis、ui-slots、ui-primitives、web-react、schema-form、ui-attachment）通过注入的 `require` 从冻结模块表解析，其余依赖全部内联，`*.module.css` 由 lightningcss 编译为哈希类映射并自带 `<style data-plugin>` 注入。

  该格式由 `scripts/tsdown.client.ts`（移植自 deepseek-harness 的 `packages/client/tsdown.client.ts`）保证；其中 `PLATFORM_MODULES` 列表须与部署的 `@deepseek-ai/dsh-client-web/src/platform.ts` 保持同步。

- **`package.json` 必须声明**：
  - `exports["."]` → `lib/index.js`，`exports["./client"]` → `lib/client.js`；
  - `dsh.client`：`{ "inject": ["@deepseek-ai/dsh-client-ui-slots", …], "platform": "web" }` —— host 侧 client 模块扫描据此发现浏览器半（`inject` 是 boot 图的依赖边，`immediately: true` 可选表示首屏预取）；
  - `peerDependencies`：部署侧提供 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`react` 等，**不得**打进 bundle。

- **client 代码规则**：服务用 `export const inject = ['slots', …]` 声明硬依赖后走 `ctx.slots`；Slot 注册用 `ctx.slots.inject(name, () => ctx.slots.register({ name, id | key, order?, label? }, Component))`；跨插件协作只走 cordis 服务（打包期有纯度门禁，`@deepseek-ai/*` 值导入非平台模块直接报错）。

## 依赖说明（重要）

- `@deepseek-ai/dsh-client-*` npm 发布集不完整（如 `dsh-compact`、`dsh-user-interaction` 未发布），从 npm 安装其依赖树会 404。
- 因此 `packages/*/devDependencies` 里的 DSH 包全部用 `link:` 指向本地 harness 检出（默认 `/root/workspace/deepseek-harness`），**仅作类型来源**（本仓库对它们只有 type-only import，产物里一律被 external 或擦除，不影响任何运行时）。
- 运行时依赖以 `peerDependencies` 由部署侧满足；换检出路径时改各包 `package.json` 里的 `link:` 目标即可。

## 挂载进 dsh（以本机 web profile 为例）

**推荐：`link:` 符号链接 + client-hmr 热加载回路**（本机已按此安装 `ui-requirements`）：

1. 符号链接进 profile 的 node_modules，并在 profile `package.json` 的 `dependencies` 登记 `"@auto-coding/<name>": "link:<repo>/packages/<name>"`：

   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules/@auto-coding
   ln -sfn $PWD/packages/ui-requirements ~/.dsh/profiles/web/node_modules/@auto-coding/ui-requirements
   ```

2. `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: ui-requirements
         name: '@auto-coding/ui-requirements'
   ```

3. 重启该 profile 的 `dsh web`（插件行的增删只在重启时生效；bundle 内容变化走 HMR，无需重启）。

### 前端式热加载开发回路

`client-hmr`（web-app bundle 自带）每 500ms stat-poll boot 图里每个 `dsh.client` 包的 `lib/client.js`。配合符号链接，回路是：

```
保存 src/client/*.tsx / *.module.css
  → 仓库根 pnpm watch（tsdown --watch，改样式只动 CSS Module 也会触发整包重建）
  → lib/client.js 变更 → client-hmr 重哈希 → SSE 推送
  → 浏览器免刷新热替换插件（含 <style> 标签整体换掉）
```

即改 `RequirementsPanel.module.css` 保存后约 1 秒内页面就地更新，无需刷新。

> UI 插件必须走「包安装」方式（host 要解析 `exports["./client"]`）；`./plugins/xxx/index.mjs` 相对路径行只适合 host-only 插件（如 web-gate）。用 `file:` 安装会**复制**包体，热加载回路随之失效，故用 `link:`。

## 新增一个插件包

```sh
mkdir -p packages/<name>/src/client packages/<name>/tests
# 复制 ui-hello 的 package.json / tsconfig.json / tsdown.config.ts 改名，
# tsdown.config.ts 里换成新包名；根目录 pnpm install 后即可 build。
```
