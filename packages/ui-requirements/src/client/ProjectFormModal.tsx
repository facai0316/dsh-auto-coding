import { useEffect, useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Input from '@douyinfe/semi-ui/lib/es/input'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Select from '@douyinfe/semi-ui/lib/es/select'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import type { Project } from './remote.ts'

export interface ProjectInput {
  name: string
  localPath: string
  gitUrl: string
  platform: 'gitee' | 'gitea'
  prToken?: string
}

interface Props {
  visible: boolean
  /** 传入则进入编辑模式（预填字段），否则为新建。 */
  initial?: Project | null
  busy: boolean
  onClose: () => void
  onSubmit: (input: ProjectInput) => Promise<void>
}

/**
 * 项目表单（新建 / 编辑复用）：name / localPath / gitUrl / platform / prToken。
 * 编辑模式 prToken 留空表示不修改（undefined 透传，host 保持原值）。
 */
export function ProjectFormModal({ visible, initial = null, busy, onClose, onSubmit }: Props): ReactElement {
  const [name, setName] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [platform, setPlatform] = useState<'gitee' | 'gitea'>('gitee')
  const [prToken, setPrToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    setError(null)
    if (initial !== null && initial !== undefined) {
      setName(initial.name)
      setLocalPath(initial.localPath)
      setGitUrl(initial.gitUrl)
      setPlatform(initial.platform)
      setPrToken('')
    } else {
      setName('')
      setLocalPath('')
      setGitUrl('')
      setPlatform('gitee')
      setPrToken('')
    }
  }, [visible, initial])

  const submit = async (): Promise<void> => {
    setError(null)
    try {
      await onSubmit({
        name: name.trim(),
        localPath: localPath.trim(),
        gitUrl: gitUrl.trim(),
        platform,
        // 编辑模式留空 → 不传 prToken（保持原值）；新建模式留空 → 不配置
        prToken: prToken.trim() === '' ? undefined : prToken.trim(),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Modal
      title={initial === null || initial === undefined ? '新增项目' : `编辑项目：${initial.name}`}
      visible={visible}
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <>
          <Button theme="borderless" disabled={busy} onClick={onClose}>取消</Button>
          <Button
            theme="solid"
            disabled={name.trim() === '' || localPath.trim() === '' || gitUrl.trim() === '' || busy}
            onClick={() => { void submit() }}
          >
            {initial === null || initial === undefined ? '创建' : '保存'}
          </Button>
        </>
      )}
    >
      {error !== null && <Typography.Text type="danger" size="small">{error}</Typography.Text>}
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
          <label>PR Token{initial !== null && initial !== undefined ? '（留空保持不变）' : ''}</label>
          <Input value={prToken} onChange={(value) => { setPrToken(value) }} placeholder="个人访问令牌" type="password" />
        </div>
      </div>
    </Modal>
  )
}
