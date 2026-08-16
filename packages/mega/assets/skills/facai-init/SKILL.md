---
name: facai-init
description: 项目初始化向导。引导用户完成编码流水线的全部配置——项目画像、架构描述、规则生成、契约映射、自检配置。通过多轮 AskUserQuestion 引导，一键生成项目专属的 ARCHITECTURE.md、coding-rule.md、test-rule.md、domain-extra-rule.md、pipeline.config.yaml、AGENTS.md。当用户首次接入流水线、运行 /facai-init、或要求初始化/配置项目时使用。
---

# 项目初始化向导

引导式生成项目的全套流水线配置。这是纯净版与"裸模板"的本质区别——把定制化从手工填写升级为引导式生成。

## 核心设计

> **不使用"推导预设表"**——把语言知识冻结成静态映射表会冗余且易过时。执行向导的是大模型，它本身具备各语言的活知识。向导只提供"推导模式描述 + 范例"，由模型用自身知识直接生成准确的规则文本和检测项，不留占位符。

## 推导模式（向导内置的生成指令）

生成规则时，对每条通用规则按以下模式填充该语言的具体形态和对应检测手段（规则文本写入 coding-rule.md，检测手段同步写入 pipeline.config.yaml）：

```
通用原则 → 该语言的具体形态 → 对应的检测手段
```

范例（同一原则在不同语言的推导结果）：

| 规则章节 | 通用原则 | Rust 推导 | TypeScript 推导 | Python 推导 |
|---------|---------|----------|----------------|------------|
| 依赖方向 | 只能往下走，禁反向 | `shared/` 禁 `use crate::agent` | `shared/` 禁 `import from '@/agent'` | `shared/` 禁 `from agent import` |
| 错误处理 | 向上传播，禁 panic | `?` 传播，禁 `.unwrap()`/`.expect()` | `throw`，禁 `as unknown as` | `raise`，禁裸 `except:` |
| 命名规范 | 类型/函数/常量各有风格 | PascalCase / snake_case / UPPER_SNAKE | PascalCase / camelCase / UPPER_SNAKE | PascalCase / snake_case / UPPER_SNAKE |
| 模块登记 | 入口声明对外可见面 | `pub mod xxx;` 在 `mod.rs` | `export` from `index.ts` | `__init__.py` 里 `from .xxx import` |
| 测试归口 | 测试归 test 目录，禁业务源码散落 | `src/test/unit/`，`#[test]` | `test/unit/`，`describe/it` | `tests/unit/`，`def test_` |

向导执行时，用模型对用户所选语言的最新知识生成准确内容，上述范例仅是示范格式，不是穷举清单。

---

## 工作流程（7 步）

### 第 1 步：项目画像

通过 AskUserQuestion 采集语言、技术栈、构建体系，作为后续所有推导的基础。

**必问项**：

| 问题 | 用途 |
|------|------|
| 项目名称 | 填入各文档标题和 config |
| 主语言（Rust / TypeScript / Python / Go / Java / 其他） | 决定命名规范、import 语法、伪代码约定 |
| 构建/检查命令（文本输入，如 `cargo check` / `npm run build` / `go build ./...`） | selfcheck 编译检查段 |
| 测试命令（文本输入，如 `cargo test --lib` / `npm test` / `go test ./...`） | selfcheck 测试检查段 |
| 源码根目录（如 `src/` / `app/` / `lib/`） | 检测范围 |
| 是否有数据库/ORM | 决定是否生成数据结构约定、契约映射项 |

将采集结果暂存，后续写入 `pipeline.config.yaml` 的 `project` 和 `commands` 段。

### 第 2 步：架构描述（→ 生成 ARCHITECTURE.md）

这是最关键的定制化环节。架构文档必须逐项目生成，不能模板化。

**2a. 顶层模块清单**

> AskUserQuestion："你的项目有哪些顶层模块/包？逐个列出（如 agent, gateway, shared, worker）"

**2b. 依赖方向矩阵**

对每个模块，AskUserQuestion："`{模块}` 依赖哪些其他模块？（多选）"
基于 2a 的模块清单生成多选选项。

据此推导出：
- 合法的依赖白名单（`A → B` 表示 A 可依赖 B）
- 禁止的反向依赖（红线）
- 叶子模块（无下游依赖的模块，互斥检查）

**2c. 分层语义（可选）**

AskUserQuestion："是否有 shared/common 类的共享层？应用层模块之间允许直接依赖吗？"
选项：共享层单向依赖 / 应用层模块间禁互依 / 应用层经接口协作

**输出**：根据 `.agents/templates/architecture.md.tmpl` 结构，用采集的信息生成 `ARCHITECTURE.md`，包含模块清单、依赖方向图（ASCII）、分层约定。同步写入 config 的 `architecture` 段。

### 第 3 步：规则生成（→ 生成 coding-rule.md / test-rule.md）

向导的核心理念：**规则大部分通用或可从架构推导，用户只需补增量偏好。**

**3a. 推导生成（向导自动，不问用户）**

对每条通用规则，按"推导模式"（见上方）生成该语言的具体形态：
- 依赖方向红线（从第 2 步架构矩阵直接翻译）
- import 规范（按语言推导，如 Rust 用绝对路径、TS 用 `@/` 别名）
- 错误处理（按语言推导）
- 命名规范（按语言推导）
- 模块可见性（按语言推导模块登记约定）
- 配置三处同步原则（通用）

规则文本写入 `coding-rule.md`（根据 `.agents/templates/coding-rule.md.tmpl` 结构），检测手段同步写入 config 的 `rules` 段。

测试规范同理，写入 `test-rule.md`（根据 `.agents/templates/test-rule.md.tmpl`）。

**3b. 领域专用规则增补（AskUserQuestion，可选）**

> AskUserQuestion："通用红线已自动生成。你的项目有没有**领域专属的红线**想补充？（如：agent 运行时禁止散落写入口、电商下单必须走幂等链路）"
> - 有 → 用户描述后，写入 `domain-extra-rule.md`（根据 `.agents/templates/domain-extra-rule.md.tmpl`），并为其中可静态检测的条目生成 config `domain_checks` 检测项
> - 没有 → 跳过（`domain-extra-rule.md` 可后续随时补）

**3c. 通用偏好增量（AskUserQuestion，可选）**

> AskUserQuestion："还有额外的通用代码规范偏好吗？"
> 多选示例：函数/文件长度上限、强制注释覆盖率、禁止直接操作数据库、其他（文本补充）
> 用户勾选后追加到 `coding-rule.md` 对应章节，写入 config `rules.extra_redlines`。

**3d. dry-run 校验（强制）**

规则和 config 检测项生成后，**必须**对每条检测 grep 模式做一次 dry-run（对当前代码库执行一次）：

- 正则语法错误 → 报错，立即修正
- 路径不存在 → 报错，立即修正
- 无匹配属正常（库还没写对应代码），不报错

这一步补偿了"无预设人工校准"的精度风险，只在初始化时跑一次，成本极低。

### 第 4 步：契约映射（→ 写入 config）

引导用户声明"哪些源码目录变更时，需要检查哪个契约文件"。

> AskUserQuestion："你的项目有以下源码目录（从架构推导），哪些需要行为契约跟踪？逐个指定对应的 spec 文件名。"
> 表格式交互，允许跳过（首次可不配，后续按需）

将结果写入 config 的 `spec_mapping` 段。

### 第 5 步：自检框架调整

根据第 1-4 步的回答，生成 config 的 `checks` 段（各检测项开关 + 级别），并允许用户微调：

> AskUserQuestion："已根据你的架构生成以下自检项。要调整吗？"
> - 显示检测项清单（依赖方向/import/错误处理/测试归口/测试覆盖度/领域规则/契约同步/编译）
> - 允许：禁用某项（不适用你的项目）/ 调整级别（WARN↔FAIL）/ 保持默认

### 第 6 步：生成索引

根据 `.agents/templates/agents.md.tmpl` 结构，用采集的项目信息生成 `AGENTS.md`（覆盖占位文件），包含目录结构、规则清单、skill 清单、关键约定。

### 第 7 步：汇总确认

展示全部生成的产物清单：

```
✅ 初始化完成！已生成以下文件：
  - ARCHITECTURE.md（架构文档）
  - .agents/rules/coding-rule.md（编码规则）
  - .agents/rules/test-rule.md（测试规范）
  - .agents/rules/domain-extra-rule.md（领域规则，如有）
  - .agents/pipeline.config.yaml（流水线配置）
  - .agents/AGENTS.md（项目索引）

后续工作流：
  /facai-decision  决策建档（ADR）
  /facai-plan      计划生成
  /facai-coding    编码实现
  /facai-selfcheck 代码自检
  /facai-contract  契约更新
  /facai-review    语义审核
```

---

## 重新运行（增量更新）

向导支持**重新运行**（增量更新）：
- 项目架构演进后，重跑 `/facai-init`，向导检测现有 config 和规则文件
- 已有配置项作为默认值展示，用户可修改
- 修改后级联更新受影响的下游产物（rules、config、ARCHITECTURE.md）

---

## 领域规则增补机制说明

> 详见 `AGENTS.md` 的"领域规则增补机制"和方案文档"六补"节。

纯净版区分两种规则层次：

| 层次 | 文件 | 内容 | 来源 |
|------|------|------|------|
| 通用规则 | `coding-rule.md` | 与语言/架构相关的编码规范 | 本向导推导生成 |
| 领域规则 | `domain-extra-rule.md` | 特定业务领域的架构红线 | 本向导引导用户声明（3b 步）或后续手动补充 |

可静态检测的领域规则条目，自动收进 `pipeline.config.yaml` 的 `domain_checks` 段（与通用检测项统一检测源，selfcheck.py 只读 config，检测逻辑零分叉）。

涉及的 skill：facai-init（本技能，生成入口）、facai-selfcheck（检测来源）、facai-coding/facai-plan（读规则时含领域规则）、facai-review（基线材料含领域规则）、facai-contract（领域规则涉及契约时触发检查）。

---

## 质量检查清单

初始化完成后逐条确认：

- [ ] **ARCHITECTURE.md 生成**：模块清单、依赖方向图、分层约定完整
- [ ] **coding-rule.md 生成**：各章节按语言推导填充，无占位符残留
- [ ] **test-rule.md 生成**：测试归口目录、测试标识、命名约定按语言推导
- [ ] **domain-extra-rule.md**：如用户有领域红线则已填充，否则保留模板供后续补充
- [ ] **pipeline.config.yaml 完整**：project / commands / architecture / rules / domain_checks / checks / spec_mapping 各段已填充
- [ ] **dry-run 校验通过**：所有检测 grep 模式语法正确、路径存在
- [ ] **AGENTS.md 生成**：覆盖占位文件，项目信息完整
- [ ] **推导说明已删除**：coding-rule.md 顶部的"推导说明"段（仅供向导参考）已在生成后删除
