# auto-coding-plugins

> 📌 **跨会话进度看这里：[`docs/PROGRESS.md`](docs/PROGRESS.md)** —— 完成/未完成状态、
> 重启与端到端走查清单、环境速查。继续工作前先读它。

Out-of-tree **dsh (Cordis) 插件包** 仓库：pnpm monorepo，一个目录一个插件包，构建产物可挂载进任意 dsh 部署的 profile。

首个包 `@auto-coding/ui-hello` 是界面类插件的最小可运行样板：在 Web GUI 侧边栏脚部（`sidebar.footer.action`，list 型 Slot、零替换风险）注册一个自包含的计数按钮。

## 📖 快速使用（安装 `@auto-coding/mega` 后）

本插件是 **dsh 编码流水线**（需求 → 决策 → 计划 → 编码 → 契约 → 审核 → 合并），
**必须配合 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
技能包使用**。完整文档在 [使用说明](packages/mega/assets/USAGE.md)（安装后也在
「自动化看板 → 使用说明」页可见），四步开工：

1. **配置数据库**：打开「自动化看板 → 配置」页，填好 pg 连接参数 →「测试连接」
   →「保存并应用」（热生效，无需重启）→ 点 **「迁移（建表）」** 补齐 `cm` 库 schema
   （迁移在 cm-flow 首次挂载时也会自动跑，按钮用于主动跑一遍看结果）。
2. **准备技能**：插件**不内置任何技能**（facai skills 是项目/组织特定的）——
   把 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
   拉到本地，将其 `.agents/skills/` 复制到项目根目录，再让 agent 运行 `/facai-init`
   技能生成项目配置（详细用法见其 GitHub 主页）。可选：worker 行配置
   `skillsSource`（`dir` | `git`）指向外部技能仓库。
3. **添加项目**：「自动化看板 → 项目」页「新增」：名称 / 本地路径 / Git 地址 / 平台 / PR Token。
4. **登记需求**：「需求」页「新增」并「开始执行」，worker 自动跑完整流水线，
   审核大厅处理 待审核 / 待决策 / 待合并。

一键安装（git 分发，零构建）：

```sh
dsh plugin --profile web add "git+ssh://git@github.com/facai0316/dsh-auto-coding.git#v0.3.0&path:/dist/mega"
```

安装后重启 `dsh web` 生效（四行插件由包内 patch 自动挂载）。

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
    ├── ui-requirements/    # @auto-coding/ui-requirements：顶部会话视图 tab「需求面板」
    │   │                   #   conversation.view（list Slot，与 chat/trajectory 同环）。
    │   │                   #   看板内部 tab：审核 / 项目 / 需求 / 运行 / 配置 / 使用说明。
    │   │                   #   「配置」页含数据库连接卡片（pg 链接编辑 + 试连 + 保存）；
    │   │                   #   「使用说明」页渲染 markdown 文档。
    │   │                   #   host 半（Typert Remote）：
    │   │                   #   pgconfig —— 读写用户层 cordis.patch.yml 的 db-pgmas
    │   │                   #   override（patch watcher 热生效，无需重启）+ 试连；
    │   │                   #   usage —— 返回使用说明 markdown（占位或 usagePath 文件）。
    │   └── …
    │       ├── package.json    # exports + dsh.client 声明 + peer 依赖
    │       ├── tsdown.config.ts   # 双端：host 两阶段（tsc 降装饰器 → tsdown）+ client preset
    │       ├── tsconfig.build.json # host 半 tsc 阶段（@Remote 装饰器降级）
    │       ├── src/
    │       │   ├── index.ts            # Node 半（Typert Remote + host Loader 导入）
    │       │   ├── patch-utils.ts      # 无装饰器的 patch 读写/校验（可被 vitest 直测）
    │       │   └── client/             # 浏览器半（Slot UI + CSS Module）
    │       └── tests/
    └── db-pgmas/           # @auto-coding/db-pgmas：host-only 工具插件（无浏览器半）——
                            #   本机 pg-mas PostgreSQL 16 docker 实例连接：
                            #   `pgmas` 服务（连接池 + query/目录内省 + 服务级写缝 withClient）+
                            #   pg_query / pg_schema 模型工具（全局注册，所有会话可见）+
                            #   `tool:pg-mas` 提示段（order 107）。
                            #   连接默认值（127.0.0.1:25678，user/db mas，库 mas/cm/facai，
                            #   默认只读守卫）在 src/index.ts 的 Config 里，行 config 可覆盖。
                            #
    └── cm-flow/            # @auto-coding/cm-flow：host-only 业务插件（无浏览器半）——
                            #   `cm` 库需求持久化 + 状态机，经 Typert Remote 暴露
                            #   `requirements` / `projects` / `questions` 三个命名空间。
                            #   domain/repo 在 src/repo.ts（无装饰器，可被 vitest/esbuild 直接测）；
                            #   src/index.ts 是 TypertRemoteService 壳（@Remote 装饰器）。
                            #   构建为两步：tsc 降级装饰器到 build/ → tsdown bundle 到 lib/
                            #   （rolldown 直转不会降级 TC39 装饰器，故不能单步 tsdown）。
                            #   schema 演进：_cm_flow_migrations 顺序迁移（v1 baseline、
                            #   v2 projects、v3 requirements.project_id、v4 ask_user_questions）；
                            #   固定 userId（Config 可覆盖）首次激活幂等植入 users 行（FK 目标）。
                            #
    └── cm-worktree/        # @auto-coding/cm-worktree：纯 Node git worktree 生命周期封装——
                            #   每任务一分支一 worktree（create/push/remove/isMerged/target 软链），
                            #   零 dsh 依赖，可对临时 git 仓库单测。
                            #
    └── cm-worker/          # @auto-coding/cm-worker：编码流水线 worker（host-only）——
                            #   timer 串行轮询：领取 open 需求 → 6 阶段 subagent 会话
                            #   （facai-* skill 注入，cwd=worktree）→ records 记账 →
                            #   决策续跑（waiting_reply）→ merge PR agent 任务 → 收尾清理。
                            #   编排逻辑在 src/pipeline.ts（纯依赖注入，可测）；
                            #   src/index.ts 是 cordis 服务壳（真实 subagents/agents/fs/worktree）。
    └── mega/               # @auto-coding/mega：**可分发的单包**（计划 10）——
                            #   db/flow/worker/index 四 host 入口 + client 浏览器半 +
                            #   `dsh.bundle` 包内 patch + `dsh.client` 声明 + assets/skills。
                            #   一条 `dsh plugin add …&path:/dist/mega` 即挂载全部四行
                            #   （reconcile 自动进 bundles，patch 自动挂载）；
                            #   发布产物由 `scripts/build-dist.mjs` 组装到 `dist/mega/`。
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

### 普通第三方库（如组件库 Semi Design）

可以装。架构约定：**平台模块（react/cordis/ui-slots 等）由部署侧提供，其余普通库全部内联进 `lib/client.js`**（打包纯度门禁只拦 `@deepseek-ai/*` 跨插件值导入，普通 npm 库不受限）。`ui-requirements` 已示例接入 `@douyinfe/semi-ui`（dependencies 内联打包，react/react-dom 走 peer + 模块表）。接入要点（都在 `scripts/tsdown.client.ts` 里解决好了）：

- **普通 CSS 文件**（如 `semi.min.css`）：preset 的 plain-css 处理器解析、内联、以 `<style data-plugin>` 注入，与 CSS Module 同一套幂等标签方案。semi 的 `dist/css` 不在其 exports 白名单，用相对路径引入（`src/client/semi-css.ts`）。
- **组件按深路径引入**（`@douyinfe/semi-ui/lib/es/button`）：semi 把 barrel 标记为 side-effectful，经 barrel 无法摇树。
- **无 exports map 的包会解析到 CJS main**（CJS 不可摇树，semi-icons 1400 个图标全量进包）：preset 的 barrel-esm-resolve 钩子把 `lib/cjs/` 改写为镜像的 `lib/es/` 并清 moduleSideEffects——接入后产物从 2.58MB 降到 1.30MB。

### DSH 系列包

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

# host-only 工具插件（以 db-pgmas 为样板）

无浏览器半的插件不需要 `dsh.client` 声明和 `lib/client.js`，只要 `exports["."] → lib/index.js`。
宿主半导出 `{ name, inject, Config, apply(ctx, config) }`：

- `inject: ['tools', 'systemPrompt']` 等注册表服务是硬依赖（dsh-base 在 profile 根提供）；
- `ctx.tools.register(defineTool({...}))` 从 profile 根注册即**全局工具**，对每个 agent 会话可见；
- `Config`（schemastery，Standard Schema V1）做行 config 校验，全字段可带默认值（行内 `config: {}` 也行）；
- `ctx.provide('<service>', impl)` 暴露服务给其他插件，fiber 卸载时自动撤回；连接池等外部资源用
  `ctx.effect(() => () => cleanup)` 归还；
- tsdown 产物名固定 `lib/index.js`/`.d.ts`（`outExtensions`），`@deepseek-ai/*` 与 `pg` 等运行时依赖
  一律 external，由 node_modules 解析。

挂载方式与 UI 插件相同（`link:` 符号链接 + `cordis.patch.yml` 的 `insert` 行）；行的新增/删除经
patch 层 watcher **热生效**，无需重启 `dsh web`，且重启后依然常驻。
