import { a as ProjectsRepo, d as RequirementsRepo, f as ReviewsRepo, m as WorkerConfigRepo, o as QuestionsRepo, r as DEFAULT_WORKER_CONFIG } from "./flow-repo-DTcyZK_k.js";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
//#region build/skills-source.js
/**
* Skills source resolution for the coding-pipeline worker (plan 10, decision 4
* / P3, revised 2026-08-16): where the facai skills come from when a project
* has not run `facai-init`.
*
* The plugin does NOT bundle any skills — the facai skills are project- and
* org-specific (they encode fac-ai-rs rules and workflows), so shipping them
* in the plugin would be wrong for every other project. The pipeline always
* reads the project's own `.agents/skills/<skill>/SKILL.md` first; a
* configured external source (`dir` | `git`) is an optional fallback for
* teams that keep a shared skills repo:
*
*  - `dir` — an absolute directory laid out as `<dir>/<skill>/SKILL.md`;
*  - `git` — a git repo cloned on demand into a content-addressed cache dir
*    (`<tmp>/auto-coding-skills/<hash-of-url+ref>`), laid out the same way.
*
* With no `skillsSource` configured, missing skills fail loudly with a
* message telling the user to put the skills in the project (run
* `/facai-init` from the coding-pipline-skills repo, see the README).
*
* Decorator-free so vitest/esbuild can exercise it directly.
*
* @module @auto-coding/mega/skills-source
*/
/** Validate a raw row config value; absent/unknown kinds mean "no external source". */
function normalizeSkillsSource(input) {
	if (input === void 0 || input === null || typeof input !== "object") return void 0;
	const raw = input;
	if (raw.kind === "dir") {
		if (typeof raw.path !== "string" || raw.path === "") throw new Error("skillsSource kind=dir 需要非空 path");
		return {
			kind: "dir",
			path: raw.path
		};
	}
	if (raw.kind === "git") {
		if (typeof raw.url !== "string" || raw.url === "") throw new Error("skillsSource kind=git 需要非空 url");
		return {
			kind: "git",
			url: raw.url,
			ref: typeof raw.ref === "string" && raw.ref !== "" ? raw.ref : void 0
		};
	}
}
/**
* Resolve one skill directory (the dir whose `SKILL.md` is the skill body)
* from the configured external source. Returns undefined when no source is
* configured or the source does not provide the skill.
*/
var SkillSource = class {
	config;
	constructor(config) {
		this.config = config;
	}
	/** All skill names this source provides (empty with no source). */
	list() {
		const root = this.root();
		if (root === void 0) return [];
		try {
			return readdirSync(root).filter((name) => {
				try {
					return existsSync(join(root, name, "SKILL.md"));
				} catch {
					return false;
				}
			});
		} catch {
			return [];
		}
	}
	/** The directory holding `<skill>/SKILL.md`, or undefined. */
	skillDir(skill) {
		const root = this.root();
		if (root === void 0) return void 0;
		const dir = join(root, skill);
		try {
			return existsSync(join(dir, "SKILL.md")) ? dir : void 0;
		} catch {
			return;
		}
	}
	root() {
		switch (this.config?.kind) {
			case "dir": return existsSync(this.config.path) ? this.config.path : void 0;
			case "git": return this.gitRoot();
			default: return;
		}
	}
	/** Clone (once per url+ref, cached) and return the checkout dir. */
	gitRoot() {
		if (this.config?.kind !== "git") return void 0;
		const key = createHash("sha1").update(`${this.config.url}#${this.config.ref ?? "HEAD"}`).digest("hex").slice(0, 12);
		const cache = join(tmpdir(), "auto-coding-skills", key);
		if (existsSync(join(cache, ".git"))) return cache;
		try {
			mkdirSync(cache, { recursive: true });
			const args = [
				"clone",
				"--depth",
				"1"
			];
			if (this.config.ref !== void 0) args.push("--branch", this.config.ref);
			args.push(this.config.url, cache);
			execFileSync("git", args, { stdio: "ignore" });
			return cache;
		} catch {
			return;
		}
	}
};
//#endregion
//#region build/worktree.js
/**
* cm-worktree — git worktree lifecycle manager for the coding pipeline.
* One task = one branch + one worktree; branches are isolated (own HEAD/index/
* worktree) while the object store is shared. Build artifacts (e.g. Rust
* `target/`) can be shared through a symlink so dependencies compile once.
*
* Commands are constructed as argument arrays and executed with
* `execFile('git', ...)` — never a shell string — and restricted to the
* documented whitelist. This module is deliberately dsh-free so it can be
* unit-tested against a real throwaway git repository and reused by the
* worker and the PR agent task.
*
* @module @auto-coding/cm-worktree
*/
function defaultWorktreeRoot(repo) {
	return join(dirname(repo), "worktrees", basenameOf(repo));
}
function basenameOf(repo) {
	return (repo.split(/[\\/]/).filter(Boolean).pop() ?? "repo").replace(/\.git$/, "");
}
/**
* One task branch + worktree lifecycle. All git commands run with `-C <repo>`
* except where a worktree-local operation needs its own cwd (push).
*/
var WorktreeManager = class {
	repo;
	worktreeRoot;
	constructor(options) {
		this.repo = resolve(options.repo);
		this.worktreeRoot = resolve(options.worktreeRoot ?? defaultWorktreeRoot(this.repo));
	}
	/** Absolute worktree path for a branch (regardless of existence). */
	pathFor(branch) {
		return join(this.worktreeRoot, branch);
	}
	/**
	* Create the task branch + worktree. Idempotent: an existing worktree at the
	* same path is returned as-is. `base` defaults to `origin/main`; the local
	* remote-tracking ref must exist (a best-effort `fetch origin` is attempted).
	*/
	async create(branch, base = "origin/main") {
		const path = this.pathFor(branch);
		if (existsSync(path)) return {
			path,
			branch,
			base
		};
		mkdirSync(this.worktreeRoot, { recursive: true });
		try {
			this.git([
				"fetch",
				"origin",
				"--quiet"
			]);
		} catch {}
		this.git([
			"worktree",
			"add",
			path,
			"-b",
			branch,
			base
		]);
		return {
			path,
			branch,
			base
		};
	}
	/**
	* Symlink the task worktree's build dir (e.g. `target`) onto the primary
	* checkout's, so dependencies compile once. No-op when either side is absent
	* or the target already exists.
	*/
	linkSharedTarget(handle, targetDir = "target") {
		const wtTarget = join(handle.path, targetDir);
		const repoTarget = join(this.repo, targetDir);
		if (existsSync(wtTarget)) return;
		if (!existsSync(repoTarget)) return;
		symlinkSync(relative(dirname(wtTarget), repoTarget), wtTarget, "dir");
	}
	/**
	* Commit every uncommitted change in the task worktree to its branch.
	* Pipeline stages（facai-coding 等技能默认不 git commit）留下的未提交产物
	* 由流水线在阶段成功后兜底提交——否则 merge 的 push 只推已提交内容，PR 会
	* 漏掉全部代码。无改动时 no-op（返回 false）。target 等已被 .gitignore 排除。
	*/
	async commitAll(wtPath, message) {
		this.git(["add", "-A"], wtPath);
		try {
			this.git([
				"diff",
				"--cached",
				"--quiet"
			], wtPath);
			return false;
		} catch {
			this.git([
				"commit",
				"-m",
				message
			], wtPath);
			return true;
		}
	}
	/** Push the task branch to the remote (run inside the worktree). */
	async push(handle, remote = "origin") {
		this.git([
			"push",
			"-u",
			remote,
			handle.branch
		], handle.path);
	}
	/** Whether the task branch is fully merged into `target` (e.g. origin/main). */
	async isMerged(handle, target = "origin/main") {
		return this.git([
			"branch",
			"--merged",
			target
		]).split("\n").some((line) => line.trim().replace(/^[*+]\s*/, "") === handle.branch);
	}
	/** Post-merge teardown: remove the worktree dir and delete the local branch. */
	async remove(handle) {
		this.git([
			"worktree",
			"remove",
			"--force",
			handle.path
		]);
		this.git([
			"branch",
			"-D",
			handle.branch
		]);
	}
	/**
	* Post-merge sync: switch the primary checkout onto `main` and pull, so the
	* merged PR lands in the local main branch. `--ff-only` keeps the sync strict
	* — a diverged local main fails loudly instead of fabricating a merge commit.
	*/
	async pullMain(branch = "main") {
		this.git(["checkout", branch]);
		this.git(["pull", "--ff-only"]);
	}
	/** Run git synchronously with args; cwd defaults to the primary checkout. */
	git(args, cwd) {
		try {
			return execFileSync("git", [
				"-C",
				cwd ?? this.repo,
				...args
			], {
				maxBuffer: 16777216,
				encoding: "utf8"
			});
		} catch (error) {
			const err = error;
			const detail = err.stderr ?? err.message;
			throw new Error(`git ${args.join(" ")} 失败: ${String(detail).trim()}`);
		}
	}
};
//#endregion
//#region build/worker-pipeline.js
/**
* Stage orchestration — pure, dependency-injected logic for the coding
* pipeline worker: claim → stage chain → records ledger → decision channel
* hooks. Cordis-free so it can be tested with fake executors against the real
* `cm` database.
* @module @auto-coding/cm-worker/pipeline
*/
/**
* 需要人工审核的产物阶段（立即门禁）：阶段成功后直接挂起为 `waiting_review`
* 并生成一张 kind='review' 的审核单，等在审核大厅通过后才继续；
* 驳回带整改意见 → 复用同一 record 携反馈重跑。
*/
const REVIEW_GATED = ["decision"];
const DEFERRED_REVIEW_GATES = [{
	category: "plan",
	anchor: "review-plan"
}];
const STAGES = [
	{
		category: "decision",
		skill: "facai-decision",
		instruction: "产出 ADR 至 decisions/；方案多选时用 questions 返回 {question, options}。"
	},
	{
		category: "plan",
		skill: "facai-plan",
		instruction: "产出 docs/plans/ 下的实现计划；只规划不实现。"
	},
	{
		category: "review-plan",
		skill: "facai-review",
		instruction: "独立审读实现计划；与用户预期/架构冲突时用 questions 提问，可直改计划。"
	},
	{
		category: "coding",
		skill: "facai-coding",
		instruction: "按计划落地为可编译代码，并自动执行 facai-selfcheck 闭环。"
	},
	{
		category: "contract",
		skill: "facai-contract",
		instruction: "按变更同步 spec/ 行为契约；语义不明确时用 questions 提问。"
	},
	{
		category: "review-code",
		skill: "facai-review",
		instruction: "独立审读代码；与架构/规则冲突直接修改。"
	}
];
/**
* 时段门控：当前时刻是否落在配置窗口内。小时粒度（含 start、不含 end）；
* start>end 视为跨天窗口（如 22:00→06:00）；起=止视为不限制。disabled 恒为 true。
*/
function withinWindow(config, now = /* @__PURE__ */ new Date()) {
	if (config.timeWindowEnabled !== true) return true;
	const hour = now.getHours();
	const start = config.startHour;
	const end = config.endHour;
	if (start === end) return true;
	if (start < end) return hour >= start && hour < end;
	return hour >= start || hour < end;
}
/**
* 每阶段时段门控：某阶段此刻是否允许起跑。
* - 未启用时段 → 恒 true；
* - 阶段清单缺省（null/undefined，旧配置）→ 全部阶段受限（等价 withinWindow）；
* - 清单内阶段按 withinWindow 判定，清单外阶段（未勾选）恒 true（24h 可跑）。
*/
function stageWindowAllowed(config, category, now = /* @__PURE__ */ new Date()) {
	if (config.timeWindowEnabled !== true) return true;
	const limited = config.timeWindowStages;
	if (limited === null || limited === void 0) return withinWindow(config, now);
	if (!limited.includes(category)) return true;
	return withinWindow(config, now);
}
/**
* 并发 lanes：同时启动 `count` 个流水线（每个领取并跑一条需求）。
* 领取用 `for update skip locked`，并发安全；返回实际跑起来的条数。
* count 已由调用方钳制（1..MAX_CONCURRENCY）。
*/
async function runLanes(count, run) {
	return (await Promise.all(Array.from({ length: count }, () => run()))).filter(Boolean).length;
}
/** 解析 PR 任务结构化输出；`is_ok` 兼容 boolean 与字符串 `"true"`。 */
function parsePrResult(value) {
	if (value === null || typeof value !== "object") return null;
	const v = value;
	if (v.is_ok !== true && v.is_ok !== "true" && v.is_ok !== false && v.is_ok !== "false") return null;
	return {
		isOk: v.is_ok === true || v.is_ok === "true",
		prUrl: typeof v.pr_url === "string" ? v.pr_url : void 0,
		error: typeof v.error === "string" ? v.error : void 0
	};
}
/**
* 组装 PR 创建任务的指导指令（方案 §8）。
*
* token 直接注入指令正文（本地个人部署可接受；子进程环境会做凭据清洗、
* shellEnv 只放行 DSH_* 键，$PR_TOKEN 环境变量通道在本部署不可用）。
* 约束：token 只用于 Authorization 头，不得写入 git 提交、records 或输出回显。
*/
function buildPrPrompt(input) {
	return [
		"你是 PR 创建任务，只做一件事：把当前分支创建为 Pull Request，返回 JSON。",
		"",
		"# 工作根目录",
		input.wtPath,
		"",
		"# 步骤",
		`1. git -C ${input.wtPath} remote get-url origin → 取 host`,
		"2. 判断平台：host 含 \"gitee.com\" → Gitee；否则 → Gitea",
		"3. 解析 owner/repo：git@gitee.com:o/r.git 或 https://host/o/r.git → owner=o, repo=r",
		"4. 建 PR（凭证已直接给出，见下方 PR_TOKEN）：",
		"   Gitee: POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls",
		"   Gitea: POST https://<host>/api/v1/repos/{owner}/{repo}/pulls",
		"   header:  Authorization: token <PR_TOKEN 值，直接使用，不要写进任何 git/文件/输出>",
		`   body:    { "title": ${JSON.stringify(input.title)}, "head": ${JSON.stringify(input.branch)}, "base": "main", "body": ${JSON.stringify(input.description ?? "")} }`,
		"5. 返回 JSON（唯一契约）：",
		"   成功：{\"is_ok\":\"true\",\"pr_url\":\"<PR 链接>\"}",
		"   失败：{\"is_ok\":\"false\",\"error\":\"<原因>\"}",
		"",
		"注意：若遇到需要用户确认才能继续的不确定点（如目标分支、仓库归属），不要遇到一个问题问一个；",
		"先把所有不确定点攒齐、全部过一遍，确认没有其他问题要确认了，再一次性在 error 中完整列出。",
		"",
		"# PR_TOKEN",
		input.token
	].join("\n");
}
/**
* 组装「解决冲突」任务的指导指令（merge 阶段的用户按钮触发）。
*
* 任务：把任务分支与远端 main 同步（fetch + merge）、解决合并冲突、commit +
* push。需要用户决策时不中断——把所有不确定点攒齐，一次性放进结构化结果
* questions 字段（与阶段通道一致：worker 落 waiting_reply + ask_user_questions，
* 答完放行后携答复续跑，工作区未提交的冲突解决保留）。
*/
function buildResolvePrompt(input) {
	const lines = [
		"你是 FacAI 编码流水线的「冲突解决」任务执行者，只做一件事：把任务分支与远端 main 同步并解决合并冲突，返回 JSON。",
		"",
		"# 工作根目录",
		input.wtPath,
		"（所有 git/文件操作以此目录为 workdir/cwd；不要改动其他目录）",
		"",
		"# 背景",
		`任务分支：${input.branch}（本 worktree 当前所在分支）`,
		"目标分支：origin/main",
		`需求标题：${input.title}`,
		`需求描述：${input.description ?? "（无）"}`,
		"",
		"# 步骤",
		`1. git -C ${input.wtPath} fetch origin`,
		`2. git -C ${input.wtPath} merge origin/main`,
		"   - 无冲突：直接进入第 4 步。",
		"   - 有冲突：逐个文件解决。保留任务分支的实现意图，同时兼容远端 main 的改动；",
		"     不确定怎么合并的地方先记下来，不要中断（见下方「用户决策」）。",
		`3. git -C ${input.wtPath} add -A && git -C ${input.wtPath} commit -m "resolve merge conflicts with origin/main"`,
		`4. git -C ${input.wtPath} push`,
		"   - 若 push 被拒（远端有新提交）：git pull --rebase origin main 后重试 push。",
		"5. 返回 JSON（唯一契约）：",
		"   成功：{\"isError\":false,\"message\":\"<一句话说明解决了什么>\",\"artifacts\":[\"<提交 hash>\"],\"questions\":[]}",
		"   需要用户决策：{\"isError\":false,\"message\":\"需要决策\",\"artifacts\":[],\"questions\":[{question, options}]}",
		"     （此时不要 commit；把已解决的冲突留在工作区，答复回来后继续）",
		"   失败：{\"isError\":true,\"message\":\"<原因>\",\"artifacts\":[],\"questions\":[]}"
	];
	if (input.userAnswers.length > 0) {
		lines.push("", "# 用户答复（续跑上下文）");
		for (const answer of input.userAnswers) lines.push(`Q: ${answer.question}  A: ${answer.answer}`);
	}
	lines.push("", "# 用户决策（重要）", "本会话是流水线子代理：ask_user_question 工具在此不可用，调用会被拒绝（错误信息会提示你把问题放入最终结果）。", "当需要用户决策时：不要调用 ask_user_question；在最终结构化结果中返回 questions=[{question, options}]。", "流水线会自动把该 record 标记为 waiting_reply、把每题写入 ask_user_questions，并在审核大厅等你作答；", "全部答完并审核通过后，本任务会携你的答复自动续跑。", "options 为空数组表示自由输入；每题尽量给出 2-5 个选项。", "注意不要遇到一个问题问一个，遇到问题先攒下并继续推理，确认所有问题都过了一遍，没有其他问题要确认了再一起发。");
	return lines.join("\n");
}
const CLAIM_SQL = `
  update requirements r
  set status = 'in_progress', updated_at = now()
  where r.id = (
    select r2.id from requirements r2
    where r2.status = 'open' and r2.project_id is not null
    order by r2.created_at asc limit 1
    for update skip locked
  )
  returning r.id, r.project_id, r.title, r.description
`;
/**
* 判断一条 artifacts 条目是否应作为「相对文件路径」做存在性校验。
* 产物的既有约定是「相对路径, commit…」——commit 描述（如
* `edd5302 docs(decision): …` / `commit 05b3898 …`）含空白，跳过；
* 只校验不含空白的相对路径条目。
*/
function isPathArtifact(entry) {
	const trimmed = (entry ?? "").trim();
	if (trimmed === "") return false;
	if (/\s/.test(trimmed)) return false;
	return !trimmed.startsWith("commit");
}
/**
* 产物存在性校验：把声明为相对路径的 artifacts 逐一对照 worktree 真实文件系统，
* 返回不存在的路径列表（空数组 = 全部真实存在）。防「幽灵产物」——会话声称
* success 但产物根本没落盘（如旧进程曾出现的 `docs/plans/001.md` 幻影路径）。
*/
async function missingArtifacts(wtPath, artifacts, exists) {
	const missing = [];
	for (const entry of artifacts ?? []) {
		if (!isPathArtifact(entry)) continue;
		if (!await exists(wtPath, entry)) missing.push(entry);
	}
	return missing;
}
/** 组装阶段会话 prompt（00 §4.7 模板）。 */
function buildPrompt(input) {
	const lines = [
		`你是 FacAI 编码流水线的「${input.stage.category}」阶段执行者。`,
		"",
		`# 工作根目录`,
		input.wtPath,
		"（所有文件/git 操作以此目录为 workdir/cwd）",
		"",
		"# 项目规范",
		`阅读 ${input.repo}/.agents/AGENTS.md、${input.repo}/.agents/rules/*.md`,
		"",
		"# 技能指令",
		input.skillMd
	];
	if (input.stage.instruction !== void 0) lines.push("", "# 阶段专属指令", input.stage.instruction);
	lines.push("", "# 用户决策（重要）", "本会话是流水线子代理：ask_user_question 工具在此不可用，调用会被拒绝（错误信息会提示你把问题放入最终结果）。", "当需要用户决策时：不要调用 ask_user_question；在最终结构化结果中返回 questions=[{question, options}]。", "流水线会自动把该 record 标记为 waiting_reply、把每题写入 ask_user_questions，并在审核大厅等你作答；", "全部答完并审核通过后，本阶段会携你的答复自动续跑。", "options 为空数组表示自由输入；每题尽量给出 2-5 个选项。", "注意不要遇到一个问题问一个，遇到问题先攒下并继续推理，确认所有问题都过了一遍，没有其他问题要确认了再一起发。");
	if (input.feedback !== void 0 && input.feedback.trim() !== "") lines.push("", "# 审核整改意见（驳回重跑）", `上一版产物未通过人工审核，以下整改意见必须逐条落实：`, input.feedback.trim(), "请基于已有产物修订（不要推翻需求），完成后照常返回结构化结果。");
	lines.push("", "# 需求", `标题：${input.title}`, `描述：${input.description ?? "（无）"}`);
	if (input.priorArtifacts.length > 0) lines.push("", "# 前序产物（相对 worktree 根）", ...input.priorArtifacts.map((a) => `- ${a}`));
	if (input.userAnswers.length > 0) {
		lines.push("", "# 用户答复（续跑上下文）");
		for (const answer of input.userAnswers) lines.push(`Q: ${answer.question}  A: ${answer.answer}`);
	}
	lines.push("", "# 返回要求", "完成后以结构化结果返回（字段见 outputSchema）：", "- 成功：isError=false，artifacts=[产物相对路径, commit…]", "- 需要用户决策：questions=[{question, options}]", "- 失败：isError=true，message=原因");
	return lines.join("\n");
}
/** 解析阶段会话结构化输出；非法结构视为阶段失败。 */
function parseStageResult(value) {
	if (value === null || typeof value !== "object") return null;
	const v = value;
	const questions = Array.isArray(v.questions) ? v.questions.map((q) => {
		const item = q;
		return {
			question: typeof item.question === "string" ? item.question : "",
			options: Array.isArray(item.options) ? item.options.map((o) => String(o)) : []
		};
	}) : [];
	return {
		isError: v.isError === true,
		message: typeof v.message === "string" ? v.message : "",
		artifacts: Array.isArray(v.artifacts) ? v.artifacts.map((a) => String(a)) : [],
		questions
	};
}
/**
* Claim → stage chain → ledger. One instance per worker service. 领取/派发查询
* （claim / listActionableReviews / listRetryable）由 tick 串行调用；续跑/重试
* （runClaimed / processReviewAction / processRetryRow）可并行执行——DB 侧靠
* 状态机（open 领取原子、waiting 记录一旦续跑即离开挂起态）保证不重复处理。
*/
var WorkerPipeline = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/** ①a 领取一条 open 需求（原子：for update skip locked，open → in_progress）。 */
	async claim() {
		const claim = (await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(CLAIM_SQL))).rows[0];
		if (claim === void 0) return void 0;
		return {
			id: claim.id,
			projectId: claim.project_id,
			title: claim.title,
			description: claim.description
		};
	}
	/** ①b 跑一条已领取的需求（建 worktree + 阶段链）。 */
	async runClaimed(claim) {
		const project = await this.deps.projects.getById(claim.projectId);
		if (project === void 0) throw new Error(`领取的需求 ${claim.id} 关联的项目不存在`);
		const wt = this.deps.worktreeFor(project);
		const handle = await wt.create(`req-${claim.id.slice(0, 8)}`, "origin/main");
		wt.linkSharedTarget(handle);
		if (this.deps.provisionSkills !== void 0) try {
			await this.deps.provisionSkills(handle.path);
		} catch (error) {
			console.warn(`[cm-worker] skills 预装失败（继续）: ${error instanceof Error ? error.message : String(error)}`);
		}
		await this.runPipeline({
			id: claim.id,
			title: claim.title,
			description: claim.description,
			project,
			wt: handle
		});
		return true;
	}
	/** ① 领取一条 open 需求并跑阶段链。返回是否领到并开始处理。 */
	async claimAndRun() {
		const claim = await this.claim();
		if (claim === void 0) return false;
		return this.runClaimed(claim);
	}
	/**
	* 阶段链：按 STAGES 顺序推进；waiting/failed/terminated 时停止。
	* `resume` 从挂起阶段复用 record 续跑；`from` 从某阶段新 append record 开始（重试后继续）。
	*/
	async runPipeline(input, opts) {
		const resume = opts?.resume;
		const from = opts?.from;
		const startIndex = resume !== void 0 ? STAGES.findIndex((s) => s.category === resume.category) : from !== void 0 ? STAGES.findIndex((s) => s.category === from.category) : 0;
		if ((resume !== void 0 || from !== void 0) && startIndex < 0) throw new Error(`续跑失败：未知阶段 ${resume?.category ?? from?.category}`);
		for (let i = startIndex; i < STAGES.length; i++) {
			const stage = STAGES[i];
			const stageOpts = resume !== void 0 && i === startIndex ? {
				recordId: resume.recordId,
				userAnswers: resume.userAnswers
			} : void 0;
			const outcome = await this.runStage(input, stage, stageOpts);
			if (outcome === "waiting" || outcome === "failed" || outcome === "terminated" || outcome === "deferred") return outcome;
		}
		return this.runMerge(input);
	}
	/** 单阶段：prompt → 会话 → 结构化结果 → 记账。带 recordId 时为续跑（复用该 record）。 */
	async runStage(requirement, stage, opts) {
		if (this.deps.windowFor !== void 0 && !this.deps.windowFor(stage.category)) return "deferred";
		const recordId = opts?.recordId;
		const userAnswers = opts?.userAnswers ?? [];
		const feedback = opts?.feedback;
		const current = await this.deps.requirements.getById(requirement.id);
		if (current !== void 0 && current.status === "terminated") {
			if (recordId !== void 0) await this.deps.requirements.updateRecord(recordId, {
				status: "terminated",
				result: "需求已终止，阶段不再执行"
			});
			else await this.deps.requirements.appendRecord({
				requirementId: requirement.id,
				category: stage.category,
				status: "terminated",
				branchId: requirement.wt.branch,
				skills: [stage.skill],
				result: "需求已终止，阶段不再执行"
			});
			return "terminated";
		}
		const record = recordId === void 0 ? await this.deps.requirements.appendRecord({
			requirementId: requirement.id,
			category: stage.category,
			status: "running",
			branchId: requirement.wt.branch,
			skills: [stage.skill]
		}) : opts?.retry === true ? await this.deps.requirements.markRetrying(recordId) : await this.deps.requirements.updateRecord(recordId, { status: "running" });
		let skillMd;
		try {
			skillMd = await this.deps.readSkillMd(requirement.project.localPath, stage.skill);
		} catch {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: `技能 ${stage.skill} 不存在：${requirement.project.localPath}/.agents/skills/${stage.skill}/SKILL.md（项目需先跑 facai-init）`
			});
			return "failed";
		}
		const prior = await this.priorArtifacts(requirement.id);
		const prompt = buildPrompt({
			stage,
			wtPath: requirement.wt.path,
			repo: requirement.project.localPath,
			skillMd,
			title: requirement.title,
			description: requirement.description,
			priorArtifacts: prior,
			userAnswers,
			feedback
		});
		let execution;
		try {
			execution = await this.deps.executor.run({
				category: stage.category,
				skill: stage.skill,
				wtPath: requirement.wt.path,
				repo: requirement.project.localPath,
				title: requirement.title,
				description: requirement.description,
				priorArtifacts: prior,
				userAnswers,
				feedback,
				prompt
			}, this.deps.configFor(stage.category));
		} catch (error) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: `会话执行异常：${error instanceof Error ? error.message : String(error)}`
			});
			return "failed";
		}
		if (execution.stopReason !== "completed") {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: `会话未完成（stopReason=${execution.stopReason}）`
			});
			return "failed";
		}
		const result = parseStageResult(execution.structured);
		if (result === null) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: "会话未返回合法的结构化结果"
			});
			return "failed";
		}
		if (result.questions.length > 0) {
			await this.deps.questions.insertMany(record.id, result.questions);
			await this.deps.reviews.ensureReply(record.id);
			await this.deps.requirements.updateRecord(record.id, {
				status: "waiting_reply",
				result: "awaiting user reply"
			});
			return "waiting";
		}
		if (result.isError) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: result.message || "阶段报告失败"
			});
			return "failed";
		}
		const missing = await missingArtifacts(requirement.wt.path, result.artifacts, this.deps.artifactExists);
		if (missing.length > 0) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: `产物校验失败：以下声明产物在 worktree 中不存在：${missing.join("、")}（会话可能未真正产出/未提交，等待自动重试或人工介入）`
			});
			return "failed";
		}
		if (this.deps.commitWorktree !== void 0) try {
			await this.deps.commitWorktree({
				id: requirement.project.id,
				localPath: requirement.project.localPath
			}, requirement.wt.path, `${stage.category}(pipeline): 阶段产物提交 (req-${requirement.id.slice(0, 8)})`);
		} catch (error) {
			console.warn(`[cm-worker] 阶段 ${stage.category} 兜底提交失败（不阻断）: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (REVIEW_GATED.includes(stage.category)) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "waiting_review",
				result: result.message || "ok",
				artifacts: result.artifacts
			});
			await this.deps.reviews.create(record.id, "review");
			return "waiting";
		}
		await this.deps.requirements.updateRecord(record.id, {
			status: "success",
			result: result.message || "ok",
			artifacts: result.artifacts
		});
		const deferred = DEFERRED_REVIEW_GATES.find((gate) => gate.anchor === stage.category);
		if (deferred !== void 0) {
			const target = await this.deps.requirements.latestRecordByCategory(requirement.id, deferred.category);
			if (target !== void 0) {
				await this.deps.requirements.updateRecord(target.id, { status: "waiting_review" });
				await this.deps.reviews.create(target.id, "review");
				return "waiting";
			}
		}
		return "success";
	}
	/**
	* merge 阶段：push 分支 → PR agent 任务 → `markMerging`（in_progress→merging，
	* 记 merge record artifacts=[pr_url]）。无 token / 建 PR 失败 → 挂起
	* waiting_reply（用户补 token 或手动建 PR 后点「已合并」）。
	*/
	async runMerge(requirement, opts) {
		if (this.deps.windowFor !== void 0 && !this.deps.windowFor("merge")) return "deferred";
		const recordId = opts?.recordId;
		const current = await this.deps.requirements.getById(requirement.id);
		if (current !== void 0 && current.status === "terminated") {
			if (recordId !== void 0) await this.deps.requirements.updateRecord(recordId, {
				status: "terminated",
				result: "需求已终止，阶段不再执行"
			});
			else await this.deps.requirements.appendRecord({
				requirementId: requirement.id,
				category: "merge",
				status: "terminated",
				branchId: requirement.wt.branch,
				skills: [],
				result: "需求已终止，阶段不再执行"
			});
			return "terminated";
		}
		const record = recordId === void 0 ? await this.deps.requirements.appendRecord({
			requirementId: requirement.id,
			category: "merge",
			status: "running",
			branchId: requirement.wt.branch,
			skills: []
		}) : await this.deps.requirements.updateRecord(recordId, { status: "running" });
		await this.deps.worktreeFor(requirement.project).push(requirement.wt);
		const token = await this.deps.projects.getToken(requirement.project.id);
		if (token === void 0) {
			await this.deps.questions.insertMany(record.id, [{
				question: "PR token 未配置。请到面板项目管理填入 Gitee/Gitea access token；或手动建 PR 后点「已合并」。",
				options: []
			}]);
			await this.deps.reviews.ensureReply(record.id);
			await this.deps.requirements.updateRecord(record.id, {
				status: "waiting_reply",
				result: "awaiting pr token"
			});
			return "waiting";
		}
		const prompt = buildPrPrompt({
			wtPath: requirement.wt.path,
			repo: requirement.project.localPath,
			title: requirement.title,
			description: requirement.description,
			branch: requirement.wt.branch,
			token
		});
		let pr;
		try {
			pr = await this.deps.executor.runPr({
				prompt,
				repo: requirement.project.localPath,
				wtPath: requirement.wt.path
			}, this.deps.configFor("merge"));
		} catch (error) {
			pr = {
				isOk: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
		if (pr.isOk && pr.prUrl !== void 0) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "success",
				result: "PR created",
				artifacts: [pr.prUrl]
			});
			await this.deps.requirements.markMerging(requirement.id, pr.prUrl);
			return "success";
		}
		await this.deps.questions.insertMany(record.id, [{
			question: `建 PR 失败：${pr.error ?? "未知原因"}。可补 token 后重试，或手动建 PR 后点「已合并」。`,
			options: []
		}]);
		await this.deps.reviews.ensureReply(record.id);
		await this.deps.requirements.updateRecord(record.id, {
			status: "waiting_reply",
			result: "pr creation failed"
		});
		return "waiting";
	}
	/**
	* 「解决冲突」任务（merge 阶段的用户按钮触发）：把任务分支与远端 main 同步
	* （fetch + merge）、解决合并冲突、commit + push。需要用户决策时不中断——
	* 一次性把问题放进结构化结果 questions → 挂 waiting_reply + ask_user_questions
	* + reply 放行单；答完 + 审核通过后由 processReviews 携答复续跑（复用同一
	* record，工作区已解决的冲突保留）。
	*/
	async runResolve(requirement, opts) {
		const recordId = opts?.recordId;
		const userAnswers = opts?.userAnswers ?? [];
		const record = recordId === void 0 ? await this.deps.requirements.appendRecord({
			requirementId: requirement.id,
			category: "resolve",
			status: "running",
			branchId: requirement.wt.branch,
			skills: []
		}) : await this.deps.requirements.updateRecord(recordId, { status: "running" });
		const prompt = buildResolvePrompt({
			wtPath: requirement.wt.path,
			repo: requirement.project.localPath,
			branch: requirement.wt.branch,
			title: requirement.title,
			description: requirement.description,
			userAnswers
		});
		let execution;
		try {
			execution = await this.deps.executor.run({
				category: "resolve",
				skill: "",
				wtPath: requirement.wt.path,
				repo: requirement.project.localPath,
				title: requirement.title,
				description: requirement.description,
				priorArtifacts: [],
				userAnswers,
				prompt
			}, this.deps.configFor("resolve"));
		} catch (error) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: `会话执行异常：${error instanceof Error ? error.message : String(error)}`
			});
			return "failed";
		}
		if (execution.stopReason !== "completed") {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: `会话未完成（stopReason=${execution.stopReason}）`
			});
			return "failed";
		}
		const result = parseStageResult(execution.structured);
		if (result === null) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: "会话未返回合法的结构化结果"
			});
			return "failed";
		}
		if (result.questions.length > 0) {
			await this.deps.questions.insertMany(record.id, result.questions);
			await this.deps.reviews.ensureReply(record.id);
			await this.deps.requirements.updateRecord(record.id, {
				status: "waiting_reply",
				result: "awaiting user reply"
			});
			return "waiting";
		}
		if (result.isError) {
			await this.deps.requirements.updateRecord(record.id, {
				status: "failed",
				result: result.message || "冲突解决失败"
			});
			return "failed";
		}
		await this.deps.requirements.updateRecord(record.id, {
			status: "success",
			result: result.message || "ok",
			artifacts: result.artifacts
		});
		return "success";
	}
	/**
	* 「解决冲突」入口（审核大厅按钮 → merge Typert remote）：校验需求处于
	* `merging` → 幂等（已有 running/waiting_reply 的 resolve record 则直接返回，
	* 不重复起跑）→ 落 running record → 后台执行。返回 resolve record 列表项。
	*
	* 幂等检查与插入在同一事务内、以需求行锁（for update）串行化：并发双击/多
	* 标签页不会在同一任务分支上起跑两条 resolve 会话（会互踩 git 状态）。
	*/
	async startResolve(requirementId) {
		const requirement = await this.deps.requirements.getById(requirementId);
		if (requirement === void 0) throw new Error("需求不存在或已删除");
		if (requirement.status !== "merging") throw new Error("只有「待合并」状态的需求可以解决冲突");
		if (requirement.projectId === null) throw new Error("需求未关联项目，无法解决冲突");
		const project = await this.deps.projects.getById(requirement.projectId);
		if (project === void 0) throw new Error("需求关联的项目不存在");
		const branch = await this.resolveBranch(requirementId);
		const { recordId, started } = await this.deps.pgmas.withClient(this.deps.database, async (client) => {
			await client.query("begin");
			try {
				await client.query("select id from requirements where id = $1 for update", [requirementId]);
				const existingRow = (await client.query(`
          select id from records
          where requirement_id = $1 and category = 'resolve'
            and status in ('running', 'waiting_reply')
          order by created_at desc, id desc
          limit 1
        `, [requirementId])).rows[0];
				if (existingRow !== void 0) {
					await client.query("commit");
					return {
						recordId: String(existingRow.id),
						started: false
					};
				}
				const inserted = await client.query(`
          insert into records (id, requirement_id, branch_id, category, title, status, result, artifacts, skills, parent_id, retry_count, created_at, updated_at)
          values (gen_random_uuid(), $1, $2, 'resolve', 'resolve', 'running', null, $3, $4, null, 0, now(), now())
          returning id
        `, [
					requirementId,
					branch,
					[],
					[]
				]);
				await client.query("commit");
				return {
					recordId: String(inserted.rows[0].id),
					started: true
				};
			} catch (error) {
				await client.query("rollback");
				throw error;
			}
		});
		if (started) {
			const wt = {
				path: this.deps.worktreeFor(project).pathFor(branch),
				branch
			};
			const task = () => this.runResolveInBackground(requirement, project, wt, recordId);
			if (this.deps.dispatchBackground !== void 0) this.deps.dispatchBackground(task);
			else task();
		}
		return this.deps.requirements.getRecordListItem(recordId);
	}
	/** 后台执行 resolve（前台 RPC 只负责起跑，不在调用里阻塞数分钟）。 */
	async runResolveInBackground(requirement, project, wt, recordId) {
		try {
			await this.runResolve({
				id: requirement.id,
				title: requirement.title,
				description: requirement.description,
				project,
				wt
			}, { recordId });
		} catch (error) {
			await this.deps.requirements.updateRecord(recordId, {
				status: "failed",
				result: `冲突解决异常：${error instanceof Error ? error.message : String(error)}`
			}).catch(() => {});
		}
	}
	/** 该需求最早带 branch 的 record 的分支名（合并/续跑同一分支）；无则按约定生成。 */
	async resolveBranch(requirementId) {
		return (await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        select branch_id from records
        where requirement_id = $1 and branch_id is not null
        order by created_at asc, id asc
        limit 1
      `, [requirementId]))).rows[0]?.branch_id ?? `req-${requirementId.slice(0, 8)}`;
	}
	/**
	* ② 审核大厅轮询：处理所有挂起记录的审核单（每 tick 一次）。
	*   a. 补单：waiting_reply 无 pending reply 单 → 补一张（旧数据兼容）。
	*   b. 人工审核门通过（waiting_review + 最新 review 单 approved）→ record 置
	*      success，并从下一阶段继续。
	*   c. 待决策放行（waiting_reply + 最新 reply 单 approved + 全部作答）→ 复用
	*      record 携答复续跑（merge 阶段重跑 runMerge）。
	*   d. 驳回（最新审核单 rejected，waiting_review 或 waiting_reply）→ 复用原
	*      record 携整改意见重跑同阶段。
	*
	* 串行版：逐条处理到完成（测试与纯同步场景用）。服务端并发派发请用
	* ensureReplyTickets + listActionableReviews + processReviewAction 组合，
	* 多个已放行的记录可并行续跑（受服务端全局并发预算约束，见 cm-worker/index.ts）。
	*/
	async processReviews() {
		await this.ensureReplyTickets();
		for (const row of await this.listActionableReviews()) await this.processReviewAction(row);
	}
	/**
	* a. 补 reply 单：仅为「完全没有 reply 单」的旧 waiting_reply 数据补一张；
	*    已 approved/rejected 的最新单保持现状（重跑后再提问由 runStage 的
	*    ensureReply 补新 pending 单）。
	*/
	async ensureReplyTickets() {
		const missing = await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        select r.id as record_id from records r
        where r.status = 'waiting_reply'
          and not exists (
            select 1 from reviews v
            where v.record_id = r.id and v.kind = 'reply'
          )
        limit 20
      `));
		for (const row of missing.rows) await this.deps.reviews.ensureReply(row.record_id);
	}
	/**
	* b/c/d. 挂起记录 + 各自最新审核单（一次 join 取齐）；仅返回已到期的
	* approved/rejected 行（pending 行本轮不动，等审核大厅决定）。
	*/
	async listActionableReviews(limit = 20) {
		return (await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        select r.id as record_id, r.requirement_id, r.category, r.branch_id,
               v.kind as review_kind, v.status as review_status, v.feedback as review_feedback
        from records r
        join reviews v on v.id = (
          select v2.id from reviews v2 where v2.record_id = r.id
          order by v2.created_at desc, v2.id desc limit 1
        )
        where r.status in ('waiting_review', 'waiting_reply')
          and v.status in ('approved', 'rejected')
        order by r.updated_at asc
        limit $1
      `, [limit]))).rows;
	}
	/** 处理一条已到期的审核动作：驳回重跑 / 审核门通过续跑 / reply 放行续跑。 */
	async processReviewAction(row) {
		if (row.review_status === "rejected") await this.rerunWithFeedback(row, row.review_feedback);
		else if (row.review_kind === "review") await this.continueAfterGate(row);
		else await this.resumeRepliedRecord(row);
	}
	/** b. 人工审核门通过：record → success，从审核门锚点的下一阶段（或 merge）继续。 */
	async continueAfterGate(row) {
		const requirement = await this.deps.requirements.getById(row.requirement_id);
		if (requirement === void 0 || requirement.status !== "in_progress") return;
		if (requirement.projectId === null) return;
		const project = await this.deps.projects.getById(requirement.projectId);
		if (project === void 0) return;
		await this.deps.requirements.updateRecord(row.record_id, { status: "success" });
		const stageIndex = STAGES.findIndex((s) => s.category === row.category);
		if (stageIndex < 0) return;
		const deferred = DEFERRED_REVIEW_GATES.find((gate) => gate.category === row.category);
		const anchorIndex = deferred !== void 0 ? STAGES.findIndex((s) => s.category === deferred.anchor) : stageIndex;
		const wt = this.deps.worktreeFor(project);
		const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`;
		const handle = {
			path: wt.pathFor(branch),
			branch
		};
		const input = {
			id: requirement.id,
			title: requirement.title,
			description: requirement.description,
			project,
			wt: handle
		};
		const nextIndex = anchorIndex + 1;
		if (nextIndex >= STAGES.length) {
			await this.runMerge(input);
			return;
		}
		await this.runPipeline(input, { from: { category: STAGES[nextIndex].category } });
	}
	/** c. 待决策放行：全部作答 + reply 单 approved → 复用 record 续跑。 */
	async resumeRepliedRecord(row) {
		const requirement = await this.deps.requirements.getById(row.requirement_id);
		if (requirement === void 0) return;
		const expectedStatus = row.category === "resolve" ? "merging" : "in_progress";
		if (requirement.status !== expectedStatus) return;
		if (requirement.projectId === null) return;
		const project = await this.deps.projects.getById(requirement.projectId);
		if (project === void 0) return;
		if ((await this.deps.questions.pendingByRecord(row.record_id)).length > 0) return;
		const answers = (await this.deps.questions.listByRecord(row.record_id)).filter((question) => question.status === "answered").map((question) => ({
			question: question.question,
			answer: question.answer ?? ""
		}));
		const wt = this.deps.worktreeFor(project);
		const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`;
		const handle = {
			path: wt.pathFor(branch),
			branch
		};
		const input = {
			id: requirement.id,
			title: requirement.title,
			description: requirement.description,
			project,
			wt: handle
		};
		if (row.category === "merge") {
			await this.runMerge(input, { recordId: row.record_id });
			return;
		}
		if (row.category === "resolve") {
			await this.runResolve(input, {
				recordId: row.record_id,
				userAnswers: answers
			});
			return;
		}
		await this.runPipeline(input, { resume: {
			recordId: row.record_id,
			category: row.category,
			userAnswers: answers
		} });
	}
	/** d. 驳回（带整改意见）→ 复用原 record 携反馈重跑同阶段。 */
	async rerunWithFeedback(row, feedback) {
		const requirement = await this.deps.requirements.getById(row.requirement_id);
		const expectedStatus = row.category === "resolve" ? "merging" : "in_progress";
		if (requirement === void 0 || requirement.status !== expectedStatus) return;
		if (requirement.projectId === null) return;
		const project = await this.deps.projects.getById(requirement.projectId);
		if (project === void 0) return;
		const wt = this.deps.worktreeFor(project);
		const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`;
		const handle = {
			path: wt.pathFor(branch),
			branch
		};
		const input = {
			id: requirement.id,
			title: requirement.title,
			description: requirement.description,
			project,
			wt: handle
		};
		if (row.category === "merge") {
			await this.runMerge(input, { recordId: row.record_id });
			return;
		}
		if (row.category === "resolve") {
			await this.runResolve(input, { recordId: row.record_id });
			return;
		}
		const stage = STAGES.find((s) => s.category === row.category);
		if (stage === void 0) return;
		const answers = (await this.deps.questions.listByRecord(row.record_id)).filter((question) => question.status === "answered").map((question) => ({
			question: question.question,
			answer: question.answer ?? ""
		}));
		const outcome = await this.runStage(input, stage, {
			recordId: row.record_id,
			retry: true,
			feedback: feedback ?? void 0,
			userAnswers: answers
		});
		const deferred = DEFERRED_REVIEW_GATES.find((gate) => gate.category === row.category);
		if (deferred !== void 0 && outcome === "success") await this.runPipeline(input, { from: { category: deferred.anchor } });
	}
	/**
	* ③ 重试：复用原 record（不新开），标记「重试中」并 retry_count+1，重跑同阶段。
	* 每阶段重试次数 ≤ maxRetries（默认 10）；超限不再重试——需求停留在
	* in_progress、record 保持 failed，由面板/用户介入（不再回 open 死循环）。
	*
	* 串行版：逐条重试到完成（测试用）。服务端并发派发请用 listRetryable +
	* processRetryRow 组合（受全局并发预算约束）。
	*/
	async retryFailed() {
		for (const row of await this.listRetryable()) await this.processRetryRow(row);
	}
	/** ③a 待重试的 failed record 列表（retry_count < maxRetries，需求仍 in_progress）。 */
	async listRetryable(limit = 10) {
		return (await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        select r.id as record_id, r.requirement_id, r.category, r.branch_id
        from records r
        where r.status = 'failed'
          and r.retry_count < $1
          and exists (
            select 1 from requirements req
            where req.id::text = r.requirement_id and req.status = 'in_progress'
          )
        order by r.updated_at asc
        limit $2
      `, [this.deps.maxRetries, limit]))).rows;
	}
	/** ③b 重试一条 failed record（复用原 record）。 */
	async processRetryRow(row) {
		await this.retryRecord(row);
	}
	async retryRecord(row) {
		const requirement = await this.deps.requirements.getById(row.requirement_id);
		if (requirement === void 0 || requirement.status !== "in_progress") return;
		if (requirement.projectId === null) return;
		const project = await this.deps.projects.getById(requirement.projectId);
		if (project === void 0) return;
		const stage = STAGES.find((s) => s.category === row.category);
		if (stage === void 0) return;
		const wt = this.deps.worktreeFor(project);
		const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`;
		const handle = {
			path: wt.pathFor(branch),
			branch
		};
		const input = {
			id: requirement.id,
			title: requirement.title,
			description: requirement.description,
			project,
			wt: handle
		};
		if (await this.runStage(input, stage, {
			recordId: row.record_id,
			retry: true
		}) === "success") {
			const nextIndex = STAGES.findIndex((s) => s.category === stage.category) + 1;
			if (nextIndex < STAGES.length) await this.runPipeline(input, { from: { category: STAGES[nextIndex].category } });
		}
	}
	/**
	* ④ 收尾：用户点「已合并」→ confirmMerged（02）→ requirement done；
	* 此处对 done 且尚未清理（无 cleanup record）的需求先把主 checkout 的 main
	* 同步到远端（git pull，PR 已合并后本地 main 拿到合并提交），再清理 worktree
	* + 分支，并记一条 cleanup record 保证幂等。pull 失败不记 cleanup → 需求
	* 保持待清理，下轮 tick 重试，直到 main 同步成功（每次点「已合并」都 pull）。
	*/
	async finalizeMerged() {
		const rows = await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        select r.id, r.project_id,
               (select rc.branch_id from records rc
                where rc.requirement_id = r.id::text and rc.branch_id is not null
                order by rc.created_at asc limit 1) as branch_id
        from requirements r
        where r.status = 'done'
          and not exists (
            select 1 from records rc2
            where rc2.requirement_id = r.id::text and rc2.category = 'cleanup' and rc2.status = 'success'
          )
        order by r.updated_at asc
        limit 10
      `));
		for (const row of rows.rows) {
			if (row.branch_id === null || row.branch_id === "") continue;
			const project = await this.deps.projects.getById(row.project_id);
			if (project === void 0) continue;
			const wt = this.deps.worktreeFor(project);
			const handle = {
				path: wt.pathFor(row.branch_id),
				branch: row.branch_id
			};
			await wt.pullMain();
			try {
				await wt.remove(handle);
			} catch {}
			await this.deps.requirements.appendRecord({
				requirementId: row.id,
				category: "cleanup",
				status: "success",
				branchId: row.branch_id,
				result: "worktree removed",
				skills: []
			});
		}
	}
	/**
	* ⑤ 启动自愈（进程重启后一次性执行）：把上一进程遗留的死状态拉回可推进轨道。
	*
	* 背景（2026-08-16 实测）：进程若死在「某阶段 success 记账之后、下一阶段/merge
	* 记账之前」（如 review-code success 后、merge record 创建前），需求会停在
	* in_progress、最新 record 为 success、无任何 running/waiting/failed 记录——
	* 而 claim / 审核续跑 / 重试 / 收尾四条路径都看不见它 → 永久「执行中」僵尸。
	* 另有进程重启后残留的 running record（旧会话必死）同样无人收尸。
	*
	* a. markStaleRunning：把全部 status='running' 的 record 标记 failed
	*    （'进程重启，中断的会话已失效'）——重启后旧会话必死，交给 retryFailed
	*    复用同一 record 续跑（同分支/worktree，不新开 record）。
	* b. listStuckGaps：找出 in_progress 且「最新 record = 阶段 success、无任何
	*    running/waiting/failed 记录、且从未创建 merge record」的需求（缺口僵尸），
	*    配合 resumeGap 从下一阶段（或最后阶段 → 补 merge：push + PR）续跑。
	*
	* 仅在服务启动后的第一个 tick 调用（见 cm-worker/index.ts）：此时进程刚起、
	* 无任何在途会话，恢复任务不会与正常派发抢跑（避免重复 merge/重复建 PR）。
	*/
	async markStaleRunning() {
		return (await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        update records r
        set status = 'failed',
            result = '进程重启，中断的会话已失效；等待 worker 自动重试',
            updated_at = now()
        where r.status = 'running'
        returning r.id
      `))).rowCount ?? 0;
	}
	/**
	* ⑤b 缺口僵尸行：in_progress 需求 + 最新 record = 阶段 success（或领取后
	* 尚未落任何 record——领取与首阶段记账之间崩溃/被时段延后的竞态）+
	* 无挂起/失败 + 无 merge。
	*/
	async listStuckGaps(limit = 5) {
		return (await this.deps.pgmas.withClient(this.deps.database, (client) => client.query(`
        select r.id as requirement_id,
               (select rc.branch_id from records rc
                where rc.requirement_id = r.id::text and rc.branch_id is not null
                order by rc.created_at asc limit 1) as branch_id,
               (select rc2.category from records rc2
                where rc2.requirement_id = r.id::text
                order by rc2.created_at desc, rc2.id desc limit 1) as last_category
        from requirements r
        where r.status = 'in_progress'
          and r.project_id is not null
          and not exists (
            select 1 from records rc3
            where rc3.requirement_id = r.id::text and rc3.category = 'merge'
          )
          -- 最新 record 必须是阶段 success，或根本没有 record（领取后竞态残留；
          -- running/waiting/failed 由正常派发路径接管，更早的 failed（重试后
          -- 成功）不影响缺口判定）
          and coalesce((
            select rc4.status from records rc4
            where rc4.requirement_id = r.id::text
            order by rc4.created_at desc, rc4.id desc limit 1
          ), 'none') in ('success', 'none')
        order by r.updated_at asc
        limit $1
      `, [limit]))).rows;
	}
	/**
	* ⑤c 续跑一条缺口僵尸：无 record（领取竞态）→ 从首阶段跑起；最后阶段
	* success → 补 merge；中途缺口 → 从下一阶段继续。
	*/
	async resumeGap(row) {
		const requirement = await this.deps.requirements.getById(row.requirement_id);
		if (requirement === void 0 || requirement.status !== "in_progress") return;
		if (requirement.projectId === null) return;
		const project = await this.deps.projects.getById(requirement.projectId);
		if (project === void 0) return;
		const wt = this.deps.worktreeFor(project);
		const branch = row.branch_id ?? `req-${requirement.id.slice(0, 8)}`;
		const input = {
			id: requirement.id,
			title: requirement.title,
			description: requirement.description,
			project,
			wt: {
				path: wt.pathFor(branch),
				branch
			}
		};
		if (row.last_category === null || row.last_category === "") {
			await this.runPipeline(input, { from: { category: STAGES[0].category } });
			return;
		}
		const stageIndex = STAGES.findIndex((s) => s.category === row.last_category);
		if (stageIndex < 0) return;
		if (stageIndex >= STAGES.length - 1) {
			await this.runMerge(input);
			return;
		}
		await this.runPipeline(input, { from: { category: STAGES[stageIndex + 1].category } });
	}
	/** 该需求最近成功的 record artifacts（供下阶段上下文）。 */
	async priorArtifacts(requirementId) {
		const record = await this.deps.requirements.listRecentRecord(requirementId);
		return record === void 0 ? [] : record.artifacts;
	}
};
//#endregion
//#region build/worker.js
/**
* cm-worker — host-only dsh plugin: the coding-pipeline worker. A timer
* interval drives a serial poll loop (claim / resume / retry / finalize) that
* pulls `open` requirements into stage sessions (subagents) running inside
* per-task git worktrees; every stage is a `records` ledger row.
*
* The worker only orchestrates and keeps books — it never writes code. All
* database writes go through the cm-flow repos over `pgmas.withClient`;
* `pg_query` stays read-only.
*
* @module @auto-coding/cm-worker
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const DEFAULT_DATABASE = "cm";
const DEFAULT_POLL_MS = 1e4;
const DEFAULT_STAGE_TIMEOUT_MS = 18e5;
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_SUBAGENT_PROVIDER = "spawn";
/** 阶段会话统一结构化输出契约（ObjectJsonSchema，subagent outputSchema 用）。 */
const STAGE_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"isError",
		"message",
		"artifacts",
		"questions"
	],
	properties: {
		isError: { type: "boolean" },
		message: { type: "string" },
		artifacts: {
			type: "array",
			items: { type: "string" }
		},
		questions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["question", "options"],
				properties: {
					question: { type: "string" },
					options: {
						type: "array",
						items: { type: "string" }
					}
				}
			}
		}
	}
};
/** PR 创建任务结构化输出契约（方案 §8）。 */
const PR_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["is_ok"],
	properties: {
		is_ok: { type: "boolean" },
		pr_url: { type: "string" },
		error: { type: "string" }
	}
};
/**
* 真实阶段执行器：subagents.start + STAGE_RESULT_SCHEMA 结构化回传。
* 每个阶段会话都以「任务 worktree 为 cwd」新建一个 parent agent（不再复用
* 单例 worker agent）：子会话的默认工作目录与沙箱 workspace 都指向 worktree，
* 产物落在任务分支；并把 parent 会话的 sandbox/mode 放宽到 danger-full-access
* —— git worktree 的 commit/push 会写主仓 .git（在 worktree 之外），
* workspace-write 会被文件沙箱拒绝；这与方案 §7/§11「阶段会话权限 = 本机
* bash/fs，worktree 限制只改任务分支」一致。会话用完即销毁。
*/
var SubagentStageExecutor = class {
	subagents;
	agents;
	provider;
	stageTimeoutMs;
	composeAgent;
	constructor(subagents, agents, provider, stageTimeoutMs, composeAgent) {
		this.subagents = subagents;
		this.agents = agents;
		this.provider = provider;
		this.stageTimeoutMs = stageTimeoutMs;
		this.composeAgent = composeAgent;
	}
	async run(input, agentOptions) {
		const { parent, dispose } = await this.createParentAgent(input.wtPath);
		try {
			const run = await this.subagents.start(this.provider, {
				label: `${input.category}:${input.wtPath.split("/").pop() ?? ""}`,
				prompt: [{
					type: "text",
					text: input.prompt
				}],
				parent,
				signal: AbortSignal.timeout(this.stageTimeoutMs),
				outputSchema: STAGE_RESULT_SCHEMA,
				...agentOptions !== void 0 && agentOptions !== null ? { agentOptions } : {}
			});
			const result = await run.result;
			await run.dispose().catch(() => {});
			return {
				stopReason: result.stopReason,
				structured: result.structured
			};
		} finally {
			await dispose().catch(() => {});
		}
	}
	async runPr(input, agentOptions) {
		const { parent, dispose } = await this.createParentAgent(input.wtPath);
		try {
			const run = await this.subagents.start(this.provider, {
				label: `merge:pr`,
				prompt: [{
					type: "text",
					text: input.prompt
				}],
				parent,
				signal: AbortSignal.timeout(this.stageTimeoutMs),
				outputSchema: PR_RESULT_SCHEMA,
				...agentOptions !== void 0 && agentOptions !== null ? { agentOptions } : {}
			});
			const result = await run.result;
			await run.dispose().catch(() => {});
			if (result.stopReason !== "completed") return {
				isOk: false,
				error: `PR 会话未完成（stopReason=${result.stopReason}）`
			};
			return parsePrResult(result.structured) ?? {
				isOk: false,
				error: "PR 会话未返回合法 JSON"
			};
		} finally {
			await dispose().catch(() => {});
		}
	}
	async createParentAgent(cwd) {
		const handle = await this.agents.create({
			sessionId: randomUUID(),
			meta: {
				cwd,
				origin: "subagent"
			},
			...this.composeAgent !== void 0 ? { setup: this.composeAgent } : {}
		});
		handle.agent.session.append("sandbox/mode", { mode: "danger-full-access" });
		return {
			parent: handle.agent,
			dispose: () => handle.dispose()
		};
	}
};
/**
* Typert Remote service (namespace `merge`): 审核大厅「解决冲突」按钮的入口。
* 起跑一条冲突解决任务（fetch + merge + 解决冲突 + commit + push，可挂
* waiting_reply 提问后携答复续跑）；返回 resolve record 列表项，执行在后台。
*/
let MergeService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _resolveConflicts_decorators;
	return class MergeService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_resolveConflicts_decorators = [Remote("resolveConflicts")];
			__esDecorate(this, null, _resolveConflicts_decorators, {
				kind: "method",
				name: "resolveConflicts",
				static: false,
				private: false,
				access: {
					has: (obj) => "resolveConflicts" in obj,
					get: (obj) => obj.resolveConflicts
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		startResolve = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, startResolve) {
			super(ctx, "cmMerge", { namespace: "merge" });
			this.startResolve = startResolve;
		}
		async resolveConflicts(requirementId) {
			return this.startResolve(requirementId);
		}
	};
})();
/**
* Worker 服务：timer 驱动串行 tick。组合可测的 WorkerPipeline 与真实依赖
* （subagents / agents / fs / worktree）。
*/
var CmWorkerService = class extends Service {
	static inject = [
		"pgmas",
		"timer",
		"subagents",
		"agents"
	];
	static Config = z.object({
		database: z.string().default("cm"),
		pollMs: z.number().min(1e3).default(DEFAULT_POLL_MS),
		stageTimeoutMs: z.number().min(1e4).default(DEFAULT_STAGE_TIMEOUT_MS),
		maxRetries: z.number().min(0).max(10).default(10),
		subagentProvider: z.string().default(DEFAULT_SUBAGENT_PROVIDER),
		skillsSource: z.object({
			kind: z.string(),
			path: z.string(),
			url: z.string(),
			ref: z.string()
		})
	});
	pipeline;
	configRepo;
	running = false;
	config = DEFAULT_WORKER_CONFIG;
	/** 全局并发预算：当前正在跑的流水线任务数（领取 / 审核续跑 / 重试 / 冲突解决）。 */
	active = 0;
	/** 并发预算满时排队的后台任务（用户触发的冲突解决等）。 */
	waiters = [];
	/** 已派发、尚未落定的 record id（防同一审核/重试动作被多轮 tick 重复派发）。 */
	dispatched = /* @__PURE__ */ new Set();
	/** 在途整链任务（requirement id）：领取/续跑/重试/缺口任务运行期间，缺口扫描不得对同一需求再派发。 */
	inflight = /* @__PURE__ */ new Set();
	/** 启动自愈（僵尸/残留恢复）只执行一次（见 tick 首个分支）。 */
	startupRecovered = false;
	constructor(ctx, config = {
		database: "cm",
		pollMs: DEFAULT_POLL_MS,
		stageTimeoutMs: DEFAULT_STAGE_TIMEOUT_MS,
		maxRetries: 10,
		subagentProvider: DEFAULT_SUBAGENT_PROVIDER
	}) {
		super(ctx, "cmWorker");
		const pgmas = ctx.get("pgmas");
		if (pgmas === void 0) throw new Error("cm-worker: pgmas service is unavailable (mount @auto-coding/db-pgmas first)");
		const database = config.database ?? "cm";
		const requirements = new RequirementsRepo({
			pgmas,
			database
		});
		const projects = new ProjectsRepo({
			pgmas,
			database
		});
		const questions = new QuestionsRepo({
			pgmas,
			database
		});
		const reviews = new ReviewsRepo({
			pgmas,
			database
		});
		this.configRepo = new WorkerConfigRepo({
			pgmas,
			database
		});
		const subagents = ctx.get("subagents");
		if (subagents === void 0) throw new Error("cm-worker: subagents service is unavailable");
		const agents = ctx.get("agents");
		if (agents === void 0) throw new Error("cm-worker: agents service is unavailable");
		const presets = ctx.get("agentPresets");
		const composeAgent = presets === void 0 ? void 0 : async (agentCtx) => {
			const preset = await presets.resolve();
			await presets.mount(agentCtx, preset.id);
		};
		const executor = new SubagentStageExecutor(subagents, agents, config.subagentProvider ?? "spawn", config.stageTimeoutMs ?? 18e5, composeAgent);
		const worktrees = /* @__PURE__ */ new Map();
		const worktreeFor = (project) => {
			let manager = worktrees.get(project.id);
			if (manager === void 0) {
				manager = new WorktreeManager({ repo: project.localPath });
				worktrees.set(project.id, manager);
			}
			return manager;
		};
		const skills = new SkillSource(normalizeSkillsSource(config.skillsSource));
		this.pipeline = new WorkerPipeline({
			pgmas,
			database,
			requirements,
			projects,
			questions,
			reviews,
			executor,
			readSkillMd: async (repo, skill) => {
				try {
					return await readFile(join(repo, `.agents/skills/${skill}/SKILL.md`), "utf8");
				} catch {
					const dir = skills.skillDir(skill);
					if (dir === void 0) throw new Error(`技能 ${skill} 不在项目与 skillsSource 中`);
					return readFile(join(dir, "SKILL.md"), "utf8");
				}
			},
			provisionSkills: async (wtPath) => {
				for (const skill of skills.list()) {
					const dir = skills.skillDir(skill);
					if (dir === void 0) continue;
					const target = join(wtPath, `.agents/skills/${skill}/SKILL.md`);
					try {
						await stat(target);
					} catch {
						const { mkdir, writeFile } = await import("node:fs/promises");
						await mkdir(join(wtPath, `.agents/skills/${skill}`), { recursive: true });
						await writeFile(target, await readFile(join(dir, "SKILL.md"), "utf8"), "utf8");
					}
				}
			},
			artifactExists: async (wtPath, relPath) => {
				try {
					await stat(join(wtPath, relPath));
					return true;
				} catch {
					return false;
				}
			},
			worktreeFor,
			maxRetries: config.maxRetries ?? 10,
			configFor: (category) => {
				const stage = this.config.stages[category];
				const provider = stage?.provider ?? this.config.defaultProvider ?? void 0;
				const model = stage?.model ?? this.config.defaultModel ?? void 0;
				const maxTokens = stage?.maxTokens ?? this.config.defaultMaxTokens ?? void 0;
				if (provider === void 0 && model === void 0 && maxTokens === void 0) return void 0;
				return {
					...provider !== void 0 ? { provider } : {},
					...model !== void 0 ? { model } : {},
					...maxTokens !== void 0 ? { maxTokens } : {}
				};
			},
			windowFor: (category) => this.windowFor(category),
			dispatchBackground: (task) => {
				this.withSlot(task).catch((error) => console.warn(`[cm-worker] 后台任务异常: ${error instanceof Error ? error.message : String(error)}`));
			},
			commitWorktree: async (project, wtPath, message) => {
				const manager = worktrees.get(project.id);
				if (manager === void 0) return;
				await manager.commitAll(wtPath, message);
			}
		});
		const pollMs = config.pollMs ?? 1e4;
		ctx.timer.interval(() => {
			if (this.running) return;
			this.tick();
		}, pollMs);
		new MergeService(ctx, (id) => this.pipeline.startResolve(id));
	}
	/**
	* 串行 tick：读配置 → 时段门控 → 短派发（领取 / 审核续跑 / 重试 / 缺口续跑，
	* 受全局并发预算约束）→ 收尾。tick 本身只做快查询与派发，不阻塞在长流水线上：
	* 每条领取 / 续跑 / 重试都以后台任务运行，槽位在流水线挂起（进审核门）或完成时
	* 释放——审核放行逐条到来也能按预算并发续跑（10s 一轮，槽位空出即补）。
	* 任一异常静默下轮重试。
	*
	* 时段门控两级：阶段清单缺省（旧配置）= 全部阶段受限，窗口外整轮跳过
	* （与历史行为一致）；配置了清单则按阶段过滤派发——受限阶段窗口外不领取/
	* 不续跑/不重试，未勾选阶段 24h 可跑；阶段链中途受限的，由 runStage 返回
	* 'deferred' 停在缺口态，窗口开启后经 dispatchGaps 接续。
	*/
	async tick() {
		this.running = true;
		try {
			this.config = await this.configRepo.get();
			if (this.config.timeWindowEnabled === true && this.config.timeWindowStages == null && !withinWindow(this.config)) return;
			if (!this.startupRecovered) {
				this.startupRecovered = true;
				await this.recoverStartup();
				return;
			}
			await this.dispatchClaims();
			await this.dispatchReviews();
			await this.dispatchRetries();
			await this.dispatchGaps();
			await this.pipeline.finalizeMerged();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[cm-worker] tick 异常（下轮重试）: ${detail}`);
		} finally {
			this.running = false;
		}
	}
	/** 每阶段时段门控：该阶段此刻是否允许起跑（清单外/未启用恒 true）。 */
	windowFor(category) {
		return stageWindowAllowed(this.config, category);
	}
	/** 全局并发预算：当前配置的 concurrency（1..MAX_CONCURRENCY 钳制）。 */
	budget() {
		return Math.min(8, Math.max(1, this.config.concurrency ?? 1));
	}
	/** 非阻塞获取一个并发槽：空闲则占用并返回 true；已满返回 false（下轮 tick 再试）。 */
	trySlot() {
		if (this.active >= this.budget()) return false;
		this.active += 1;
		return true;
	}
	/** 释放并发槽：有排队任务则直接移交（计数不变），否则 -1。 */
	releaseSlot() {
		const next = this.waiters.shift();
		if (next !== void 0) next();
		else this.active -= 1;
	}
	/** 排队获取并发槽（用户触发的冲突解决等：满了就排队，最终会跑）。 */
	async withSlot(fn) {
		if (!this.trySlot()) await new Promise((resolve) => this.waiters.push(resolve));
		try {
			return await fn();
		} finally {
			this.releaseSlot();
		}
	}
	/**
	* 后台派发一个占槽任务：异常落日志，落定（成功/失败）即释放槽位。
	* inflightId（requirement id）任务在途期间登记进 inflight，供缺口扫描避让。
	*/
	dispatchTask(fn, what, onSettled, inflightId) {
		if (inflightId !== void 0) this.inflight.add(inflightId);
		fn().catch((error) => console.warn(`[cm-worker] 后台任务 ${what} 异常: ${error instanceof Error ? error.message : String(error)}`)).finally(() => {
			if (inflightId !== void 0) this.inflight.delete(inflightId);
			if (onSettled !== void 0) onSettled();
			this.releaseSlot();
		});
	}
	/** 派发领取：按预算逐个原子领取 open 需求（for update skip locked 互斥），各自后台跑阶段链。 */
	async dispatchClaims() {
		if (!this.windowFor(STAGES[0].category)) return;
		while (this.trySlot()) {
			let claim;
			try {
				claim = await this.pipeline.claim();
			} catch (error) {
				this.releaseSlot();
				throw error;
			}
			if (claim === void 0) {
				this.releaseSlot();
				return;
			}
			this.dispatchTask(() => this.pipeline.runClaimed(claim), `领取 ${claim.id.slice(0, 8)}`, void 0, claim.id);
		}
	}
	/** 派发审核续跑：补 reply 单后，把已放行/驳回的记录按预算逐个后台续跑（多记录可并行）。 */
	async dispatchReviews() {
		await this.pipeline.ensureReplyTickets();
		const actions = await this.pipeline.listActionableReviews();
		for (const action of actions) {
			if (this.dispatched.has(action.record_id)) continue;
			if (action.review_status === "rejected" || action.review_kind === "reply") {
				if (!this.windowFor(action.category)) continue;
			}
			if (!this.trySlot()) break;
			this.dispatched.add(action.record_id);
			this.dispatchTask(() => this.pipeline.processReviewAction(action), `审核续跑 record ${action.record_id.slice(0, 8)}`, () => this.dispatched.delete(action.record_id), action.requirement_id);
		}
	}
	/** 派发重试：把可重试的 failed record 按预算逐个后台重跑（可并行）。 */
	async dispatchRetries() {
		const rows = await this.pipeline.listRetryable();
		for (const row of rows) {
			if (this.dispatched.has(row.record_id)) continue;
			if (!this.windowFor(row.category)) continue;
			if (!this.trySlot()) break;
			this.dispatched.add(row.record_id);
			this.dispatchTask(() => this.pipeline.processRetryRow(row), `重试 record ${row.record_id.slice(0, 8)}`, () => this.dispatched.delete(row.record_id), row.requirement_id);
		}
	}
	/**
	* 派发缺口续跑（每轮 tick）：扫描「in_progress + 最新 record = 阶段 success
	* （或领取后尚无 record）+ 无挂起/失败 + 无 merge」的缺口需求，按预算后台
	* 从下一阶段续跑。
	*
	* 覆盖三类缺口：① 进程崩溃/重启遗留（原启动自愈路径，现每轮兜底）；
	* ② 阶段链中途被时段门控延后的（runStage 返回 'deferred'，不落 record，
	* 需求自然停在上一阶段 success 的缺口态）——受限阶段进入窗口后即由此接续；
	* ③ 领取后尚未落 record 的竞态残留（从首阶段跑起）。
	* 在途整链任务（inflight）避让，防止与领取/续跑/重试并行重跑同一需求；
	* 下一阶段仍受限时 resumeGap → runStage 再次延后，只耗几次快查询。
	*/
	async dispatchGaps() {
		const gaps = await this.pipeline.listStuckGaps();
		for (const gap of gaps) {
			if (this.inflight.has(gap.requirement_id)) continue;
			if (!this.trySlot()) break;
			this.dispatchTask(() => this.pipeline.resumeGap(gap), `缺口续跑 ${gap.requirement_id.slice(0, 8)}`, void 0, gap.requirement_id);
		}
	}
	/**
	* 启动自愈（仅第一个 tick）：标记上一进程残留的 running record 为 failed
	* （交给重试路径复用同一 record 续跑），并把停在 success 缺口的需求（如
	* review-code 已 success 但 merge 从未创建的僵尸）按并发预算后台续跑。
	*/
	async recoverStartup() {
		try {
			const stale = await this.pipeline.markStaleRunning();
			if (stale > 0) console.warn(`[cm-worker] 启动自愈：${stale} 条残留 running record 已转 failed（等待自动重试）`);
			const gaps = await this.pipeline.listStuckGaps();
			for (const gap of gaps) {
				if (this.inflight.has(gap.requirement_id)) continue;
				if (!this.trySlot()) break;
				this.dispatchTask(() => this.pipeline.resumeGap(gap), `缺口续跑 ${gap.requirement_id.slice(0, 8)}`, void 0, gap.requirement_id);
			}
		} catch (error) {
			console.warn(`[cm-worker] 启动自愈异常（下轮不再重试，可人工介入）: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
};
//#endregion
export { DEFAULT_DATABASE, DEFAULT_MAX_RETRIES, DEFAULT_POLL_MS, DEFAULT_STAGE_TIMEOUT_MS, DEFAULT_SUBAGENT_PROVIDER, MergeService, PR_RESULT_SCHEMA, STAGE_RESULT_SCHEMA, WorkerPipeline, buildPrPrompt, buildPrompt, buildResolvePrompt, CmWorkerService as default, runLanes, stageWindowAllowed, withinWindow };
