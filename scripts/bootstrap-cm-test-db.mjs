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


async function main() {
  // 1. baseline 已废弃（ADR-032）：迁移 v8 自建全量表，无需预建任何表。
  // 2. cm-flow migrations（repo 构造即跑，幂等；v8 建全量表 + users 种子）
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
