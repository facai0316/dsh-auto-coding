# 05 · 决策通道（waiting_reply + ask_user_questions 续跑）

> 前置：02（questions remote）、04（编排 + 挂起钩子）。
> 目标：阶段会话产出问题后正确挂起；用户作答后，下一轮 tick 新开会话续跑。

## 1. 挂起（waitStage，04 已调用）

阶段会话 `structured.questions` 非空时：

```ts
private async waitStage(req, stage, questions): Promise<'waiting'> {
  await this.questionsRepo.insertMany(lastRecordId, questions)   // 逐条 status='pending'
  await this.requirementsRepo.updateRecord({ category: stage.category, requirementId: req.id, status: 'waiting_reply', result: 'awaiting user reply' })
  return 'waiting'
}
```

- worktree 与未提交改动**保留**，会话结束
- 无自动重试；只等用户作答

## 2. 作答（面板 → remote，02）

```
questions.answer({ questionId, answer })
  → update ask_user_questions set status='answered', answer=$2, answered_at=now()
```

面板问答弹层（07）逐题调此方法；一个 record 可多题，全部答完才算完。

## 3. 续跑（② resumeWaiting）

```ts
private async resumeWaiting(): Promise<void> {
  // 找所有 waiting_reply 且「无 pending 问题」的 record
  const rows = await this.pgmas.withClient(this.db, c => c.query(`
    select r.id as record_id, r.requirement_id, r.category, r.branch_id
    from records r
    where r.status = 'waiting_reply'
      and not exists (
        select 1 from ask_user_questions q
        where q.record_id = r.id and q.status = 'pending'
      )
    order by r.updated_at asc limit 10
  `))
  for (const row of rows.rows) await this.resumeRecord(row)
}
```

## 4. 续跑动作（resumeRecord）

1. 读该 record 的已答问题（`question + options + answer`），组装成 `用户答复` 上下文
2. 定位该 record 的 worktree（由 requirement/branch_id 重建 handle；现场仍在）
3. 置 record `status='running'`
4. **新开会话**重跑「同 category 阶段」，prompt 追加 `# 用户答复` 段落（见 00 §4.7 续跑模板）
5. 结果处理与 04 runStage 相同（成功推进下一阶段 / 再产出问题则再挂起 / 失败进重试）

> 续跑是「新开会话 + 产物/答复重建上下文」，不恢复旧会话内存（方案 D4）。

## 5. 边界

- 用户对同一 record 多题作答可分批；只有全部 pending 清空才续跑
- 用户在等待期可改已答（重新 answer 覆盖 `answer`/`answered_at`）——续跑读最新
- 若用户想放弃：面板「取消」→ `transition('cancelled')`，worker 收尾 worktree（03）

## 6. 实现步骤

1. 04 的 `waitStage` 落地（落 questions + record=waiting_reply）
2. `resumeWaiting` 查询 + `resumeRecord` 续跑（复用 runStage，prompt 追加答复段）
3. 真库集成测试：模拟问题 → 挂起 → answer 全部 → 下轮续跑

## 7. 验收

- 阶段产问题 → record waiting_reply + questions pending，无重试
- 全 answered → 下一轮 tick 新开会话续跑，答复注入 prompt
- 未全答不续跑；取消路径可走
