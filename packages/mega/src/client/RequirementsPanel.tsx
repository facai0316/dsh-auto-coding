import { useCallback, useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Pagination from '@douyinfe/semi-ui/lib/es/pagination'
import Select from '@douyinfe/semi-ui/lib/es/select'
import Spin from '@douyinfe/semi-ui/lib/es/spin'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { merge, projects, questions, records, requirements, reviews, type Project, type RecordListItem as RecordItem, type RecordStatus, type RequirementWithStages, type Review } from './remote.ts'
import { CATEGORIES, RECORD_STATUSES, RECORD_STATUS_LABEL, STAGE_LABEL, recordStatusColor } from './board.ts'
import { ReviewHall, type ReplyItem } from './ReviewHall.tsx'
import { ConfigPage } from './ConfigPage.tsx'
import { UsageGuidePage } from './UsageGuidePage.tsx'
import { RequirementCard } from './RequirementCard.tsx'
import { RequirementFormModal } from './RequirementFormModal.tsx'
import { QuestionModal } from './QuestionModal.tsx'
import { ProjectFormModal } from './ProjectFormModal.tsx'
import { ProjectCard } from './ProjectCard.tsx'
import { RecordCard } from './RecordCard.tsx'
import { RecordFormModal } from './RecordFormModal.tsx'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

type TabKey = 'review' | 'project' | 'rqm' | 'record' | 'config' | 'usage'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'review', label: '审核' },
  { key: 'project', label: '项目' },
  { key: 'rqm', label: '需求' },
  { key: 'record', label: '运行' },
  { key: 'config', label: '配置' },
  { key: 'usage', label: '使用说明' },
]

interface AskTarget {
  recordId: string
  title: string
}

/**
 * 自动化看板：顶部导航栏（项目 / 需求 / 运行）切换三个 card grid 页面。
 * 每个页面右上角「新增」；卡片统一提供 详情/编辑/删除。数据经 cm-flow
 * 四 namespace remote（requirements / projects / questions / records）落 cm 库。
 */
export function RequirementsPanel(): ReactElement {
  const [tab, setTab] = useState<TabKey>('project')
  const [projectList, setProjectList] = useState<readonly Project[]>([])
  const [items, setItems] = useState<readonly RequirementWithStages[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rqmFormVisible, setRqmFormVisible] = useState(false)
  const [projectFormVisible, setProjectFormVisible] = useState(false)
  const [projectEditTarget, setProjectEditTarget] = useState<Project | null>(null)
  const [recordFormVisible, setRecordFormVisible] = useState(false)
  const [askTarget, setAskTarget] = useState<AskTarget | null>(null)
  const [recordRefreshKey, setRecordRefreshKey] = useState(0)
  const [reviewGates, setReviewGates] = useState<readonly Review[]>([])
  const [replyItems, setReplyItems] = useState<readonly ReplyItem[]>([])
  const [merging, setMerging] = useState<readonly RequirementWithStages[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [projectRows, requirementRows, waitingRows, ticketRows] = await Promise.all([
        projects.list(),
        requirements.list(),
        records.list({ status: 'waiting_reply' }),
        reviews.list(),
      ])
      // 审核大厅：人工审核门（kind=review 的 pending 单）+ 待决策记录（含各自
      // 问题与 pending reply 放行单）+ merging 需求单列。
      const questionsByRecord = await Promise.all(waitingRows.map(record => questions.list(record.id)))
      setProjectList(projectRows)
      setItems(requirementRows)
      setReviewGates(ticketRows.filter(ticket => ticket.kind === 'review'))
      const replyTickets = ticketRows.filter(ticket => ticket.kind === 'reply')
      setReplyItems(waitingRows.map((record, index) => ({
        record,
        questions: questionsByRecord[index]!,
        ticket: replyTickets.find(ticket => ticket.recordId === record.id),
      })))
      setMerging(requirementRows.filter(item => item.status === 'merging'))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshView = useCallback(() => { void refresh() }, [refresh])

  // 待审核数（审核 tab 角标）：待审核门数 + 待决策记录数 + 待合并数。
  const reviewCount = reviewGates.length + replyItems.length + merging.length

  useEffect(() => { void refresh() }, [refresh])

  const submitRqmCreate = useCallback(async (title: string, description: string, targetProjectId: string) => {
    try {
      await requirements.create(title, description, targetProjectId)
      setRqmFormVisible(false)
      await refresh()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [refresh])

  const done = items.filter(item => item.status === 'done').length

  return (
    <div className={classes.panel}>
      {/* 顶部导航栏：项目 / 需求 / 运行 */}
      <div className={classes.nav}>
        <div className={classes.navTabs}>
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              className={`${classes.navTab}${tab === t.key ? ` ${classes.navTabActive}` : ''}`}
              onClick={() => { setTab(t.key) }}
            >
              {t.label}
              {t.key === 'review' && reviewCount > 0 && (
                <span className={classes.navBadge}>{reviewCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className={classes.navRight}>
          {tab === 'project' && (
            <Button theme="solid" disabled={loading} onClick={() => { setProjectFormVisible(true) }}>新增项目</Button>
          )}
          {tab === 'rqm' && (
            <Button theme="solid" disabled={loading} onClick={() => { setRqmFormVisible(true) }}>新增需求</Button>
          )}
          {tab === 'record' && (
            <Button theme="solid" disabled={loading} onClick={() => { setRecordFormVisible(true) }}>新增运行</Button>
          )}
        </div>
      </div>

      {error !== null && (
        <div className={classes.error}>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button size="small" theme="borderless" onClick={() => { void refresh() }}>重试</Button>
        </div>
      )}

      <div className={classes.body}>
        {tab === 'review' && (
          <ReviewHall
            reviewGates={reviewGates}
            replyItems={replyItems}
            merging={merging}
            loading={loading}
            onChanged={refreshView}
            onError={setError}
          />
        )}
        {tab === 'project' && (
          <ProjectPage
            projects={projectList}
            loading={loading}
            onChanged={() => { void refresh() }}
            onEdit={setProjectEditTarget}
            onError={setError}
          />
        )}
        {tab === 'rqm' && (
          <RqmPage
            items={items}
            loading={loading}
            onAsk={(recordId, title) => { setAskTarget({ recordId, title }) }}
            onChanged={() => { void refresh() }}
          />
        )}
        {tab === 'record' && (
          <RecordPage
            requirements={items}
            refreshKey={recordRefreshKey}
            onChanged={() => { setRecordRefreshKey(key => key + 1) }}
          />
        )}
        {tab === 'config' && (
          <ConfigPage onError={setError} />
        )}
        {tab === 'usage' && (
          <UsageGuidePage />
        )}
      </div>

      <div className={classes.foot}>
        <Typography.Text type="tertiary" size="small">
          {tab === 'review'
            ? `待审核 ${reviewGates.length} 项 · 待决策 ${replyItems.length} 项 · 待合并 ${merging.length} 项`
            : tab === 'rqm'
              ? `共 ${items.length} 条需求，已完成 ${done} 条`
              : '流水线状态持久化于 cm 库'}
        </Typography.Text>
      </div>

      <RequirementFormModal
        visible={rqmFormVisible}
        projects={projectList}
        busy={loading}
        onClose={() => { setRqmFormVisible(false) }}
        onSubmit={(title, description, targetProjectId) => { void submitRqmCreate(title, description, targetProjectId) }}
      />
      <ProjectFormModal
        visible={projectFormVisible}
        busy={loading}
        onClose={() => { setProjectFormVisible(false) }}
        onSubmit={async (input) => {
          try {
            await projects.create(input)
            setProjectFormVisible(false)
            await refresh()
          } catch (cause) {
            setError(messageOf(cause))
          }
        }}
      />
      {projectEditTarget !== null && (
        <ProjectFormModal
          visible
          initial={projectEditTarget}
          busy={loading}
          onClose={() => { setProjectEditTarget(null) }}
          onSubmit={async (input) => {
            try {
              await projects.update(projectEditTarget.id, input)
              setProjectEditTarget(null)
              await refresh()
            } catch (cause) {
              setError(messageOf(cause))
            }
          }}
        />
      )}
      <RecordFormModal
        visible={recordFormVisible}
        requirements={items}
        busy={loading}
        onClose={() => { setRecordFormVisible(false) }}
        onSubmit={async (input) => {
          try {
            await records.create(input)
            setRecordFormVisible(false)
            setRecordRefreshKey(key => key + 1)
          } catch (cause) {
            setError(messageOf(cause))
          }
        }}
      />
      {askTarget !== null && (
        <QuestionModal
          recordId={askTarget.recordId}
          title={askTarget.title}
          onClose={() => { setAskTarget(null) }}
          onAnswered={() => { void refresh() }}
        />
      )}
    </div>
  )
}

// ── 项目页 ────────────────────────────────────────────────────────────────

interface ProjectPageProps {
  projects: readonly Project[]
  loading: boolean
  onChanged: () => void
  onEdit: (project: Project) => void
  onError: (message: string | null) => void
}

function ProjectPage({ projects: list, loading, onChanged, onEdit, onError }: ProjectPageProps): ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null)

  const remove = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await projects.delete(id)
      onChanged()
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }, [onChanged, onError])

  return (
    <div className={classes.page}>
      {loading
        ? <div className={classes.center}><Spin /></div>
        : list.length === 0
          ? <div className={classes.center}><Typography.Text type="tertiary">暂无项目，点击右上角「新增项目」开始。</Typography.Text></div>
          : (
            <div className={classes.grid}>
              {list.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  busy={busyId === project.id}
                  onEdit={() => { onEdit(project) }}
                  onRemove={() => { void remove(project.id) }}
                />
              ))}
            </div>
          )}
    </div>
  )
}

// ── 需求页 ────────────────────────────────────────────────────────────────

interface RqmPageProps {
  items: readonly RequirementWithStages[]
  loading: boolean
  onAsk: (recordId: string, title: string) => void
  onChanged: () => void
}

function RqmPage({ items, loading, onAsk, onChanged }: RqmPageProps): ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const remove = useCallback(async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await requirements.delete(id)
      onChanged()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }, [onChanged])

  // merging 需求的「解决冲突」：起跑冲突解决任务（后台执行，结果看运行页/审核页）。
  const resolve = useCallback(async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await merge.resolveConflicts(id)
      onChanged()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }, [onChanged])

  return (
    <div className={classes.page}>
      {error !== null && (
        <div className={classes.error}>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button size="small" theme="borderless" onClick={() => { setError(null) }}>关闭</Button>
        </div>
      )}
      {loading
        ? <div className={classes.center}><Spin /></div>
        : items.length === 0
          ? <div className={classes.center}><Typography.Text type="tertiary">暂无需求，点击右上角「新增需求」开始。</Typography.Text></div>
          : (
            <div className={classes.grid}>
              {items.map(item => (
                <RequirementCard
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  onRefresh={onChanged}
                  onAsk={onAsk}
                  onResolve={(id) => { void resolve(id) }}
                  onRemove={() => { void remove(item.id) }}
                />
              ))}
            </div>
          )}
    </div>
  )
}

// ── 运行页 ────────────────────────────────────────────────────────────────

interface RecordPageProps {
  requirements: readonly RequirementWithStages[]
  refreshKey: number
  onChanged: () => void
}

function RecordPage({ requirements: rqmList, refreshKey, onChanged }: RecordPageProps): ReactElement {
  const [category, setCategory] = useState<string | undefined>()
  const [requirementId, setRequirementId] = useState<string | undefined>()
  // 进入页面默认筛选「执行中」；可切回「全部状态」（undefined）。
  const [status, setStatus] = useState<RecordStatus | undefined>('running')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<readonly RecordItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editTarget, setEditTarget] = useState<RecordItem | null>(null)
  const [detailTarget, setDetailTarget] = useState<RecordItem | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(await records.list({ category, requirementId, status }))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [category, requirementId, status])

  useEffect(() => { void refresh() }, [refresh, refreshKey])

  const remove = useCallback(async (id: string) => {
    setBusyId(id)
    setError(null)
    try {
      await records.delete(id)
      await refresh()
      onChanged()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusyId(null)
    }
  }, [refresh, onChanged])

  // 分页：固定 12 条/页（不允许改 pageSize），筛选变化回到第 1 页。
  const pageSize = 12
  const maxPage = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, maxPage)
  const pageItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  return (
    <div className={classes.page}>
      {/* 运行页筛选：category / rqm / status */}
      <div className={classes.filters}>
        <Select
          className={classes.filterSelect}
          value={category}
          onChange={(value) => { setCategory(value as string | undefined); setPage(1) }}
          optionList={[
            { value: undefined, label: '全部阶段' },
            ...CATEGORIES.map(c => ({ value: c, label: STAGE_LABEL[c] ?? c })),
          ]}
        />
        <Select
          className={classes.filterSelect}
          value={requirementId}
          onChange={(value) => { setRequirementId(value as string | undefined); setPage(1) }}
          optionList={[
            { value: undefined, label: '全部需求' },
            ...rqmList.map(r => ({ value: r.id, label: r.title })),
          ]}
        />
        <Select
          className={classes.filterSelect}
          value={status}
          onChange={(value) => { setStatus(value as RecordStatus | undefined); setPage(1) }}
          optionList={[
            { value: undefined, label: '全部状态' },
            ...RECORD_STATUSES.map(s => ({ value: s, label: RECORD_STATUS_LABEL[s] })),
          ]}
        />
      </div>
      {error !== null && (
        <div className={classes.error}>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button size="small" theme="borderless" onClick={() => { void refresh() }}>重试</Button>
        </div>
      )}
      {loading
        ? <div className={classes.center}><Spin /></div>
        : items.length === 0
          ? <div className={classes.center}><Typography.Text type="tertiary">暂无运行记录。</Typography.Text></div>
          : (
            <>
              <div className={classes.grid}>
                {pageItems.map(item => (
                  <RecordCard
                    key={item.id}
                    item={item}
                    busy={busyId === item.id}
                    onDetail={() => { setDetailTarget(item) }}
                    onEdit={() => { setEditTarget(item) }}
                    onRemove={() => { void remove(item.id) }}
                  />
                ))}
              </div>
              <div className={classes.pager}>
                <Pagination
                  currentPage={currentPage}
                  total={items.length}
                  pageSize={pageSize}
                  showSizeChanger={false}
                  onPageChange={(nextPage) => { setPage(nextPage) }}
                />
              </div>
            </>
          )}
      {detailTarget !== null && (
        <RecordDetailModal item={detailTarget} onClose={() => { setDetailTarget(null) }} />
      )}
      {editTarget !== null && (
        <RecordFormModal
          visible
          initial={editTarget}
          requirements={rqmList}
          busy={loading}
          onClose={() => { setEditTarget(null) }}
          onSubmit={async (input) => {
            try {
              await records.update(editTarget.id, input)
              setEditTarget(null)
              await refresh()
              onChanged()
            } catch (cause) {
              setError(messageOf(cause))
            }
          }}
        />
      )}
    </div>
  )
}

// ── 运行详情弹层 ──────────────────────────────────────────────────────────

interface RecordDetailModalProps {
  item: RecordItem
  onClose: () => void
}

function RecordDetailModal({ item, onClose }: RecordDetailModalProps): ReactElement {
  return (
    <Modal title={`运行详情：${STAGE_LABEL[item.category] ?? item.category}`} visible width="80%" onCancel={onClose} maskClosable={false}
      footer={<Button theme="borderless" onClick={onClose}>关闭</Button>}
    >
      <div className={classes.form}>
        <div className={classes.formField}><label>需求</label><Typography.Text>{item.requirementTitle ?? item.requirementId}</Typography.Text></div>
        <div className={classes.formField}><label>阶段</label><Typography.Text>{STAGE_LABEL[item.category] ?? item.category}</Typography.Text></div>
        <div className={classes.formField}><label>状态</label><Tag size="small" color={recordStatusColor(item.status)}>{RECORD_STATUS_LABEL[item.status]}</Tag></div>
        <div className={classes.formField}>
          <label>结果</label>
          <Typography.Text style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.result ?? '—'}</Typography.Text>
        </div>
        {item.artifacts.length > 0 && (
          <div className={classes.formField}><label>产物</label><div className={classes.tagList}>{item.artifacts.map((a, i) => <Tag key={i} size="small">{a}</Tag>)}</div></div>
        )}
        {item.skills.length > 0 && (
          <div className={classes.formField}><label>技能</label><div className={classes.tagList}>{item.skills.map((s, i) => <Tag key={i} size="small">{s}</Tag>)}</div></div>
        )}
        <div className={classes.formField}><label>创建时间</label><Typography.Text type="tertiary" size="small">{item.createdAt}</Typography.Text></div>
        <div className={classes.formField}><label>更新时间</label><Typography.Text type="tertiary" size="small">{item.updatedAt}</Typography.Text></div>
      </div>
    </Modal>
  )
}
