import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SKILLS_SOURCE,
  SkillSource,
  normalizeSkillsSource,
  readSkillMd,
} from '../src/skills-source.ts'

describe('normalizeSkillsSource', () => {
  it('defaults to builtin when absent or unknown', () => {
    expect(normalizeSkillsSource(undefined)).toEqual(DEFAULT_SKILLS_SOURCE)
    expect(normalizeSkillsSource(null)).toEqual(DEFAULT_SKILLS_SOURCE)
    expect(normalizeSkillsSource({ kind: 'weird' })).toEqual(DEFAULT_SKILLS_SOURCE)
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
      const source = new SkillSource({ kind: 'dir', path: dir }, '/nonexistent-builtin')
      expect(source.list()).toEqual(['facai-plan'])
      expect(readSkillMd(source, 'facai-plan')).toContain('plan skill')
      expect(source.skillDir('facai-plan')).toBe(join(dir, 'facai-plan'))
      expect(source.skillDir('missing')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the builtin assets root', () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-builtin-'))
    try {
      mkdirSync(join(root, 'facai-coding'), { recursive: true })
      writeFileSync(join(root, 'facai-coding', 'SKILL.md'), '# builtin coding', 'utf8')
      const source = new SkillSource({ kind: 'builtin' }, root)
      expect(readSkillMd(source, 'facai-coding')).toContain('builtin coding')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
