import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SkillSource,
  normalizeSkillsSource,
  readSkillMd,
} from '../src/skills-source.ts'

describe('normalizeSkillsSource', () => {
  it('means "no external source" when absent or unknown (plugin ships no skills)', () => {
    expect(normalizeSkillsSource(undefined)).toBeUndefined()
    expect(normalizeSkillsSource(null)).toBeUndefined()
    expect(normalizeSkillsSource({ kind: 'weird' })).toBeUndefined()
    // 旧配置里的 builtin 也被当作「无外部源」，退化为只读项目自身技能。
    expect(normalizeSkillsSource({ kind: 'builtin' })).toBeUndefined()
  })

  it('accepts dir with a path', () => {
    expect(normalizeSkillsSource({ kind: 'dir', path: '/x' })).toEqual({ kind: 'dir', path: '/x' })
  })

  it('rejects dir without a path', () => {
    expect(() => normalizeSkillsSource({ kind: 'dir' })).toThrow('path')
  })

  it('accepts git with url and optional ref', () => {
    expect(normalizeSkillsSource({ kind: 'git', url: 'git@x:y.git', ref: 'v1' }))
      .toEqual({ kind: 'git', url: 'git@x:y.git', ref: 'v1' })
    expect(normalizeSkillsSource({ kind: 'git', url: 'git@x:y.git' }))
      .toEqual({ kind: 'git', url: 'git@x:y.git' })
  })
})

describe('SkillSource', () => {
  it('lists and reads skills from a dir source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-src-'))
    try {
      mkdirSync(join(dir, 'facai-plan'), { recursive: true })
      writeFileSync(join(dir, 'facai-plan', 'SKILL.md'), '# plan skill\nbody', 'utf8')
      const source = new SkillSource({ kind: 'dir', path: dir })
      expect(source.list()).toEqual(['facai-plan'])
      expect(readSkillMd(source, 'facai-plan')).toContain('plan skill')
      expect(source.skillDir('facai-plan')).toBe(join(dir, 'facai-plan'))
      expect(source.skillDir('missing')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('provides nothing with no source (project-only read)', () => {
    const source = new SkillSource(undefined)
    expect(source.list()).toEqual([])
    expect(source.skillDir('facai-coding')).toBeUndefined()
    expect(readSkillMd(source, 'facai-coding')).toBeUndefined()
  })
})
