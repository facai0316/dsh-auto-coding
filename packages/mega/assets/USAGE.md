# 使用说明

> 本插件是 **dsh 编码流水线**（需求 → 决策 → 计划 → 编码 → 契约 → 审核 → 合并），
> 必须配合 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
> 技能包使用。安装后按下面四步走一遍即可开工。

---

## 安装

一条命令装进 web profile（git 分发，零构建）：

```sh
dsh plugin --profile web add "git+ssh://git@github.com/facai0316/dsh-auto-coding.git#v0.3.2&path:/dist/mega"
```

安装后 `dsh.profile.bundles` 自动包含 `@auto-coding/mega`，四个插件行
（db-pgmas / cm-flow / cm-worker / ui-requirements）由包内 patch 自动挂载。
最后**重启 `dsh web`** 使 host 代码生效。

> 若 pnpm ≥10 拦截构建脚本，把报错打印的 key 加进 profile 的
> `pnpm-workspace.yaml` 的 `allowBuilds`，再重跑。

---

## 第一步：配置数据库

打开会话顶部的「自动化看板」→「配置」页，在「数据库连接（pg）」卡片：

1. 填写 PostgreSQL 连接参数（默认指向本机 pg-mas 实例：`127.0.0.1:25678`，
   用户 `mas`，库 `mas`/`cm`/`facai`，默认只读）；
2. 点 **「测试连接」** 确认能连上；
3. 点 **「保存并应用」** —— 写入用户层 `cordis.patch.yml` 覆盖，patch watcher
   热生效，**无需重启**；
4. 点 **「迁移（建表）」** —— 把 `cm` 库的 schema 补齐（幂等，已应用的版本会跳过）。

> 迁移也会在 cm-flow 首次挂载时**自动运行**，无需手动；「迁移」按钮用于
> 改完连接后主动跑一遍、并直接看到结果/报错。

---

## 第二步：把 coding-pipline-skills 放到工程目录

本插件**不内置任何技能**——那套 facai skills 是项目/组织特定的（编码
fac-ai-rs 的规则与流程），对别的项目没有意义，所以必须配合
[coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
使用。各阶段会话（decision / plan / coding / contract / review / selfcheck）
读取项目下的 `.agents/skills/<skill>/SKILL.md` 技能文件：

1. 把 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
   拉到本地；
2. 将其 `.agents/skills/` 内容复制到你的项目根目录下
   （`<项目>/.agents/skills/…`）；
3. 让 agent 运行 `/facai-init` 技能，生成项目专属的 `ARCHITECTURE.md`、
   编码/测试规则、契约映射与 `pipeline.config.yaml`（详细用法见其
   [GitHub 主页](https://github.com/facai0316/coding-pipline-skills)）。

> 进阶（可选）：worker 行配置 `skillsSource` 可指向**外部技能仓库**
> （`dir`（绝对路径）| `git`（url + ref）），流水线缺技能时从那里补装；
> 不配置则只读项目自身的 `.agents/skills/`（缺了会明确报错提示先跑
> facai-init）。见 `docs/plans/10`。

---

## 第三步：添加项目

「自动化看板」→「项目」页，点 **「新增」**，填写：

| 字段 | 说明 |
|---|---|
| 名称 | 项目显示名（如 `fac-ai-rs`） |
| 本地路径 | 主 checkout 的绝对路径（worktree 从它派生） |
| Git 地址 | 远端 git URL（SSH） |
| 平台 | gitee / gitea |
| PR Token | 建 PR 用的凭据（可不填，本地部署可留空） |

---

## 第四步：登记需求并开始执行

「需求」页点 **「新增」** 登记一条需求（选所属项目），然后点「开始执行」。
worker 自动领取并跑流水线：

1. `decision` 产出方案（会先问你要不要人审/要不要回答问题）；
2. `plan` 生成计划 → `review-plan` 机审 → 人审门；
3. `coding` 在任务分支 worktree 里编码（读取项目 `.agents/skills/`）；
4. `contract` / `review-code` 校验；
5. `merge` 推送分支 + 建 PR → 你在 Gitee/GitHub 合并后，审核大厅点「已合并」收尾。

期间「审核」页处理三类事项：**待审核**（通过/驳回带整改意见）、**待决策**
（回答问题）、**待合并**（PR）。「运行」页查看每阶段的 records 账本。

---

## 常见问题

- **连接失败**：确认 host/port/user/password/database 正确，测试连接按钮会给出原因。
- **迁移报错**：通常是连接库不对（应指向包含 `cm` 库的实例）或权限不足；改完连接后
  重新点「迁移（建表）」。
- **技能不存在**：插件不内置技能——把 [coding-pipline-skills](https://github.com/facai0316/coding-pipline-skills)
  的 `.agents/skills/` 放进项目（或配置 `skillsSource` 指向外部技能仓库）后重试；
  报错信息会指出缺失的技能与路径。
- **面板 remote 报错**：host 半代码变更后需重启 `dsh web` 生效（client 半走 HMR 免重启）。
