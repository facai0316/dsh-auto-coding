# auto-coding-plugins · 架构与开发指南

> 本文档面向**开发者**（改插件、加新包、跑构建/测试的人）。
> 用户只需看 [README](../README.md) 和「自动化看板 → 使用说明」。
> 跨会话进度与重启走查清单在 [PROGRESS.md](PROGRESS.md)；分阶段方案在 [plans/](plans/)。

## 仓库定位

Out-of-tree **dsh (Cordis) 插件包** 仓库：pnpm monorepo，一个目录一个插件包，构建产物可挂载进任意 dsh 部署的 profile。

| 包 | 类型 | 职责 |
|---|---|---|
| `ui-hello` | 界面样板 | 侧边栏脚部按钮（`sidebar.footer.action` list Slot、零替换风险的最小样板） |
| `ui-requirements` | 界面 + host | 顶部会话视图 tab「需求面板」：看板（审核 / 项目 / 需求 / 运行 / 配置 / 使用说明）；host 半两个 Typert Remote——`pgconfig`（读写用户层 cordis.patch.yml 的 db-pgmas override + 试连）、`usage`（返回使用说明 markdown） |
| `db-pgmas` | host-only | 本机 pg-mas PostgreSQL 16 docker 实例连接：`pgmas` 服务（连接池 + query/目录内省 + 服务级写缝 withClient）+ `pg_query` / `pg_schema` 模型工具（全局注册）+ `tool:pg-mas` 提示段 |
| `cm-flow` | host-only | `cm` 库需求持久化 + 状态机；`requirements` / `projects` / `questions` 三个命名空间 |
| `cm-worktree` | 纯 Node | git worktree 生命周期封装（每任务一分支一 worktree），零 dsh 依赖，可对临时 git 仓库单测 |
| `cm-worker` | host-only | 编码流水线 worker：timer 串行轮询 → 领取 open 需求 → 6 阶段 subagent 会话 → records 记账 → 决策续跑 → merge PR → 收尾清理 |
| `mega` | 可分发包 | db/flow/worker/index 四 host 入口 + client 浏览器半 + `dsh.bundle` 包内 patch + `dsh.client` 声明；`dist/mega` 由 `scripts/build-dist.mjs` 组装 |

## 目录结构

```
.
├── package.json            # 私有根，workspace 脚本
├── pnpm-workspace.yaml     # packages/*；storeDir 指入仓库内（沙箱内 $HOME 只读）
├── tsconfig.base.json      # 严格 TS（bundler 解析、react-jsx、noEmit）
├── vitest.config.ts        # packages/*/tests/**/*.test.ts
├── scripts/
│   ├── tsdown.client.ts    # 共享打包 preset：Node 半 + 浏览器半
│   └── build-dist.mjs      # 组装可发布的 dist/mega（git 分发，零构建）
└── packages/
    ├── ui-hello/           # 侧边栏脚部按钮（list Slot 样板）
    ├── ui-requirements/    # 看板面板（conversation.view list Slot）
    │   ├── src/index.ts            # Node 半（Typert Remote + host Loader 导入）
    │   ├── src/patch-utils.ts      # 无装饰器的 patch 读写/校验（可被 vitest 直测）
    │   ├── src/client/             # 浏览器半（Slot UI + CSS Module）
    │   └── assets/USAGE.md         # 「使用说明」页文档（与 mega 副本逐字节一致，有测试锁定）
    ├── db-pgmas/           # host-only 工具插件（连接默认值在 Config，行 config 可覆盖）
    ├── cm-flow/            # host-only 业务插件（domain/repo 在 src/repo.ts 无装饰器可直测）
    ├── cm-worktree/        # 纯 Node git worktree 封装
    ├── cm-worker/          # 流水线 worker（编排逻辑在 src/pipeline.ts 纯 DI 可测）
    └── mega/               # 可分发的单包（四个 host 入口 + client + 包内 patch）
```

每个包的通用布局：

```
package.json           # exports + dsh.client 声明 + peer 依赖
tsdown.config.ts       # 双端：host 两阶段（tsc 降装饰器 → tsdown）+ client preset
tsconfig.build.json    # host 半 tsc 阶段（@Remote 装饰器降级）
src/index.ts           # Node 半
src/client/            # 浏览器半
tests/                 # vitest
lib/                   # 构建产物（gitignore）
build/                 # tsc 降级中间产物（提交，供 tsdown 输入）
```

## 常用命令

```sh
pnpm install      # 安装（store 在 .pnpm-store/，已 gitignore）
pnpm typecheck    # 各包 tsc --noEmit
pnpm build        # 各包 tsdown → lib/index.js + lib/client.js
pnpm watch        # 并行 watch
pnpm test         # vitest
```

## 插件包规范

### 每个 UI 插件两份产物，并排放在 lib/

- **`lib/index.js`** — Node 半。纯 UI 插件就是一个空 `apply()`，它的存在使插件能作为 cordis.yml 的一行被 Loader 挂载。
- **`lib/client.js`** — 浏览器半。**不是**普通 ESM bundle：它是闭包工厂产物，脚本执行只调用
  `window.__ModuleLoader__.load({ id, factory })`，模块体在物化时运行；平台模块（react、cordis、ui-slots、ui-primitives、web-react、schema-form、ui-attachment）通过注入的 `require` 从冻结模块表解析，其余依赖全部内联，`*.module.css` 由 lightningcss 编译为哈希类映射并自带 `<style data-plugin>` 注入。

  该格式由 `scripts/tsdown.client.ts`（移植自 deepseek-harness 的 `packages/client/tsdown.client.ts`）保证；其中 `PLATFORM_MODULES` 列表须与部署的 `@deepseek-ai/dsh-client-web/src/platform.ts` 保持同步。

- **`package.json` 必须声明**：
  - `exports["."]` → `lib/index.js`，`exports["./client"]` → `lib/client.js`；
  - `dsh.client`：`{ "inject": ["@deepseek-ai/dsh-client-ui-slots", …], "platform": "web" }` —— host 侧 client 模块扫描据此发现浏览器半（`inject` 是 boot 图的依赖边，`immediately: true` 可选表示首屏预取）；
  - `peerDependencies`：部署侧提供 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、`react` 等，**不得**打进 bundle。

- **client 代码规则**：服务用 `export const inject = ['slots', …]` 声明硬依赖后走 `ctx.slots`；Slot 注册用 `ctx.slots.inject(name, () => ctx.slots.register({ name, id | key, order?, label? }, Component))`；跨插件协作只走 cordis 服务（打包期有纯度门禁，`@deepseek-ai/*` 值导入非平台模块直接报错）。

### host-only 工具插件（以 db-pgmas 为样板）

无浏览器半的插件不需要 `dsh.client` 声明和 `lib/client.js`，只要 `exports["."] → lib/index.js`。
宿主半导出 `{ name, inject, Config, apply(ctx, config) }`：

- `inject: ['tools', 'systemPrompt']` 等注册表服务是硬依赖（dsh-base 在 profile 根提供）；
- `ctx.tools.register(defineTool({...}))` 从 profile 根注册即**全局工具**，对每个 agent 会话可见；
- `Config`（schemastery，Standard Schema V1）做行 config 校验，全字段可带默认值；
- `ctx.provide('<service>', impl)` 暴露服务给其他插件，fiber 卸载时自动撤回；连接池等外部资源用
  `ctx.effect(() => () => cleanup)` 归还；
- tsdown 产物名固定 `lib/index.js`/`.d.ts`（`outExtensions`），`@deepseek-ai/*` 与 `pg` 等运行时依赖
  一律 external，由 node_modules 解析。

## 依赖说明

### 普通第三方库（如组件库 Semi Design）

可以装。架构约定：**平台模块（react/cordis/ui-slots 等）由部署侧提供，其余普通库全部内联进 `lib/client.js`**（打包纯度门禁只拦 `@deepseek-ai/*` 跨插件值导入，普通 npm 库不受限）。`ui-requirements` 已示例接入 `@douyinfe/semi-ui`（dependencies 内联打包，react/react-dom 走 peer + 模块表）。接入要点（都在 `scripts/tsdown.client.ts` 里解决好了）：

- **普通 CSS 文件**（如 `semi.min.css`）：preset 的 plain-css 处理器解析、内联、以 `<style data-plugin>` 注入，与 CSS Module 同一套幂等标签方案。
- **组件按深路径引入**（`@douyinfe/semi-ui/lib/es/button`）：semi 把 barrel 标记为 side-effectful，经 barrel 无法摇树。
- **无 exports map 的包会解析到 CJS main**（CJS 不可摇树）：preset 的 barrel-esm-resolve 钩子把 `lib/cjs/` 改写为镜像的 `lib/es/` 并清 moduleSideEffects。

### DSH 系列包

- `@deepseek-ai/dsh-client-*` npm 发布集不完整，从 npm 安装其依赖树会 404。
- 因此 `packages/*/devDependencies` 里的 DSH 包全部用 `link:` 指向本地 harness 检出（默认 `/root/workspace/deepseek-harness`），**仅作类型来源**（本仓库对它们只有 type-only import，产物里一律被 external 或擦除）。
- 运行时依赖以 `peerDependencies` 由部署侧满足；换检出路径时改各包 `package.json` 里的 `link:` 目标即可。

## 挂载进 dsh 与热生效边界

### 开发回路：`link:` 符号链接 + client-hmr

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

3. `client-hmr`（web-app bundle 自带）每 500ms stat-poll boot 图里每个 `dsh.client` 包的 `lib/client.js`，配合符号链接形成前端式热加载回路：

   ```
   保存 src/client/*.tsx / *.module.css
     → 仓库根 pnpm watch（tsdown --watch）
     → lib/client.js 变更 → client-hmr 重哈希 → SSE 推送
     → 浏览器免刷新热替换插件（含 <style> 标签整体换掉）
   ```

> UI 插件必须走「包安装」方式（host 要解析 `exports["./client"]`）；`./plugins/xxx/index.mjs` 相对路径行只适合 host-only 插件。用 `file:` 安装会**复制**包体，热加载回路随之失效，故用 `link:`。

### 热生效边界

| 变更 | 生效方式 |
|---|---|
| bundle 行增删 / 用户层 config 覆盖（含「保存数据库配置」） | patch watcher 热生效，**无需重启** |
| host 半 `lib/index.js` 代码 | 需重启 `dsh web`（模块启动时加载） |
| client 半 `lib/client.js` | client-hmr 热替换，**无需重启** |

## 流水线架构

### 六阶段与技能映射

worker 的六阶段 subagent 会话定义在 `cm-worker/src/pipeline.ts` 的 `STAGES` 数组（mega 的 `worker-pipeline.ts` 是同构副本）。每个阶段按 `category` 记账，按 `skill` 读取项目技能：

| 阶段 (category) | 技能（`.agents/skills/<skill>/SKILL.md`） | 产出 |
|---|---|---|
| decision | `facai-decision` | ADR 至 `decisions/`；方案多选时用 questions 返回 `{question, options}` |
| plan | `facai-plan` | `docs/plans/` 下的实现计划（只规划不实现） |
| review-plan | `facai-review` | 独立审读计划；冲突时 questions 提问，可直改计划 |
| coding | `facai-coding` | 按计划落地代码；自动执行 `facai-selfcheck` 闭环 |
| contract | `facai-contract` | 按变更同步 `spec/` 行为契约 |
| review-code | `facai-review` | 独立审读代码；冲突直接修改 |

技能名是 `facai-*` 前缀、与 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills) 的 `.agents/skills/facai-*/` 布局一一对应——**插件不内置任何技能，也绝不改名**，天生与该技能包适配。

### worker 编排

- timer 串行轮询：领取 `open` 需求 → 6 阶段 subagent 会话（cwd=worktree，注入技能正文）→ records 记账 → 决策续跑（`waiting_reply`）→ merge PR agent 任务 → 收尾清理。
- 编排逻辑在 `src/pipeline.ts`（纯依赖注入，可测）；`src/index.ts` 是 cordis 服务壳（真实 subagents/agents/fs/worktree）。
- 阶段成功后兜底提交 worktree 未提交产物（`facai-*` 技能默认不 git commit，merge push 需要干净树）。

### 数据模型与迁移

- `cm` 库：需求持久化 + 状态机（domain/repo 在 `cm-flow/src/repo.ts`）。
- schema 演进走 `_cm_flow_migrations` 顺序迁移（v1 baseline、v2 projects、v3 requirements.project_id、v4 ask_user_questions）；固定 userId（Config 可覆盖）首次激活幂等植入 users 行（FK 目标）。
- 迁移在 cm-flow 首次挂载时自动运行；「配置」页的「迁移（建表）」按钮用于改完连接后主动跑一遍看结果。

## 构建与打包

```sh
pnpm build          # 各包 tsdown → lib/
node scripts/build-dist.mjs   # 组装 dist/mega（可发布目录）
```

- 单个插件的 host 半是两阶段构建：`tsc -p tsconfig.build.json` 把 TC39 `@Remote` 装饰器降级到 `build/`，再由 tsdown 把 `build/index.js` bundle 进 `lib/index.js`（rolldown/oxc 直转不会降级装饰器，故不能单步 tsdown）。
- `mega` 是唯一可分发包：四个 host 入口（`./db ./flow ./worker .`）+ client 半 + 包内 `cordis.patch.yml`（`dsh.bundle.patch`）。`dist/mega` 由 `build-dist.mjs` 从 `packages/mega/lib` + 包内 patch 组装，含 `lib/` 预构建产物，git 依赖安装**零构建**。
- 发布流程：升 `packages/mega/package.json` 版本号 → `pnpm --filter @auto-coding/mega build` → `node scripts/build-dist.mjs` → 提交（`-f` 加入被 gitignore 的 `dist/`）→ 打 lightweight tag `vX.Y.Z`（与既有 tag 风格一致）。
- 安装到任意部署：`dsh plugin --profile web add "git+ssh://…dsh-auto-coding.git#<tag>&path:/dist/mega"`（reconcile 自动进 bundles，patch 自动挂载四行）。

## 新增一个插件包

```sh
mkdir -p packages/<name>/src/client packages/<name>/tests
# 复制 ui-hello 的 package.json / tsconfig.json / tsdown.config.ts 改名，
# tsdown.config.ts 里换成新包名；根目录 pnpm install 后即可 build。
```

挂载方式与既有插件相同（`link:` 符号链接 + `cordis.patch.yml` 的 `insert` 行）；行的新增/删除经 patch 层 watcher **热生效**，无需重启 `dsh web`，且重启后依然常驻。

## 相关文档

- [PROGRESS.md](PROGRESS.md) —— 跨会话进度、重启与端到端走查清单、环境速查
- [plans/](plans/) —— 分阶段方案（01–10：交付、测试验收、打包与分发等）
- [使用说明](../packages/mega/assets/USAGE.md) —— 用户文档（与 ui-requirements 副本逐字节一致）
