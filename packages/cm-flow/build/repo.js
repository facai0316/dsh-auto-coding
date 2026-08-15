/**
 * cm-flow domain + storage, independent of Cordis so it can be tested against
 * a real `pg` pool without a harness context, and free of TS decorators so the
 * vitest/esbuild transform can parse it.
 * @module @auto-coding/cm-flow/repo
 */
// ──────────────────────────────── domain ─────────────────────────────────
export const REQUIREMENT_STATUSES = ['draft', 'open', 'in_progress', 'merging', 'done', 'cancelled'];
/** records.status 合法值（流水线阶段账本）。 */
export const RECORD_STATUSES = ['running', 'success', 'failed', 'waiting_reply'];
/**
 * Legal transitions. Legacy panel-era edges (`open→done`, `done→open`) are
 * retained for the current checklist UI; the pipeline era converges them away
 * (panel 提交执行 + worker 验收，见 docs/plans/02) — they will be removed
 * together with the panel 改造. `in_progress→merging` / `merging→done` are the
 * pipeline edges.
 */
export const TRANSITIONS = {
    draft: ['open', 'cancelled'],
    open: ['in_progress', 'done', 'cancelled'],
    in_progress: ['merging', 'done', 'cancelled'],
    merging: ['done', 'cancelled'],
    done: ['open', 'cancelled'],
    cancelled: [],
};
export function assertStatus(value) {
    if (typeof value === 'string' && REQUIREMENT_STATUSES.includes(value)) {
        return value;
    }
    throw new Error(`未知需求状态 ${JSON.stringify(value)}（合法值：${REQUIREMENT_STATUSES.join(', ')}）`);
}
export function assertRecordStatus(value) {
    if (typeof value === 'string' && RECORD_STATUSES.includes(value)) {
        return value;
    }
    throw new Error(`未知记录状态 ${JSON.stringify(value)}（合法值：${RECORD_STATUSES.join(', ')}）`);
}
export function canTransition(from, to) {
    return from !== to && TRANSITIONS[from].includes(to);
}
/**
 * Forward migrations owned by this plugin. Version 1 is a baseline assertion
 * (SeaORM schema must already exist); v2-v4 add the pipeline data model.
 */
const MIGRATIONS = [
    {
        version: 1,
        name: 'baseline: assert SeaORM requirements table exists',
        apply: async (client) => {
            // Raises `relation "requirements" does not exist` when absent.
            await client.query('select 1 from requirements limit 1');
        },
    },
    {
        version: 2,
        name: 'projects table + seed fac-ai-rs',
        apply: async (client) => {
            await client.query(`
        create table if not exists projects (
          id          uuid primary key default gen_random_uuid(),
          name        varchar not null,
          local_path  text not null unique,
          git_url     text not null,
          platform    varchar not null default 'gitee',   -- 'gitee' | 'gitea'
          pr_token    text,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now()
        )
      `);
            // Pilot project seed (idempotent, fixed id for later references).
            await client.query(`
        insert into projects (id, name, local_path, git_url, platform)
        select '00000000-0000-4000-8000-0000000000c1',
               'fac-ai-rs',
               '/root/workspace/rust/fac-ai-rs',
               'git@gitee.com:wb200327/fac-ai-rs.git',
               'gitee'
        where not exists (select 1 from projects where local_path = '/root/workspace/rust/fac-ai-rs')
      `);
        },
    },
    {
        version: 3,
        name: 'requirements.project_id + open index',
        apply: async (client) => {
            await client.query('alter table requirements add column project_id uuid references projects(id)');
            await client.query(`
        create index if not exists requirements_project_open_idx
          on requirements(project_id)
          where status = 'open'
      `);
        },
    },
    {
        version: 4,
        name: 'ask_user_questions table + pending index',
        apply: async (client) => {
            await client.query(`
        create table if not exists ask_user_questions (
          id          uuid primary key default gen_random_uuid(),
          record_id   uuid not null references records(id) on delete cascade,
          question    text not null,
          options     text[] not null default '{}',
          status      varchar not null default 'pending',   -- 'pending' | 'answered'
          answer      text,
          created_at  timestamptz not null default now(),
          answered_at timestamptz
        )
      `);
            await client.query(`
        create index if not exists ask_user_questions_pending_idx
          on ask_user_questions(record_id)
          where status = 'pending'
      `);
        },
    },
];
// ────────────────────────────── shared infra ─────────────────────────────
function iso(value) {
    return value instanceof Date ? value.toISOString() : String(value);
}
function toTextArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.map(entry => String(entry));
}
function rowToView(row) {
    return {
        id: String(row.id),
        title: String(row.title),
        description: row.description === null || row.description === undefined ? null : String(row.description),
        status: assertStatus(row.status),
        projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
    };
}
function recordRowToView(row) {
    return {
        id: String(row.id),
        category: String(row.category),
        status: assertRecordStatus(row.status),
        result: row.result === null || row.result === undefined ? null : String(row.result),
        artifacts: toTextArray(row.artifacts),
        skills: toTextArray(row.skills),
        parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
        requirementId: row.requirement_id === null || row.requirement_id === undefined ? '' : String(row.requirement_id),
        branchId: row.branch_id === null || row.branch_id === undefined ? null : String(row.branch_id),
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
    };
}
export const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_DATABASE = 'cm';
/**
 * Ensure schema + fixed dsh user exist. Idempotent; safe to run from any repo
 * construction (version rows skip already-applied migrations).
 */
async function runMigrations(pgmas, database, userId) {
    await pgmas.withClient(database, async (client) => {
        await client.query(`
      create table if not exists _cm_flow_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )
    `);
        await client.query(`insert into users (id, email, password_hash, nickname, created_at, updated_at)
       values ($1, $2, '', 'dsh', now(), now())
       on conflict (id) do nothing`, [userId, `dsh+${userId}@dsh.local`]);
        for (const migration of MIGRATIONS) {
            const applied = await client.query('select 1 from _cm_flow_migrations where version = $1', [migration.version]);
            if ((applied.rows ?? []).length > 0)
                continue;
            await client.query('begin');
            try {
                await migration.apply(client);
                await client.query('insert into _cm_flow_migrations (version, name) values ($1, $2)', [migration.version, migration.name]);
                await client.query('commit');
            }
            catch (error) {
                await client.query('rollback');
                throw error;
            }
        }
    });
}
/** Requirements storage + state machine + stage ledger. */
export class RequirementsRepo {
    database;
    userId;
    pgmas;
    ready;
    constructor(options) {
        this.pgmas = options.pgmas;
        this.database = options.database ?? DEFAULT_DATABASE;
        this.userId = options.userId ?? DEFAULT_USER_ID;
        this.ready = runMigrations(this.pgmas, this.database, this.userId);
    }
    async list(options) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query(`
        select r.id, r.title, r.description, r.status, r.project_id, r.created_at, r.updated_at,
               coalesce((
                 select json_agg(json_build_object(
                   'category', rc.category,
                   'status', rc.status,
                   'recordId', rc.id,
                   'prUrl', case when rc.category = 'merge' and rc.artifacts is not null
                                     and array_length(rc.artifacts, 1) > 0 then rc.artifacts[1] end,
                   'updatedAt', rc.updated_at
                 ) order by rc.created_at asc, rc.id asc)
                 from records rc
                 where rc.requirement_id = r.id::text
               ), '[]'::json) as stages
        from requirements r
        where r.status <> 'cancelled'
          and ($1::uuid is null or r.project_id = $1::uuid)
        order by r.created_at asc, r.id asc
        limit 500
      `, [options?.projectId ?? null]));
        return result.rows.map(row => ({
            ...rowToView(row),
            stages: Array.isArray(row.stages) ? row.stages : [],
        }));
    }
    /**
     * Create a requirement. With `projectId` → pipeline form: status `draft`,
     * attached to the project, awaiting panel 「开始执行」(transition to open).
     * Without → legacy panel-compatible: status `open`, no project.
     */
    async create(title, description, projectId) {
        await this.ready;
        const trimmed = (title ?? '').trim();
        if (trimmed === '')
            throw new Error('标题不能为空');
        const status = projectId === undefined ? 'open' : 'draft';
        const result = await this.pgmas.withClient(this.database, client => client.query(`insert into requirements (id, user_id, title, description, status, project_id, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
         returning id, title, description, status, project_id, created_at, updated_at`, [this.userId, trimmed, description === undefined ? null : description, status, projectId === undefined ? null : projectId]));
        const row = result.rows[0];
        if (row === undefined)
            throw new Error('插入需求失败：没有返回行');
        return rowToView(row);
    }
    async transition(id, to) {
        await this.ready;
        const target = assertStatus(to);
        return this.pgmas.withClient(this.database, async (client) => {
            await client.query('begin');
            try {
                const current = await client.query('select status from requirements where id = $1 for update', [id]);
                const row = current.rows[0];
                if (row === undefined)
                    throw new Error('需求不存在或已删除');
                const from = assertStatus(row.status);
                if (!canTransition(from, target)) {
                    throw new Error(`非法状态流转 ${from} → ${target}`);
                }
                const updated = await client.query(`update requirements set status = $1, updated_at = now()
           where id = $2 and status = $3
           returning id, title, description, status, project_id, created_at, updated_at`, [target, id, from]);
                const updatedRow = updated.rows[0];
                if (updatedRow === undefined)
                    throw new Error('需求状态已变化，请刷新后重试');
                await client.query('commit');
                return rowToView(updatedRow);
            }
            catch (error) {
                await client.query('rollback');
                throw error;
            }
        });
    }
    /** 单条需求（续跑上下文用，不带 stages 折叠）。 */
    async getById(id) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query('select id, title, description, status, project_id, created_at, updated_at from requirements where id = $1', [id]));
        const row = result.rows[0];
        return row === undefined ? undefined : rowToView(row);
    }
    /** 该需求最近一条 success record（供下阶段上下文引用产物）。 */
    async listRecentRecord(requirementId) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query(`select id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, created_at, updated_at
         from records where requirement_id = $1 and status = 'success'
         order by created_at desc limit 1`, [requirementId]));
        const row = result.rows[0];
        return row === undefined ? undefined : recordRowToView(row);
    }
    /** Worker: open a stage ledger row (status `running`). */
    async appendRecord(input) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query(`insert into records (id, requirement_id, branch_id, category, title, status, result, artifacts, skills, parent_id, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $3, $4, $5, $6, $7, $8, now(), now())
         returning id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, created_at, updated_at`, [
            input.requirementId,
            input.branchId ?? null,
            input.category,
            input.status,
            input.result ?? null,
            input.artifacts ?? [],
            input.skills ?? [],
            input.parentId ?? null,
        ]));
        const row = result.rows[0];
        if (row === undefined)
            throw new Error('插入记录失败：没有返回行');
        return recordRowToView(row);
    }
    /** Worker: settle one stage ledger row by id. */
    async updateRecord(id, patch) {
        await this.ready;
        const sets = [];
        const values = [];
        const push = (column, value) => {
            sets.push(`${column} = $${values.length + 1}`);
            values.push(value);
        };
        if (patch.status !== undefined)
            push('status', patch.status);
        if (patch.result !== undefined)
            push('result', patch.result);
        if (patch.artifacts !== undefined)
            push('artifacts', patch.artifacts);
        if (patch.skills !== undefined)
            push('skills', patch.skills);
        if (sets.length === 0)
            throw new Error('updateRecord: 没有要更新的字段');
        sets.push('updated_at = now()');
        values.push(id);
        const result = await this.pgmas.withClient(this.database, client => client.query(`update records set ${sets.join(', ')} where id = $${values.length}
         returning id, requirement_id, branch_id, category, status, result, artifacts, skills, parent_id, created_at, updated_at`, values));
        const row = result.rows[0];
        if (row === undefined)
            throw new Error('记录不存在或已删除');
        return recordRowToView(row);
    }
    /**
     * Worker: PR created → requirement in_progress → merging。merge 阶段本身由
     * worker 的 runMerge 记账（merge record 含 pr_url）；此方法只推进状态，
     * 不重复插 record。
     */
    async markMerging(id, _prUrl) {
        await this.ready;
        return this.pgmas.withClient(this.database, async (client) => {
            await client.query('begin');
            try {
                const updated = await this.transitionOnClient(client, id, 'merging');
                await client.query('commit');
                return updated;
            }
            catch (error) {
                await client.query('rollback');
                throw error;
            }
        });
    }
    /** Panel: user confirmed merged → requirement merging → done + merge record. */
    async confirmMerged(id) {
        await this.ready;
        return this.pgmas.withClient(this.database, async (client) => {
            await client.query('begin');
            try {
                const updated = await this.transitionOnClient(client, id, 'done');
                await client.query(`insert into records (id, requirement_id, category, title, status, result, created_at, updated_at)
           values (gen_random_uuid(), $1, 'merge', 'merge', 'success', 'user confirmed merged', now(), now())`, [id]);
                await client.query('commit');
                return updated;
            }
            catch (error) {
                await client.query('rollback');
                throw error;
            }
        });
    }
    /** Shared state-machine transition on an already-acquired client (caller owns the transaction). */
    async transitionOnClient(client, id, to) {
        const current = await client.query('select status from requirements where id = $1 for update', [id]);
        const row = current.rows[0];
        if (row === undefined)
            throw new Error('需求不存在或已删除');
        const from = assertStatus(row.status);
        if (!canTransition(from, to)) {
            throw new Error(`非法状态流转 ${from} → ${to}`);
        }
        const updated = await client.query(`update requirements set status = $1, updated_at = now()
       where id = $2 and status = $3
       returning id, title, description, status, project_id, created_at, updated_at`, [to, id, from]);
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined)
            throw new Error('需求状态已变化，请刷新后重试');
        return rowToView(updatedRow);
    }
}
/** Projects registry (local path + git url + platform + optional PR token). */
export class ProjectsRepo {
    database;
    pgmas;
    ready;
    constructor(options) {
        this.pgmas = options.pgmas;
        this.database = options.database ?? DEFAULT_DATABASE;
        this.ready = runMigrations(this.pgmas, this.database, options.userId ?? DEFAULT_USER_ID);
    }
    async list() {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query('select id, name, local_path, git_url, platform, pr_token from projects order by created_at asc, name asc'));
        return result.rows.map(row => ({
            id: String(row.id),
            name: String(row.name),
            localPath: String(row.local_path),
            gitUrl: String(row.git_url),
            platform: (row.platform === 'gitea' ? 'gitea' : 'gitee'),
            hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
        }));
    }
    async create(input) {
        await this.ready;
        const name = (input.name ?? '').trim();
        const localPath = (input.localPath ?? '').trim();
        const gitUrl = (input.gitUrl ?? '').trim();
        if (name === '' || localPath === '' || gitUrl === '')
            throw new Error('项目名称/本地路径/git 链接均不能为空');
        if (input.platform !== 'gitee' && input.platform !== 'gitea')
            throw new Error('平台必须是 gitee 或 gitea');
        const result = await this.pgmas.withClient(this.database, client => client.query(`insert into projects (id, name, local_path, git_url, platform, pr_token, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
         returning id, name, local_path, git_url, platform, pr_token`, [name, localPath, gitUrl, input.platform, input.prToken === undefined || input.prToken === '' ? null : input.prToken]));
        const row = result.rows[0];
        if (row === undefined)
            throw new Error('插入项目失败：没有返回行');
        return {
            id: String(row.id),
            name: String(row.name),
            localPath: String(row.local_path),
            gitUrl: String(row.git_url),
            platform: (row.platform === 'gitea' ? 'gitea' : 'gitee'),
            hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
        };
    }
    /** Worker/PR 阶段读取 token；空串视为未配置。 */
    async getToken(id) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query('select pr_token from projects where id = $1', [id]));
        const row = result.rows[0];
        const token = row?.pr_token;
        return typeof token === 'string' && token !== '' ? token : undefined;
    }
    /** Resolve one project by id (worker 领取后取项目信息)。 */
    async getById(id) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query('select id, name, local_path, git_url, platform, pr_token from projects where id = $1', [id]));
        const row = result.rows[0];
        if (row === undefined)
            return undefined;
        return {
            id: String(row.id),
            name: String(row.name),
            localPath: String(row.local_path),
            gitUrl: String(row.git_url),
            platform: (row.platform === 'gitea' ? 'gitea' : 'gitee'),
            hasToken: row.pr_token !== null && row.pr_token !== undefined && String(row.pr_token) !== '',
        };
    }
}
/** ask_user_questions ledger (decision channel). */
export class QuestionsRepo {
    database;
    pgmas;
    ready;
    constructor(options) {
        this.pgmas = options.pgmas;
        this.database = options.database ?? DEFAULT_DATABASE;
        this.ready = runMigrations(this.pgmas, this.database, options.userId ?? DEFAULT_USER_ID);
    }
    async insertMany(recordId, questions) {
        await this.ready;
        await this.pgmas.withClient(this.database, async (client) => {
            for (const question of questions) {
                await client.query(`insert into ask_user_questions (id, record_id, question, options, status, created_at)
           values (gen_random_uuid(), $1, $2, $3, 'pending', now())`, [recordId, question.question, question.options ?? []]);
            }
        });
    }
    async listByRecord(recordId) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query(`select id, record_id, question, options, status, answer, created_at, answered_at
         from ask_user_questions where record_id = $1 order by created_at asc, id asc`, [recordId]));
        return result.rows.map(questionRowToView);
    }
    async pendingByRecord(recordId) {
        await this.ready;
        const result = await this.pgmas.withClient(this.database, client => client.query(`select id, record_id, question, options, status, answer, created_at, answered_at
         from ask_user_questions where record_id = $1 and status = 'pending' order by created_at asc, id asc`, [recordId]));
        return result.rows.map(questionRowToView);
    }
    async answer(questionId, answer) {
        await this.ready;
        const trimmed = (answer ?? '').trim();
        if (trimmed === '')
            throw new Error('回答不能为空');
        const result = await this.pgmas.withClient(this.database, client => client.query(`update ask_user_questions set status = 'answered', answer = $2, answered_at = now()
         where id = $1
         returning id, record_id, question, options, status, answer, created_at, answered_at`, [questionId, trimmed]));
        const row = result.rows[0];
        if (row === undefined)
            throw new Error('问题不存在或已删除');
        return questionRowToView(row);
    }
}
function questionRowToView(row) {
    return {
        id: String(row.id),
        recordId: String(row.record_id),
        question: String(row.question),
        options: toTextArray(row.options),
        status: row.status === 'answered' ? 'answered' : 'pending',
        answer: row.answer === null || row.answer === undefined ? null : String(row.answer),
        createdAt: iso(row.created_at),
        answeredAt: row.answered_at === null || row.answered_at === undefined ? null : iso(row.answered_at),
    };
}
