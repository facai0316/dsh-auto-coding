import { useCallback, useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Checkbox from '@douyinfe/semi-ui/lib/es/checkbox'
import InputNumber from '@douyinfe/semi-ui/lib/es/inputNumber'
import Select from '@douyinfe/semi-ui/lib/es/select'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import Switch from '@douyinfe/semi-ui/lib/es/switch'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { workerConfig, type LlmProviderInfo, type StageModelConfig, type WorkerConfig } from './remote.ts'
import { DbConfigCard } from './DbConfigCard.tsx'
import { STAGE_LABEL } from './board.ts'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** 面板可配置的阶段（pipeline 6 阶段 + merge + resolve；cleanup 不跑 agent）。 */
const CONFIGURABLE_STAGES = ['decision', 'plan', 'review-plan', 'coding', 'contract', 'review-code', 'merge', 'resolve']

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: hour,
  label: `${String(hour).padStart(2, '0')}:00`,
}))

const INHERIT = ''

interface StageDraft {
  provider: string
  model: string
  maxTokens: string
}

interface Draft {
  timeWindowEnabled: boolean
  /** 受时段限制的阶段（category）；缺省（旧配置 null）在 toDraft 里展开为全选。 */
  timeWindowStages: string[]
  startHour: number
  endHour: number
  concurrency: number
  defaultProvider: string
  defaultModel: string
  defaultMaxTokens: string
  stages: Record<string, StageDraft>
}

function toDraft(config: WorkerConfig): Draft {
  const stages: Record<string, StageDraft> = {}
  for (const category of CONFIGURABLE_STAGES) {
    const stage = config.stages[category]
    stages[category] = {
      provider: stage?.provider ?? '',
      model: stage?.model ?? '',
      maxTokens: stage?.maxTokens === undefined || stage?.maxTokens === null ? '' : String(stage.maxTokens),
    }
  }
  return {
    timeWindowEnabled: config.timeWindowEnabled,
    // null/缺省（旧配置）= 全部阶段受限 → 展开为全选；空数组 = 无阶段受限。
    timeWindowStages: config.timeWindowStages ?? [...CONFIGURABLE_STAGES],
    startHour: config.startHour,
    endHour: config.endHour,
    concurrency: config.concurrency ?? 1,
    defaultProvider: config.defaultProvider ?? '',
    defaultModel: config.defaultModel ?? '',
    defaultMaxTokens: config.defaultMaxTokens === undefined || config.defaultMaxTokens === null ? '' : String(config.defaultMaxTokens),
    stages,
  }
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

function toConfig(draft: Draft): WorkerConfig {
  const stages: Record<string, StageModelConfig> = {}
  for (const category of CONFIGURABLE_STAGES) {
    const stage = draft.stages[category]
    const entry: StageModelConfig = {}
    if (stage.provider.trim() !== '') entry.provider = stage.provider.trim()
    if (stage.model.trim() !== '') entry.model = stage.model.trim()
    const maxTokens = optionalNumber(stage.maxTokens)
    if (maxTokens !== undefined) entry.maxTokens = maxTokens
    if (Object.keys(entry).length > 0) stages[category] = entry
  }
  return {
    timeWindowEnabled: draft.timeWindowEnabled,
    timeWindowStages: draft.timeWindowStages,
    startHour: draft.startHour,
    endHour: draft.endHour,
    concurrency: Math.min(8, Math.max(1, Math.floor(draft.concurrency || 1))),
    stages,
    defaultModel: draft.defaultModel.trim() === '' ? null : draft.defaultModel.trim(),
    defaultProvider: draft.defaultProvider.trim() === '' ? null : draft.defaultProvider.trim(),
    defaultMaxTokens: optionalNumber(draft.defaultMaxTokens) ?? null,
  }
}

interface Props {
  onError: (message: string | null) => void
}

/**
 * 配置页：worker 时段窗口 + 默认/每阶段模型。提供商与模型为下拉框，选项来自
 * host `ctx.llm`（只列已注册提供商及其实例化模型目录）；留空 = 继承。
 * 保存后 worker 下个 tick（默认 ≤10s）生效，持久化于 cm 库 worker_config。
 */
export function ConfigPage({ onError }: Props): ReactElement {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [providers, setProviders] = useState<readonly LlmProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  // worker 配置（时段/并发/模型）读库；数据库不可达时的错误单独展示——
  // 数据库连接卡片是唯一修复入口，绝不能被这个失败连坐卡死（鸡生蛋问题）。
  const [configError, setConfigError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    onError(null)
    try {
      const [config, providerRows] = await Promise.all([workerConfig.get(), workerConfig.providers()])
      setDraft(toDraft(config))
      setProviders(providerRows)
      setConfigError(null)
    } catch (cause) {
      // 只拦 worker 配置区：页面骨架与「数据库连接」卡片照常渲染（后者读写
      // patch 文件 + 一次性试连，不依赖数据库连接池），修好连接后点重试即可。
      setConfigError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => { void load() }, [load])

  const patch = useCallback((update: Partial<Draft>) => {
    setSaved(false)
    setDraft(prev => prev === null ? prev : { ...prev, ...update })
  }, [])

  const patchStage = useCallback((category: string, update: Partial<StageDraft>) => {
    setSaved(false)
    setDraft(prev => prev === null ? prev : ({
      ...prev,
      stages: { ...prev.stages, [category]: { ...prev.stages[category]!, ...update } },
    }))
  }, [])

  const save = useCallback(async () => {
    if (draft === null || busy) return
    setBusy(true)
    setSaved(false)
    onError(null)
    try {
      const savedConfig = await workerConfig.set(toConfig(draft))
      setDraft(toDraft(savedConfig))
      setSaved(true)
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [draft, busy, onError])

  // 某 provider 的模型目录；provider 留空时给出全部模型的并集（去重）。
  const modelOptionsOf = useCallback((providerId: string): { value: string; label: string }[] => {
    const rows = providerId === ''
      ? providers.flatMap(provider => provider.models)
      : providers.find(provider => provider.id === providerId)?.models ?? []
    const seen = new Set<string>()
    return rows
      .filter(model => !seen.has(model.id) && seen.add(model.id))
      .map(model => ({ value: model.id, label: model.name || model.id }))
  }, [providers])

  const providerOptions = useCallback((current: string): { value: string; label: string }[] => {
    const options = [
      { value: INHERIT, label: '留空（继承）' },
      ...providers.map(provider => ({ value: provider.id, label: provider.name || provider.id })),
    ]
    if (current !== '' && !options.some(option => option.value === current)) {
      options.push({ value: current, label: `${current}（未注册）` })
    }
    return options
  }, [providers])

  const modelOptions = useCallback((current: string, providerId: string): { value: string; label: string }[] => {
    const options = [
      { value: INHERIT, label: '留空（继承）' },
      ...modelOptionsOf(providerId),
    ]
    if (current !== '' && !options.some(option => option.value === current)) {
      options.push({ value: current, label: `${current}（未在目录）` })
    }
    return options
  }, [modelOptionsOf])

  if (loading && draft === null && configError === null) {
    return <div className={classes.center}><Spin /></div>
  }

  // worker 配置加载失败（典型：数据库不可达）：数据库连接卡片仍渲染——它是
  // 修复连接的唯一入口；修好并保存（patch 热生效）后点「重试」读回配置。
  if (draft === null) {
    return (
      <div className={classes.page}>
        <DbConfigCard onError={onError} />
        <div className={classes.card}>
          <div className={classes.sectionTitle}><Typography.Text strong>Worker 配置（时段 / 并发 / 模型）</Typography.Text></div>
          <div className={classes.form}>
            {configError === null
              ? <div className={classes.center}><Spin /></div>
              : (
                <>
                  <Typography.Text type="danger" size="small">{configError}</Typography.Text>
                  <div className={classes.formRow}>
                    <Button theme="solid" disabled={busy} onClick={() => { void load() }}>重试</Button>
                  </div>
                  <Typography.Text type="tertiary" size="small">
                    数据库不可达时读不到 worker 配置。先在上方「数据库连接」卡片改好连接并点「保存」（配置热生效），
                    再回到这里点「重试」；首次使用还需在该卡片点「迁移（建表）」初始化 schema。
                  </Typography.Text>
                </>
              )}
          </div>
        </div>
      </div>
    )
  }

  const modelField = (
    current: string,
    providerId: string,
    onChange: (value: string) => void,
  ): ReactElement => (
    <Select
      className={classes.configSelect}
      value={current === '' ? INHERIT : current}
      onChange={(value) => { onChange(value === undefined || value === null ? '' : String(value)) }}
      optionList={modelOptions(current, providerId)}
    />
  )

  const providerField = (
    current: string,
    onChange: (value: string) => void,
  ): ReactElement => (
    <Select
      className={classes.configSelect}
      value={current === '' ? INHERIT : current}
      onChange={(value) => { onChange(value === undefined || value === null ? '' : String(value)) }}
      optionList={providerOptions(current)}
    />
  )

  return (
    <div className={classes.page}>
      {/* ── 数据库连接 ── */}
      <DbConfigCard onError={onError} />

      {/* ── 时段 ── */}
      <div className={classes.card}>
        <div className={classes.sectionTitle}><Typography.Text strong>时段（仅指定时段运行）</Typography.Text></div>
        <div className={classes.form}>
          <div className={classes.formField}>
            <label>启用时段限制</label>
            <Switch
              checked={draft.timeWindowEnabled}
              onChange={(value) => { patch({ timeWindowEnabled: value }) }}
            />
          </div>
          <div className={classes.formRow}>
            <div className={classes.formField}>
              <label>起始</label>
              <Select
                className={classes.configSelect}
                value={draft.startHour}
                onChange={(value) => { patch({ startHour: Number(value) }) }}
                optionList={HOUR_OPTIONS}
              />
            </div>
            <div className={classes.formField}>
              <label>结束（不含）</label>
              <Select
                className={classes.configSelect}
                value={draft.endHour}
                onChange={(value) => { patch({ endHour: Number(value) }) }}
                optionList={HOUR_OPTIONS}
              />
            </div>
          </div>
          {draft.timeWindowEnabled && (
            <div className={classes.formField}>
              <label>限时段的阶段（未勾选的不限时段）</label>
              <Checkbox.Group
                className={classes.stageChecks}
                value={draft.timeWindowStages}
                onChange={(value) => { patch({ timeWindowStages: (value ?? []).map(String) }) }}
                options={CONFIGURABLE_STAGES.map(category => ({ label: STAGE_LABEL[category] ?? category, value: category }))}
              />
            </div>
          )}
          <Typography.Text type="tertiary" size="small">
            关闭时 24h 全时段运行；起=止视为不限；结束跨天（如 22:00→06:00）视为夜间窗口。
            勾选的阶段在窗口外不领取 / 不续跑 / 不重试（链上到该阶段时停下，进窗后续跑）；
            未勾选的阶段 24h 可跑。旧配置未存清单时视为全部阶段受限。
          </Typography.Text>
        </div>
      </div>

      {/* ── 并发 ── */}
      <div className={classes.card}>
        <div className={classes.sectionTitle}><Typography.Text strong>并发</Typography.Text></div>
        <div className={classes.form}>
          <div className={classes.formRow}>
            <div className={classes.formField}>
              <label>并发流水线数</label>
              <InputNumber
                className={classes.configSelect}
                min={1}
                max={8}
                value={draft.concurrency}
                onChange={(value) => { patch({ concurrency: Math.min(8, Math.max(1, Math.floor(Number(value ?? 1)))) }) }}
              />
            </div>
          </div>
          <Typography.Text type="tertiary" size="small">
            全局并发预算（1–8；1 = 串行，默认）：同时运行的流水线数——包括领取的新需求、
            审核放行/驳回后的续跑与失败重试（冲突解决也占槽）。每条并发任务各占一个阶段会话、
            各自独立 worktree；领取用
            <code> for update skip locked </code>
            互斥，同一项目不同需求的分支互不干扰。审核逐条放行也会按预算并发续跑。
          </Typography.Text>
        </div>
      </div>

      {/* ── 默认模型 ── */}
      <div className={classes.card}>
        <div className={classes.sectionTitle}><Typography.Text strong>默认模型（未单独配置的阶段使用）</Typography.Text></div>
        <div className={classes.form}>
          <div className={classes.formRow}>
            <div className={classes.formField}>
              <label>提供商</label>
              {providerField(draft.defaultProvider, value => { patch({ defaultProvider: value }) })}
            </div>
            <div className={classes.formField}>
              <label>模型</label>
              {modelField(draft.defaultModel, draft.defaultProvider, value => { patch({ defaultModel: value }) })}
            </div>
            <div className={classes.formField}>
              <label>最大 Tokens</label>
              <InputNumber
                className={classes.configSelect}
                value={draft.defaultMaxTokens === '' ? undefined : Number(draft.defaultMaxTokens)}
                onChange={(value) => { patch({ defaultMaxTokens: value === undefined || value === null ? '' : String(value) }) }}
                placeholder="留空默认"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── 每阶段模型/模式 ── */}
      <div className={classes.card}>
        <div className={classes.sectionTitle}><Typography.Text strong>每阶段模型 / 模式</Typography.Text></div>
        <div className={classes.form}>
          {CONFIGURABLE_STAGES.map(category => {
            const stage = draft.stages[category]!
            return (
              <div key={category} className={classes.formRow}>
                <div className={classes.formField}>
                  <label>{STAGE_LABEL[category] ?? category}</label>
                  {providerField(stage.provider, value => { patchStage(category, { provider: value }) })}
                </div>
                <div className={classes.formField}>
                  <label>模型</label>
                  {modelField(stage.model, stage.provider, value => { patchStage(category, { model: value }) })}
                </div>
                <div className={classes.formField}>
                  <label>最大 Tokens</label>
                  <InputNumber
                    className={classes.configSelect}
                    value={stage.maxTokens === '' ? undefined : Number(stage.maxTokens)}
                    onChange={(value) => { patchStage(category, { maxTokens: value === undefined || value === null ? '' : String(value) }) }}
                    placeholder="留空默认"
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className={classes.formRow}>
        <Button theme="solid" disabled={busy} onClick={() => { void save() }}>保存配置</Button>
        {saved && <Typography.Text type="success">已保存，worker 将在下一轮 tick（≤10s）生效</Typography.Text>}
      </div>
    </div>
  )
}
