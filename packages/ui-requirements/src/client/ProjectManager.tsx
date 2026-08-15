import { useCallback, useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Select from '@douyinfe/semi-ui/lib/es/select'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import { projects, type Project } from './remote.ts'

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

interface Props {
  visible: boolean
  busy: boolean
  onClose: () => void
  onChanged: () => void
}

/** 项目管理：项目列表 + 新建项目（name/localPath/gitUrl/platform/prToken）。 */
export function ProjectManager({ visible, busy, onClose, onChanged }: Props): ReactElement {
  const [list, setList] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [platform, setPlatform] = useState<'gitee' | 'gitea'>('gitee')
  const [prToken, setPrToken] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setList(await projects.list())
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (visible) void refresh() }, [visible, refresh])

  const submit = useCallback(async () => {
    if (busy) return
    setError(null)
    try {
      await projects.create({
        name: name.trim(),
        localPath: localPath.trim(),
        gitUrl: gitUrl.trim(),
        platform,
        prToken: prToken.trim() === '' ? undefined : prToken.trim(),
      })
      setName('')
      setLocalPath('')
      setGitUrl('')
      setPrToken('')
      await refresh()
      onChanged()
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [busy, name, localPath, gitUrl, platform, prToken, refresh, onChanged])

  return (
    <Modal
      title="项目管理"
      visible={visible}
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <Button theme="borderless" disabled={busy} onClick={onClose}>关闭</Button>
      )}
    >
      {error !== null && <Typography.Text type="danger" size="small">{error}</Typography.Text>}
      {loading
        ? <div className={classes.center}><Typography.Text type="tertiary">加载中…</Typography.Text></div>
        : (
          <div className={classes.projectList}>
            {list.map(project => (
              <div key={project.id} className={classes.projectRow}>
                <div>
                  <div className={classes.projectRowName}>{project.name}</div>
                  <div className={classes.projectRowPath}>{project.localPath}</div>
                </div>
                <Tag size="small" color={project.platform === 'gitee' ? 'red' : 'blue'}>{project.platform}</Tag>
                <Tag size="small" color={project.hasToken ? 'green' : 'grey'}>{project.hasToken ? '已配 token' : '无 token'}</Tag>
              </div>
            ))}
          </div>
        )}
      <div className={classes.form}>
        <div className={classes.formField}>
          <label>名称</label>
          <Input value={name} onChange={(value) => { setName(value) }} placeholder="如 fac-ai-rs" />
        </div>
        <div className={classes.formField}>
          <label>本地路径</label>
          <Input value={localPath} onChange={(value) => { setLocalPath(value) }} placeholder="/root/workspace/rust/fac-ai-rs" />
        </div>
        <div className={classes.formField}>
          <label>Git 链接</label>
          <Input value={gitUrl} onChange={(value) => { setGitUrl(value) }} placeholder="git@gitee.com:owner/repo.git" />
        </div>
        <div className={classes.formField}>
          <label>平台</label>
          <Select
            className={classes.projectSelect}
            value={platform}
            onChange={(value) => { setPlatform(value as 'gitee' | 'gitea') }}
            optionList={[
              { value: 'gitee', label: 'Gitee' },
              { value: 'gitea', label: 'Gitea' },
            ]}
          />
        </div>
        <div className={classes.formField}>
          <label>PR Token（可选，建 PR 用）</label>
          <Input value={prToken} onChange={(value) => { setPrToken(value) }} placeholder="个人访问令牌" type="password" />
        </div>
        <Button theme="solid" disabled={name.trim() === '' || localPath.trim() === '' || gitUrl.trim() === '' || busy} onClick={() => { void submit() }}>
          新建项目
        </Button>
      </div>
    </Modal>
  )
}
