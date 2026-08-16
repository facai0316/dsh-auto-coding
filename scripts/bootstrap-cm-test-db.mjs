/**
 * Bootstrap the isolated test database (default `cm_fake_test`) for the
 * cm-flow / cm-worker vitest suites.
 *
 * The test suites connect directly via `pg` (host 127.0.0.1:25678), NOT through
 * the pg-mas service allowlist, so this script only needs a raw pg client.
 *
 * What it does (idempotent):
 *  1. Creates the SeaORM baseline tables exactly as the coding-manager
 *     migrations m20260815_000001..000006 leave them: users / requirements /
 *     records / branches. cm-flow migration v1 asserts `requirements` exists,
 *     so this baseline must be in place before cm-flow migrations can run.
 *  2. Constructs RequirementsRepo against the test DB, which runs the cm-flow
 *     forward migrations v1..v7 (projects + seed fac-ai-rs, requirements.
 *     project_id, ask_user_questions, worker_config, records.retry_count,
 *     reviews) and inserts the default dsh user.
 *  3. Seeds the two test-only users used by the suites (…fffb, …fffc) so the
 *     requirements.user_id FK is satisfied.
 *
 * Usage: node scripts/bootstrap-cm-test-db.mjs [database]
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// `pg` 是各 workspace 包的 devDependency，未提升到仓库根；从 cm-flow 包解析。
const cmFlowRequire = createRequire(fileURLToPath(new URL('../packages/cm-flow/package.json', import.meta.url)))
const pg = cmFlowRequire('pg')
const { RequirementsRepo } = cmFlowRequire('./build/index.js')

const TEST_DATABASE = process.argv[2] ?? 'cm_fake_test'
const TEST_USER_IDS = [
  '00000000-0000-4000-8000-00000000fffb', // cm-flow.test.ts
  '00000000-0000-4000-8000-00000000fffc', // worker.test.ts
]

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 25678,
  user: 'mas',
  password: 'Fa^Cai!0316#Mas.',
  database: TEST_DATABASE,
  connectionTimeoutMillis: 3000,
  statement_timeout: 60_000,
  max: 2,
})

function writeSeam(p) {
  return {
    withClient: async (_database, fn) => {
      const client = await p.connect()
      try {
        return await fn(client)
      } finally {
        client.release()
      }
    },
  }
}

/** Final state of the coding-manager SeaORM baseline (000001..000006). */
const BASELINE = `
create table if not exists users (
  id            uuid primary key,
  email         varchar(255) not null unique,
  password_hash varchar(255) not null,
  nickname      varchar(255),
  created_at    timestamptz not null,
  updated_at    timestamptz not null
);

create table if not exists requirements (
  id          uuid primary key,
  user_id     uuid not null,
  title       varchar(255) not null,
  description text,
  status      varchar(32) not null default 'draft',
  created_at  timestamptz not null,
  updated_at  timestamptz not null,
  constraint "fk-requirements-user-id" foreign key (user_id) references users(id)
);

create table if not exists records (
  id             uuid primary key,
  category       varchar(32) not null,
  title          varchar(255) not null,
  message        text,
  result         text,
  "references"   text[] not null default '{}',
  artifacts      text[] not null default '{}',
  skills         text[] not null default '{}',
  parent_id      varchar(255),
  child_id       varchar(255),
  branch_id      varchar(255),
  created_at     timestamptz not null,
  updated_at     timestamptz not null,
  status         varchar(32) not null default 'pending_approval',
  requirement_id varchar(255)
);

create table if not exists branches (
  id               uuid primary key,
  name             varchar(255) not null unique,
  description      text,
  begin_record_id  varchar(255),
  auto_delete      boolean not null default false,
  merge_time       timestamptz,
  created_at       timestamptz not null,
  updated_at       timestamptz not null
);
`

async function main() {
  const client = await pool.connect()
  try {
    // 1. SeaORM baseline（幂等；cm-flow v1 依赖 requirements 存在）
    await client.query(BASELINE)
    console.log(`[bootstrap] baseline tables ensured in ${TEST_DATABASE}`)
  } finally {
    client.release()
  }

  // 2. cm-flow migrations v1..v7 + default dsh user（repo 构造即跑，幂等）
  const repo = new RequirementsRepo({ pgmas: writeSeam(pool), database: TEST_DATABASE })
  await repo.list() // force this.ready
  console.log(`[bootstrap] cm-flow migrations applied in ${TEST_DATABASE}`)

  // 3. 测试专用用户（requirements.user_id FK）
  const seed = await pool.connect()
  try {
    for (const id of TEST_USER_IDS) {
      await seed.query(
        `insert into users (id, email, password_hash, nickname, created_at, updated_at)
         values ($1, $2, '', 'dsh', now(), now())
         on conflict (id) do nothing`,
        [id, `dsh+${id}@dsh.local`],
      )
    }
  } finally {
    seed.release()
  }
  console.log(`[bootstrap] test users seeded: ${TEST_USER_IDS.join(', ')}`)

  await pool.end()
  console.log('[bootstrap] done')
}

main().catch(async error => {
  console.error('[bootstrap] FAILED:', error)
  await pool.end().catch(() => {})
  process.exit(1)
})
