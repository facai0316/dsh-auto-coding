# auto-coding-plugins

**dsh 编码流水线**（需求 → 决策 → 计划 → 编码 → 契约 → 审核 → 合并）的插件集：
在 Web GUI 的「自动化看板」里登记需求，worker 自动领取并跑完整流水线，期间
配合 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
的 `facai-*` 技能（决策 / 计划 / 编码 / 契约 / 审核）执行各阶段。

> 安装后的完整文档在「自动化看板 → 使用说明」页（即 `packages/mega/assets/USAGE.md`）。
> 想改插件、加新包、跑构建？开发者文档在 [docs/architecture.md](docs/architecture.md)。

## ✨ 特性

- **自动化看板**：审核 / 项目 / 需求 / 运行 / 配置 / 使用说明 六个页面
- **数据库配置热生效**：保存即应用（patch watcher），无需重启
- **六阶段流水线**：决策 → 计划 → 计划审核 → 编码（自动自检）→ 契约 → 代码审核，
  与 coding-pipline-skills 的 `facai-*` 技能天然适配
- **人审门**：审核大厅处理 待审核 / 待决策 / 待合并
- **一条命令安装**：git 分发、零构建

## 🚀 安装

```sh
dsh plugin --profile web add "git+ssh://git@github.com/facai0316/dsh-auto-coding.git#v0.3.2&path:/dist/mega"
```

安装后**重启 `dsh web`** 生效（四个插件行由包内 patch 自动挂载）。

## 📖 快速开始（四步）

1. **配置数据库**：打开「自动化看板 → 配置」页，填好 pg 连接参数 → **「测试连接」**
   → **「保存并应用」**（热生效）→ 点 **「迁移（建表）」** 补齐 `cm` 库 schema
   （迁移在 cm-flow 首次挂载时也会自动跑，按钮用于主动跑一遍看结果）。
2. **准备技能**：插件**不内置任何技能**（facai skills 是项目/组织特定的）——
   把 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
   拉到本地，将其 `.agents/skills/` 复制到项目根目录，再让 agent 运行 `/facai-init`
   生成项目专属配置（详细用法见其 GitHub 主页，或下文「最佳实践」）。
3. **添加项目**：「自动化看板 → 项目」页「新增」：名称 / 本地路径 / Git 地址 / 平台 / PR Token。
4. **登记需求**：「需求」页「新增」并「开始执行」，worker 自动跑完整流水线，
   审核大厅处理 待审核 / 待决策 / 待合并。

## 🗂 看板导览

| 页 | 用途 |
|---|---|
| 审核 | 待审核（通过/驳回带整改意见）、待决策（回答问题）、待合并（PR） |
| 项目 | 登记/管理项目（本地路径 + git 远端 + 平台 + PR Token） |
| 需求 | 登记需求、开始执行、查看阶段状态 |
| 运行 | 查看每阶段的 records 账本 |
| 配置 | 数据库连接（pg）卡片：编辑 + 试连 + 保存应用 + 迁移（建表） |
| 使用说明 | 本文档的完整版 |

## 🎯 最佳实践

### 从想法到可运行代码（配合 coding-pipline-skills）

完整流水线从记录最初想法开始，而不是上来就写代码：

1. **写下最初想法**：在 `docs/origin-idea/init.md` 中描述你要做什么——随意写，
   把目标、功能、约束记下来即可。
2. **运行初始化向导**：在任意支持 `.agents/` 约定的 coding agent 中，把最初想法
   文件作为输入运行向导：

   ```
   /facai-init docs/origin-idea/init.md
   ```

3. **回答向导的问题**：向导会逐轮提问——模块划分、依赖方向、领域红线、契约映射等。
   一一解答后，它会自动生成架构文档、编码规则、自检配置等全套产物
   （`.agents/pipeline.config.yaml`、`rules/`、`templates/`）。
4. **进入流水线闭环**：初始化完成后按需调用：

   ```
   /facai-decision   → 决策建档
   /facai-plan       → 生成实现计划
   /facai-coding     → 编码落地（自动自检）
   /facai-review     → 语义审核
   ```

   剩下的交给流水线就行。

> 以上即 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
> 官方最佳实践；它是本项目流水线的技能底座，本插件按 `facai-*` 技能名读取执行。

### 在自动化看板跑需求

1. 按上文「快速开始」完成 数据库 + 技能 + 项目 三步准备；
2. 「需求」页登记需求（选所属项目）→「开始执行」；
3. worker 自动领取并跑六阶段（决策 → 计划 → 计划审核 → 编码 → 契约 → 代码审核），
   需要你拍板时会以「待决策」问题形式出现；
4. 代码完成后「待合并」建 PR，你在远端合并后回审核大厅点「已合并」收尾。

### 流水线使用建议

- **需求拆小**：一条需求对应一个可独立交付的变更，流水线一次闭环更快、审核更聚焦。
- **审核门是流程的一部分**：计划与代码两道机审 + 人审门，别跳过——它保证
  「计划 → 代码 → 契约」与架构、规则一致。
- **契约同步**：变更行为时让 `facai-contract` 同步 `spec/`，自检会提示契约缺失。
- **改完连接记得迁移**：连接参数变更后点「迁移（建表）」主动跑一遍，幂等可重复。
- **技能缺失先跑 facai-init**：报错提示 `.agents/skills/<skill>/SKILL.md` 不存在时，
  说明项目还没初始化（或没放技能包），先跑 `/facai-init`。

## ❓ 常见问题

- **连接失败**：确认 host/port/user/password/database 正确，「测试连接」会给出原因。
- **迁移报错**：通常是连接库不对（应指向包含 `cm` 库的实例）或权限不足；改完连接后重新点「迁移（建表）」。
- **技能不存在**：插件不内置技能——把 coding-pipline-skills 的 `.agents/skills/` 放进项目
  （或配置 `skillsSource` 指向外部技能仓库）后重试；报错信息会指出缺失的技能与路径。
- **面板 remote 报错**：host 半代码变更后需重启 `dsh web` 生效（client 半走 HMR 免重启）。

---

> 开发者入口：[docs/architecture.md](docs/architecture.md)（架构 / 插件规范 / 构建打包）、
> [docs/PROGRESS.md](docs/PROGRESS.md)（跨会话进度）。
