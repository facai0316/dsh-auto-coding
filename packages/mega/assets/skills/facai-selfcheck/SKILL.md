---
name: facai-selfcheck
description: 依据项目的 ARCHITECTURE.md、coding-rule.md、test-rule.md、domain-extra-rule.md 与 spec/（行为契约）执行自动化代码自检，覆盖模块依赖方向红线、错误处理与日志规范、测试代码归口规范、测试覆盖度检查、行为契约同步检查（确定性缺失自动修补）、编译验证。检测项从 pipeline.config.yaml 读取，config 驱动。发现问题自动订正并迭代校验直到全部通过后提交推送。当用户要求自检、检查代码合规性、提交前 review、或调用 /facai-selfcheck 时使用。
---

# 代码自检

依据 `ARCHITECTURE.md`（架构边界）、`coding-rule.md`（编码规则）、`test-rule.md`（测试规范）、`domain-extra-rule.md`（领域红线，若存在）和 `spec/`（行为契约），对**新代码**执行自动化 + 人工 review。

> **检测项来源**：所有检测项从 `pipeline.config.yaml` 读取（init 向导生成），包括：
> - 通用检测项（依赖方向、import、错误处理、测试归口、测试覆盖度、契约同步、编译）
> - 领域规则检测项（`domain-extra-rule.md` 中可静态检测的条目，经 config `domain_checks` 段配置）
>
> selfcheck.py 只读 config，检测逻辑零分叉。

## 检查范围

**默认：增量模式**——只检查未合并到 `origin/main` 的新代码。

新代码包括：
- 当前分支已提交但未合并到 `origin/main` 的改动
- 本地 `main` 分支有但未推送到 `origin/main` 的提交
- 工作区中已暂存但未提交的改动
- 工作区中未暂存的改动
- 未追踪的新文件

基准点：`origin/main`。脚本通过 `git diff origin/main` + `git ls-files --others` 确定变更文件集，只对这些文件运行静态检查。

**`--all` 模式**：强制全量扫描源码目录下所有文件（用于全量回归或首次接入）。

**始终全量的检查**：编译检查不受增量模式影响——编译是全项目级的。

## 治理流程（检验 → 订正 → 校验 → 提交推送）

本技能遵循**闭环治理**原则：发现问题必须自动订正，订正后重新校验，循环迭代直到全部通过才可提交。**不可中途停止、不可跳过校验直接提交。**

```
检验（运行 selfcheck.py）
  ├─ FAIL = 0 且 WARN 全部确认/修复 → 全部通过 → 提交并推送
  └─ 有 FAIL 或待修 WARN → 自动订正 → 重新检验（回到起点）
```

1. **检验**：运行自检脚本，收集全部 FAIL / WARN
2. **订正**：对每个 FAIL 立即修复；对每个 WARN 判断是否为误报或可接受——需修复的立即订正，确认为误报/占位的在汇报中说明理由
3. **校验**：修复后重新运行自检脚本，确认问题已消除
4. **循环**：若仍有未通过项，重复步骤 2-3，直到 **FAIL = 0 且无待处理 WARN**
5. **提交并推送**：全部通过后，执行 `git add` → `git commit` → `git push`

> 红线：未经最终校验通过的代码不得提交。每次订正后必须重新运行脚本确认，不可凭主观判断跳过校验。

## 快速开始

**第一步：运行自检脚本**

```bash
python .agents/skills/facai-selfcheck/scripts/selfcheck.py
```

可选参数：
- `--fast`：跳过编译，仅做静态检查（秒级完成）
- `--all`：强制全量检查（忽略增量，扫描所有文件）

脚本退出码：`0` = 通过（可能含 WARN），`1` = 有 FAIL 必须修复。

**第二步：解读输出**

| 级别 | 含义 | 处理方式 |
|------|------|----------|
| `[PASS]` | 检查通过 | 无需处理 |
| `[PASS]（无新代码）` | 该目录下没有变更文件 | 跳过 |
| `[WARN]` | 存在风险，需人工确认 | 判断是否为误报或可接受 |
| `[FAIL]` | 违反红线规则 | **必须修复后才能提交** |

**第三步：执行下方人工 Review Checklist**

脚本只能覆盖可静态分析的规则；注释命名、复用组织等需人工 review。

## 脚本检查项（自动化，从 config 动态组装）

> 以下检测项由 selfcheck.py 从 `pipeline.config.yaml` 动态组装，具体 pattern 和路径取决于项目配置。

| 分组 | 检查内容 | 来源 | 范围 | 级别 |
|------|----------|------|------|------|
| §依赖方向 | 反向依赖（从 `architecture.dependencies` 推导禁止方向） | config `architecture` | 增量 | FAIL |
| §import | 禁止的多级相对路径（如 `super::super::`） | config `rules.forbidden_relative` | 增量 | WARN |
| §错误处理 | 禁止的 panic 类 API、禁止的打印语句 | config `rules.forbidden_panics` / `forbidden_print` | 增量 | WARN |
| §测试归口 | 业务源码散落测试代码（从 `rules.test_markers` 检测） | config `rules.test_markers` / `test_dir` | 增量 | FAIL |
| §测试覆盖度 | 含可测逻辑的业务模块缺少测试覆盖 | 通用框架 | 增量 | WARN |
| §领域规则 | 领域专用红线检测 | config `domain_checks` | 增量 | 按配置 |
| §行为契约同步 | 契约相关源码变更但 spec 未同步；确定性缺失自动修补 | config `spec_mapping` | 增量 | WARN / 自动修补 |
| §编译 | 编译检查 + 可选 lint | config `commands.build` / `lint` | 全量 | FAIL |

## 人工 Review Checklist

逐条确认（脚本无法可靠自动化），检查范围为本次新增/修改的代码：

- [ ] **import 规范**：跨模块引用遵守项目依赖方向（见 `ARCHITECTURE.md`），内部引用用模块内方式
- [ ] **可见性**：新增模块已在对应入口文件登记；内部实现未滥用可见性修饰符
- [ ] **注释**：公开函数有文档注释；模块有职责说明；注释语言遵循项目约定
- [ ] **复用（语义级重复检测）**：脚本无法检测重复代码，由 Agent 用语义能力判断：
  - **改名复制粘贴**：判断是否有「仅变量名/类型名不同，控制流和结构完全一致」的代码段。发现即标记，提示提取公共函数。
  - **结构性重复**：多个函数是否走了「几乎相同的编排步骤」，仅中间细节不同。发现则提示抽象为泛型或接口。
  - **判断标准**：8 行以上、仅表面差异而核心逻辑相同的代码段视为重复；模板代码不算。
  - **社区调研**：新增的复杂功能，是否已先调研生态有无成熟方案，而非直接手写。

## 文件级忽略标记

在源码文件中添加注释标记，可让脚本跳过该文件的特定 WARN 检查：

| 标记 | 跳过的检查 | 适用场景 |
|------|----------|----------|
| `selfcheck:ignore-coverage` | 测试覆盖度 WARN | 声明式框架生成的 CRUD 转发层、路由注册、纯配置代码等不适合单测的文件 |
| `selfcheck:ignore-contract` | 行为契约同步 WARN | 文件变更不涉及行为变化（如纯路径重构、格式调整） |
| `selfcheck:ignore-unwrap` | 禁止 panic 类 API WARN | 静态正则/常量等「不可能失败」惯用法 |
| `selfcheck:ignore-println` | 禁止打印语句 WARN | CLI 占位输出豁免 |

标记放在文件头部（模块注释之后、import 之前），一行即可。

> 注意：`ignore-contract` 是按目录前缀批量检测的——只有该前缀下**所有**变更文件都标记了才跳过。部分文件标记不会生效。

---

## 结果汇报格式

自检完成后，向用户汇报应包含：

```
自检完成：PASS: N | WARN: N | FAIL: N
检查范围：增量（N 个文件） / 全量
[如有 FAIL] 必须修复的项：...
[如有 WARN] 需确认的项：...
```
