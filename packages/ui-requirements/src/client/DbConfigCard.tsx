/**
 * 数据库连接配置卡片：编辑 db-pgmas 行配置，写回用户层 cordis.patch.yml 的
 * override（patch watcher 热生效，无需重启）。渲染在看板「配置」页顶部，
 * 与 worker 时段/并发/模型卡片共用同一套表单样式。
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import InputNumber from '@douyinfe/semi-ui/lib/es/inputNumber'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import Switch from '@douyinfe/semi-ui/lib/es/switch'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { pgConfig, workerConfig, type PgConfigSnapshot } from './remote.ts'

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

interface Draft {
  host: string
  port: string
  user: string
  password: string
  database: string
  databases: string
  readOnly: boolean
  maxRows: string
}

function snapshotToDraft(snapshot: PgConfigSnapshot): Draft {
  const c = snapshot.config
  return {
    host: String(c.host ?? ''),
    port: String(c.port ?? ''),
    user: String(c.user ?? ''),
    password: String(c.password ?? ''),
    database: String(c.database ?? ''),
    databases: Array.isArray(c.databases) ? (c.databases as unknown[]).map(String).join(', ') : '',
    readOnly: c.readOnly !== false,
    maxRows: String(c.maxRows ?? ''),
  }
}

function draftToConfig(draft: Draft): Record<string, unknown> {
  const config: Record<string, unknown> = {
    host: draft.host.trim(),
    port: Number(draft.port.trim()),
    user: draft.user.trim(),
    database: draft.database.trim(),
  }
  if (draft.password !== '') config.password = draft.password
  const databases = draft.databases.split(',').map(item => item.trim()).filter(item => item !== '')
  if (databases.length > 0) config.databases = databases
  config.readOnly = draft.readOnly
  const maxRows = Number(draft.maxRows.trim())
  if (Number.isInteger(maxRows) && maxRows > 0) config.maxRows = maxRows
  return config
}

type Feedback = { kind: 'success' | 'error' | 'info'; text: string } | null

interface Props {
  onError: (message: string | null) => void
}

/** 数据库连接卡片（配置页顶部）。 */
export function DbConfigCard({ onError }: Props): ReactElement {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [snapshot, setSnapshot] = useState<PgConfigSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setFeedback(null)
    try {
      const snap = await pgConfig.get()
      setSnapshot(snap)
      setDraft(snapshotToDraft(snap))
      if (!snap.present) {
        setFeedback({
          kind: 'info',
          text: `patch 文件中还没有 db-pgmas 行(${snap.patchPath}),保存后会新建一个配置覆盖行。`,
        })
      }
    } catch (cause) {
      setFeedback({ kind: 'error', text: `读取配置失败:${messageOf(cause)}` })
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [onError])

  useEffect(() => { void load() }, [load])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft(current => current === null ? null : { ...current, [key]: value })
    setFeedback(null)
  }

  const handleTest = async (): Promise<void> => {
    if (draft === null) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await pgConfig.test(draftToConfig(draft))
      setFeedback({ kind: result.ok ? 'success' : 'error', text: result.message })
    } catch (cause) {
      setFeedback({ kind: 'error', text: `试连失败:${messageOf(cause)}` })
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (draft === null) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await pgConfig.save(draftToConfig(draft))
      if (result.ok) {
        setFeedback({ kind: 'success', text: `已写入 ${result.patchPath},patch watcher 热生效中。` })
      } else {
        setFeedback({ kind: 'error', text: result.error ?? '保存失败' })
      }
    } catch (cause) {
      setFeedback({ kind: 'error', text: `保存失败:${messageOf(cause)}` })
    } finally {
      setBusy(false)
    }
  }

  /** 显式跑一遍 cm 库 schema 迁移（幂等；配好连接后点一下即可补齐 schema）。
   *  始终携带卡片当前草稿值直连目标库——「测试连接成功但迁移仍连旧地址被拒」
   *  的错位（运行中 pgmas 池可能还是旧配置）不复存在，无需先保存再迁移。 */
  const handleMigrate = async (): Promise<void> => {
    if (draft === null) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await workerConfig.migrate(draftToConfig(draft))
      setFeedback({ kind: result.ok ? 'success' : 'error', text: result.message })
    } catch (cause) {
      setFeedback({ kind: 'error', text: `迁移失败:${messageOf(cause)}` })
    } finally {
      setBusy(false)
    }
  }

  if (draft === null || snapshot === null) {
    return <div className={classes.center}><Spin /></div>
  }

  return (
    <div className={classes.card}>
      <div className={classes.sectionTitle}><Typography.Text strong>数据库连接（pg）</Typography.Text></div>
      <div className={classes.form}>
        <div className={classes.formRow}>
          <div className={classes.formField}>
            <label>Host</label>
            <Input value={draft.host} onChange={value => { set('host', value) }} placeholder="127.0.0.1" />
          </div>
          <div className={classes.formField}>
            <label>Port</label>
            <InputNumber value={Number(draft.port) || undefined} min={1} max={65535} onChange={value => { set('port', String(value ?? '')) }} />
          </div>
          <div className={classes.formField}>
            <label>User</label>
            <Input value={draft.user} onChange={value => { set('user', value) }} placeholder="mas" />
          </div>
        </div>
        <div className={classes.formRow}>
          <div className={classes.formField}>
            <label>Password</label>
            <Input type="password" value={draft.password} onChange={value => { set('password', value) }} placeholder="（默认留空）" />
          </div>
          <div className={classes.formField}>
            <label>Database</label>
            <Input value={draft.database} onChange={value => { set('database', value) }} placeholder="mas" />
          </div>
          <div className={classes.formField}>
            <label>Databases（逗号分隔）</label>
            <Input value={draft.databases} onChange={value => { set('databases', value) }} placeholder="mas, cm, facai" />
          </div>
        </div>
        <div className={classes.formRow}>
          <div className={classes.formField}>
            <label>MaxRows</label>
            <InputNumber value={Number(draft.maxRows) || undefined} min={1} max={1000} onChange={value => { set('maxRows', String(value ?? '')) }} />
          </div>
          <div className={classes.formField}>
            <label>ReadOnly</label>
            <Switch checked={draft.readOnly} onChange={value => { set('readOnly', value) }} />
            <Typography.Text type="tertiary" size="small">开启后 pg_query 拒绝写语句</Typography.Text>
          </div>
        </div>
      </div>

      {feedback !== null && (
        <div className={classes.feedback}>
          <Typography.Text type={feedback.kind === 'success' ? 'success' : feedback.kind === 'error' ? 'danger' : 'tertiary'} size="small">
            {feedback.text}
          </Typography.Text>
        </div>
      )}

      <div className={classes.formRow}>
        <Button theme="solid" type="primary" disabled={busy} onClick={() => { void handleTest() }}>测试连接</Button>
        <Button theme="solid" disabled={busy} onClick={() => { void handleMigrate() }}>迁移（建表）</Button>
        <Button theme="solid" disabled={busy} onClick={() => { void handleSave() }}>保存并应用</Button>
      </div>
      <Typography.Text type="tertiary" size="small">
        patch 文件:{snapshot.patchPath}(用户层覆盖,升级 bundle 不覆盖)
      </Typography.Text>
    </div>
  )
}
