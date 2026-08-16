import { useState, type ReactElement } from 'react'
import Button from '@douyinfe/semi-ui/lib/es/button'
import Modal from '@douyinfe/semi-ui/lib/es/modal'
import Tag from '@douyinfe/semi-ui/lib/es/tag'
import Typography from '@douyinfe/semi-ui/lib/es/typography'
import classes from './RequirementsPanel.module.css'
import type { Project } from './remote.ts'

interface Props {
  project: Project
  busy: boolean
  onEdit: () => void
  onRemove: () => void
}

/**
 * 项目卡片：名称 / 平台 / token 状态 / git 链接，操作区 详情 / 编辑 / 删除。
 */
export function ProjectCard({ project, busy, onEdit, onRemove }: Props): ReactElement {
  const [detailVisible, setDetailVisible] = useState(false)

  return (
    <div className={classes.card}>
      <div className={classes.cardHead}>
        <Typography.Text className={classes.cardTitle} strong ellipsis type="primary">
          {project.name}
        </Typography.Text>
        <Tag size="small" color={project.platform === 'gitee' ? 'red' : 'blue'}>{project.platform}</Tag>
      </div>

      <div className={classes.metaRows}>
        <div className={classes.metaRow}>
          <span className={classes.metaLabel}>路径</span>
          <Typography.Text size="small" type="tertiary" ellipsis>{project.localPath}</Typography.Text>
        </div>
        <div className={classes.metaRow}>
          <span className={classes.metaLabel}>Git</span>
          <Typography.Text size="small" type="tertiary" ellipsis>{project.gitUrl}</Typography.Text>
        </div>
      </div>

      <Tag size="small" color={project.hasToken ? 'green' : 'grey'}>{project.hasToken ? '已配 token' : '无 token'}</Tag>

      <div className={classes.cardActions}>
        <Button size="small" theme="borderless" onClick={() => { setDetailVisible(true) }}>详情</Button>
        <Button size="small" theme="borderless" disabled={busy} onClick={onEdit}>编辑</Button>
        <Button size="small" theme="borderless" type="danger" disabled={busy} onClick={onRemove}>删除</Button>
      </div>

      <Modal
        title={`项目详情：${project.name}`}
        visible={detailVisible}
        width="80%"
        onCancel={() => { setDetailVisible(false) }}
        maskClosable={false}
        footer={<Button theme="borderless" onClick={() => { setDetailVisible(false) }}>关闭</Button>}
      >
        <div className={classes.form}>
          <div className={classes.formField}><label>名称</label><Typography.Text>{project.name}</Typography.Text></div>
          <div className={classes.formField}><label>本地路径</label><Typography.Text>{project.localPath}</Typography.Text></div>
          <div className={classes.formField}><label>Git 链接</label><Typography.Text>{project.gitUrl}</Typography.Text></div>
          <div className={classes.formField}><label>平台</label><Tag size="small" color={project.platform === 'gitee' ? 'red' : 'blue'}>{project.platform}</Tag></div>
          <div className={classes.formField}><label>PR Token</label><Tag size="small" color={project.hasToken ? 'green' : 'grey'}>{project.hasToken ? '已配置' : '未配置'}</Tag></div>
        </div>
      </Modal>
    </div>
  )
}
