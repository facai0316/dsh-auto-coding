/**
 * Skills source resolution for the coding-pipeline worker (plan 10, decision 4
 * / P3): where the facai skills come from when a project has not run
 * `facai-init`. Decorator-free so vitest/esbuild can exercise it directly.
 *
 *  - `builtin` — the mega package's own `assets/skills/` (bundled fallback);
 *  - `dir` — an absolute directory laid out as `<dir>/<skill>/SKILL.md`;
 *  - `git` — a git repo cloned on demand into a content-addressed cache dir
 *    (`<tmp>/auto-coding-skills/<hash-of-url+ref>`), laid out the same way.
 *
 * The worker copies the resolved skill set into each task worktree's
 * `.agents/skills/` (missing skills only), so a fresh project is usable
 * without `facai-init`.
 *
 * @module @auto-coding/mega/skills-source
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export const DEFAULT_SKILLS_SOURCE = { kind: 'builtin' };
/** Validate a raw row config value; unknown/invalid kinds fall back to builtin. */
export function normalizeSkillsSource(input) {
    if (input === undefined || input === null || typeof input !== 'object')
        return DEFAULT_SKILLS_SOURCE;
    const raw = input;
    if (raw.kind === 'dir') {
        if (typeof raw.path !== 'string' || raw.path === '') {
            throw new Error('skillsSource kind=dir 需要非空 path');
        }
        return { kind: 'dir', path: raw.path };
    }
    if (raw.kind === 'git') {
        if (typeof raw.url !== 'string' || raw.url === '') {
            throw new Error('skillsSource kind=git 需要非空 url');
        }
        return {
            kind: 'git',
            url: raw.url,
            ref: typeof raw.ref === 'string' && raw.ref !== '' ? raw.ref : undefined,
        };
    }
    return DEFAULT_SKILLS_SOURCE;
}
/**
 * Resolve one skill directory (the dir whose `SKILL.md` is the skill body)
 * from the configured source. Returns undefined when the source does not
 * provide the skill. `builtinRoot` is the absolute path of the package's
 * `assets/skills/` (the caller derives it from `import.meta.url` so the
 * location survives bundling).
 */
export class SkillSource {
    config;
    builtinRoot;
    constructor(config, builtinRoot) {
        this.config = config;
        this.builtinRoot = builtinRoot;
    }
    /** All skill names this source provides. */
    list() {
        const root = this.rootSync();
        if (root === undefined)
            return [];
        try {
            return readdirSync(root).filter(name => {
                try {
                    return existsSync(join(root, name, 'SKILL.md'));
                }
                catch {
                    return false;
                }
            });
        }
        catch {
            return [];
        }
    }
    /** The directory holding `<skill>/SKILL.md`, or undefined. */
    skillDir(skill) {
        const root = this.rootSync();
        if (root === undefined)
            return undefined;
        const dir = join(root, skill);
        try {
            return existsSync(join(dir, 'SKILL.md')) ? dir : undefined;
        }
        catch {
            return undefined;
        }
    }
    rootSync() {
        switch (this.config.kind) {
            case 'builtin':
                return existsSync(this.builtinRoot) ? this.builtinRoot : undefined;
            case 'dir':
                return existsSync(this.config.path) ? this.config.path : undefined;
            case 'git':
                return this.gitRootSync();
        }
    }
    /** Clone (once per url+ref, cached) and return the checkout dir. */
    gitRootSync() {
        if (this.config.kind !== 'git')
            return undefined;
        const key = createHash('sha1').update(`${this.config.url}#${this.config.ref ?? 'HEAD'}`).digest('hex').slice(0, 12);
        const cache = join(tmpdir(), 'auto-coding-skills', key);
        if (existsSync(join(cache, '.git')))
            return cache;
        try {
            mkdirSync(cache, { recursive: true });
            const args = ['clone', '--depth', '1'];
            if (this.config.ref !== undefined)
                args.push('--branch', this.config.ref);
            args.push(this.config.url, cache);
            execFileSync('git', args, { stdio: 'ignore' });
            return cache;
        }
        catch {
            // Clone failed (offline / bad url): treat as absent; the stage then
            // fails with the usual「技能不存在」message instead of crashing.
            return undefined;
        }
    }
}
/** The skill set's SKILL.md bodies by skill name (for tests / tooling). */
export function readSkillMd(source, skill) {
    const dir = source.skillDir(skill);
    if (dir === undefined)
        return undefined;
    try {
        return readFileSync(join(dir, 'SKILL.md'), 'utf8');
    }
    catch {
        return undefined;
    }
}
