# 10 · 打包与分发（mega 包 + dsh 原生安装机制）

> 前置：01–09 交付物均在仓库内（`packages/*`，一个目录一个插件包）。
> 目标：把这套 out-of-tree 插件**打包成一个可分发的包**，装到任意 dsh 部署
> （本机、其他电脑、服务器），并走 **dsh 自带的插件安装机制**（`dsh plugin add`）
> 实现一键安装。
> 状态：**方案已定稿**（2026-08-16 讨论确定四项决策，决策 4 同日修订为
> 「不内置技能」）；P0–P3 已实施并验证（2026-08-16 会话），待本机 profile
> 切换与远端分发实测（见 §7 待办）。

## 0. 结论速览（四项已定决策）

| # | 问题 | 决策 | 理由 |
|---|---|---|---|
| 1 | 打包粒度 | **单 mega 包多入口** | 4 个插件本质是一条流水线的四个环节，一套版本号天然同步；依赖从跨包 peerDeps 变包内模块 |
| 2 | 分发通道 | **私有 git 依赖** | 不用 registry；pnpm `git+ssh` 克隆即装；仓库私有则凭据不泄露 |
| 3 | 配置保存位置 | **写回用户层 cordis.patch.yml** | 与部署模型一致、热生效、升级不覆盖（已有「数据库连接」卡片落地） |
| 4 | skills 来源 | **可配置外部路径**（dir / git；**不内置**） | 必须配合外部技能包（facai skills 是项目特定） |

---

## 1. 背景与问题

当前 `packages/*` 六个包（db-pgmas / cm-flow / cm-worker / cm-worktree / ui-requirements /
ui-hello）通过**本机三件套**挂载：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 用 `link:` 指向仓库内路径；
2. `~/.dsh/profiles/web/node_modules/@auto-coding/*` 符号链接到 `packages/*`；
3. `~/.dsh/profiles/web/cordis.patch.yml` 追加 4 行 `- insert:`。

这套方式**只能在本机**（链接指向本机绝对路径），换电脑要手工重复三步，且 host 半
`lib/index.js` 修改后需重启 `dsh web` 才生效。

目标：`git clone` + 一条 `dsh plugin` 命令 → 全部插件就位、热生效。

---

## 2. dsh 自带安装机制（已探明，源码级验证）

### 2.1 `dsh plugin --profile web add <pkg>` 做什么

`apps/cli/lib/plugin-*.js` 的 `runPlugin`：

1. profile 未初始化则自动初始化（模板 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）；
2. 把参数**原样转发给 pnpm**，cwd = profile 目录，执行 `pnpm add <pkg>`；
3. 装完后跑 `reconcilePlugins()`：逐个检查已装依赖的 `package.json` 是否声明
   `dsh.bundle.patch` —— **声明了就自动追加进 `dsh.profile.bundles` 层栈**；
   未声明的只警告「装成了普通依赖，不是 profile 层」；
4. `git+` 依赖若被 pnpm 10+ 的 allowBuilds 拦下，报错分支会打印提示：
   把 pnpm 打印的 key 加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`，再重跑。

### 2.2 bundle 层如何生效

启动时 `packages/boot/app-boot/src/profile.ts` 的 `loadProfile`：

- 读 `dsh.profile.bundles`，逐个 `resolveBundleDir` 解析包目录，取 `dsh.bundle.patch`
  指向的**包内 patch 文件**作为一层；
- 层顺序：**bundle 层（按 bundles 数组）→ 用户层 `cordis.patch.yml` → `--patch` 覆盖**；
- 同一行 id **最后写赢**：用户层写 `- id: db-pgmas config:` 永远盖过 bundle 默认值。

### 2.3 现成样板

```json
// packages/bundle/base/package.json（@deepseek-ai/dsh-base）
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

包内 `cordis.patch.yml` 就是顶层 `- insert:` 行列表——**与用户层文件完全同构**。

### 2.4 热生效边界

| 变更 | 生效方式 |
|---|---|
| bundle 行增删 / 用户层 config 覆盖 | patch watcher 热生效，**无需重启** |
| host 半 `lib/index.js` 代码 | 需重启 `dsh web`（模块启动时加载；config-only patch 不触发重导入） |
| client 半 `lib/client.js` | client-hmr 热替换，**无需重启** |

---

## 3. 单 mega 包设计（决策 1）

### 3.1 目录结构

```
packages/mega/
  package.json            # exports 多入口 + dsh.bundle + dsh.client 声明
  cordis.patch.yml        # 包内 bundle patch（4 行 insert，照抄现有用户层行）
  tsdown.config.ts        # 双端：host 两阶段（tsc 降装饰器 → tsdown）+ client preset
  tsconfig.build.json
  src/
    index.ts              # 元信息/空壳 apply（包根入口）
    db.ts                 # ← db-pgmas（host-only，pgmas 服务 + pg_query/pg_schema 工具）
    flow.ts               # ← cm-flow（host-only，requirements/projects/questions/reviews/records/config remote）
    worker.ts             # ← cm-worker（host-only，timer 流水线 + merge remote）
    client/index.ts       # ← ui-requirements 浏览器半（看板 tab + 数据库连接卡片 + 使用说明页）
  assets/
    skills/（已移除——不内置技能；外部技能仓库经 skillsSource 配置）
```

### 3.2 exports / 声明

```jsonc
{
  "name": "@auto-coding/mega",
  "exports": {
    ".":         "./lib/index.js",     // 包根：空壳（或元信息）
    "./db":      "./lib/db.js",
    "./flow":    "./lib/flow.js",
    "./worker":  "./lib/worker.js",
    "./client":  "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // 一键安装的关键声明
    "client": { "inject": ["@deepseek-ai/dsh-client-runtime"], "platform": "web" }
  }
}
```

### 3.3 包内 cordis.patch.yml（原样搬现有用户层行）

```yaml
- insert:
    - id: db-pgmas
      name: '@auto-coding/mega/db'
      config: {}
- insert:
    - id: cm-flow
      name: '@auto-coding/mega/flow'
      config: {}
- insert:
    - id: cm-worker
      name: '@auto-coding/mega/worker'
      config: {}
- insert:
    - id: ui-requirements
      name: '@auto-coding/mega'
```

> 行 id 保持不变（`db-pgmas` / `cm-flow` / `cm-worker` / `ui-requirements`），
> 只是 `name` 从独立包名改为 mega 的子路径入口。用户层已有 override
> （如数据库连接卡片写入的 `- id: db-pgmas config:`）继续按 id 覆盖，不受影响。

### 3.4 待验证点：client 半挂载语义

client 半的发现是**包级**的（`package.json` 的 `dsh.client` 声明，见
`packages/client/ui-settings-plugins` 机制），不是入口级。mega 包声明 `dsh.client`
后，`./db` `./flow` `./worker` 这些 host-only 入口**可能也会被认为有 client 半**。
两个解法：

1. client 半 `apply` 按行 id 判断，非 ui 行直接空操作（简单，兜底）；
2. 查 host 侧 client 扫描实现是否支持入口级 `dsh.client` 声明（更干净）。

**实施 P1 先验证，解法 1 兜底。**

---

## 4. 私有 git 分发（决策 2）

### 4.1 目标机器安装命令（一键）

```sh
# 1) 拿到仓库（已有远端 git@gitee.com:wb200327/auto-coding-plugins.git）
git clone git@gitee.com:wb200327/auto-coding-plugins.git
cd auto-coding-plugins && pnpm install && pnpm build   # lib/ 在 .gitignore，须现构建

# 2) 一条命令装进 web profile（dsh plugin 转发 pnpm + reconcile bundles）
dsh plugin --profile web add git+ssh://git@gitee.com:wb200327/auto-coding-plugins.git#v0.2.0

# 3) 若 pnpm 10+ 拦构建脚本：把报错分支打印的 key 加进
#    ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds，再重跑上一条

# 4) 重启（host 半代码）
dsh --profile web
```

安装后 `dsh.profile.bundles` 自动含 `@auto-coding/mega`，其 `cordis.patch.yml`
自动挂载 4 行——**一个 patch 行都不用手写**。

### 4.2 待定点：git 依赖的构建产物策略

`lib/` 在 `.gitignore`（不随 git 分发），git 依赖安装时 pnpm 会跑 `prepare`。
两个方案：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A：prepare 自构建** | mega 包 `prepare` 脚本在 install 时构建（依赖 monorepo 上下文） | 不用提交产物；但 install 依赖完整构建链，且 pnpm 10 要 allowBuilds 放行 |
| **B：提交发布目录** | 仓库放 `dist/mega/`（含 lib/），git tag 锁版本，依赖指向子目录 | 干净利落、安装零构建；产物入库略脏，但 git 依赖天然以 tag 为界 |

**倾向 B**（P1 实施时确认 pnpm 对 git 依赖子目录/产物策略的准确行为）。

---

## 5. 配置写回用户层（决策 3）—— 已落地

看板「配置」页顶部已有「数据库连接(pg)」卡片（`DbConfigCard.tsx`），host 半
`pgconfig` remote 把表单写进 **用户层 override**：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml —— 数据库连接卡片写入
- id: db-pgmas
  config:
    host: 10.0.0.5
    port: 5432
    user: myuser
    password: '***'
```

- patch watcher 热生效，无需重启；
- 用户层永远盖过 bundle 默认值；bundle 升级不冲掉用户配置；
- 行 id 与 mega 包 patch 里的行一致，**mega 合并后无需迁移**。

---

## 6. skills 外部源（决策 4，2026-08-16 修订）

cm-worker 各阶段读 `项目/.agents/skills/<skill>/SKILL.md`，找不到报
「需先跑 facai-init」。**修订：插件不内置任何技能**——facai skills 是
项目/组织特定的（编码 fac-ai-rs 的规则），对其他项目没有意义，必须配合
[coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
使用（把其 `.agents/skills/` 放进项目 + 运行 `/facai-init`）。可选的
**外部技能仓库**兜底：

```yaml
# mega 行 config 新增（可选；不配置 = 只读项目自身 .agents/skills/）
config:
  skillsSource:
    kind: dir   # dir | git
    # kind=dir 时: path: /abs/path/to/skills
    # kind=git 时: url: git@…/facai-skills.git, ref: v1
```

- cm-worker 读取顺序：项目自身 `.agents/skills/<skill>/SKILL.md`（优先）→
  配置的 `skillsSource`（dir | git）；
- `skillsSource` 配置后，创建 worktree 时把缺的技能从外部源补进
  `.agents/skills/`（provisionSkills 钩子）；
- 未配置 `skillsSource` 且项目缺技能 → 明确报错提示先跑 facai-init（旧配置的
  `builtin` 被当作「无外部源」退化处理）。

---

## 7. 实施阶段划分

| 阶段 | 内容 | 验证点 | 状态 |
|---|---|---|---|
| **P0** | mega 包骨架：db/flow/worker/client 四入口合并 + exports + `dsh.bundle` 声明 + 包内 patch；本机 `dsh plugin add link:…` 走通 reconcile | 本机跑通、patch 自动挂载 | ✅ 已验证 |
| **P1** | ① client 半挂载语义验证（§3.4，解法 1 兜底）；② git 分发产物策略定案（§4.2，方案 B 已定）；③ 干净环境模拟 `dsh plugin add git+…` | 目标机器可一键安装 | ✅ ①③已验证，②已定案 |
| **P2** | 配置界面（数据库连接卡片已落地；核对 mega 行 id 一致；如需再加 worker 时段/模型配置入口） | GUI 改配置热生效 | ✅ 行 id 已断言一致 |
| **P3** | skills 外部源（§6，修订：不内置技能，必须配合外部技能包） | 项目缺技能时报错提示 | ✅ 已实现+测试 |

**当前进度**：P2 的「数据库连接」卡片已在 ui-requirements 实现并通过测试；
P0/P1/P3 已实施并验证（2026-08-16）：

- **P0 完成**：`packages/mega/` 单包骨架落地（exports 五入口 + `dsh.bundle`
  包内 patch + `dsh.client` 声明 + 双端构建），db/flow/worker/index 四 host
  入口与 client 浏览器半全部可构建；`pnpm typecheck` 绿、`pnpm test` 110/110
  绿（含 mega 包 patch 行断言与 skills-source 单测）；`dsh plugin add
  link:…` 在一次性 profile 上走通 reconcile —— `@auto-coding/mega` 自动追加进
  `dsh.profile.bundles`，`--dump-config` 确认四行（db-pgmas / cm-flow /
  cm-worker / ui-requirements）从包内 patch 自动挂载，行 id 不变（用户层
  `- id: db-pgmas config:` override 继续按 id 生效）。
- **P1 ① 完成（§3.4）**：client 半挂载语义**源码+实证双确认**——client-modules
  扫描是**按 loader 行名**解析 `<name>/package.json`：子路径行（`@auto-coding/
  mega/db`、`/flow`、`/worker`）因 exports map 无对应子路径而 `require.resolve`
  抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` → 永久缓存为「非 client 行」；只有根行
  `@auto-coding/mega`（ui-requirements 行）解析到 package.json、读到 `dsh.client`
  并取 `exports["./client"]` → lib/client.js。**解法 2 天然成立，无需解法 1 兜底**。
- **P1 ② 定案（§4.2）= 方案 B**：新增 `scripts/build-dist.mjs` 组装
  `dist/mega/`（lib/ + cordis.patch.yml + assets/USAGE.md + 精简 manifest），
  git 依赖指向子目录（`#v0.3.0&path:/dist/mega`）。pnpm 11.21 实测支持
  `&path:/` 子目录片段，安装**零构建**（无 prepare、无 allowBuilds）。
- **P1 ③ 完成**：本地裸仓 + `dsh plugin add git+file://…&path:/dist/mega`
  在一次性 profile 全流程验证 —— 安装 → reconcile 进 bundles → dump-config
  四行自动挂载。
- **P3 完成（2026-08-16 修订：不内置技能）**：`skills-source.ts`（`dir` | `git`
  两源，git 按 url+ref 内容寻址缓存克隆；`builtin` 已移除）+ worker
  `skillsSource` 行 config + `readSkillMd` 回退 + worktree 创建后
  `provisionSkills` 补装缺失技能到 `.agents/skills/`。**插件不打包任何 skills**
  ——facai skills 是项目/组织特定（编码 fac-ai-rs 规则），必须配合
  coding-pipline-skills 使用（把 `.agents/skills/` 放进项目 + 运行
  `/facai-init`）；未配置 skillsSource 时只读项目自身技能，缺失即报错提示。

**待办（非阻塞）**：① 本机 web profile 从四独立包切换到 mega（改
`cordis.patch.yml` 删四行 insert + `dsh plugin add` mega + 重启，见
PROGRESS.md §3.1/§3.4 收尾）；② 推远端 tag 后目标机器一键安装命令
（§4.1 步骤 2）实测；③ 旧四包后续可归档。

---

## 8. 风险与注意

- **敏感默认值**：db-pgmas Config 默认 `password: 'Fa^Cai!0316#Mas.'` 是本机 pg-mas
  凭据。私有 git 仓库不泄露；若将来上公开渠道必须改成必填/环境变量。
- **client 产物与部署版本匹配**：`scripts/tsdown.client.ts` 的 `PLATFORM_MODULES`
  须与目标部署 `@deepseek-ai/dsh-client-web/src/platform.ts` 同步；目标机器 dsh
  版本建议与本机一致（本机 `0.1.0-rc.5`）。
- **host 半两阶段构建**：mega 的 host 入口含 `@Remote` 装饰器，必须走
  `tsc -p tsconfig.build.json`（降装饰器到 build/）→ tsdown（bundle build/），
  与 cm-flow / ui-requirements 现状一致；rolldown 直转不会降级 TC39 装饰器。
- **allowBuilds**：pnpm ≥10 对 git 依赖的构建脚本默认拦截，安装报错分支会打印
  需要的 key（§2.1 步骤 3）。
