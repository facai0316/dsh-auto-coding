/**
 * Skills source resolution for the coding-pipeline worker (plan 10, decision 4
 * / P3, revised 2026-08-16): where the facai skills come from when a project
 * has not run `facai-init`.
 *
 * The plugin does NOT bundle any skills — the facai skills are project- and
 * org-specific (they encode fac-ai-rs rules and workflows), so shipping them
 * in the plugin would be wrong for every other project. The pipeline always
 * reads the project's own `.agents/skills/<skill>/SKILL.md` first; a
 * configured external source (`dir` | `git`) is an optional fallback for
 * teams that keep a shared skills repo:
 *
 *  - `dir` — an absolute directory laid out as `<dir>/<skill>/SKILL.md`;
 *  - `git` — a git repo cloned on demand into a content-addressed cache dir
 *    (`<tmp>/auto-coding-skills/<hash-of-url+ref>`), laid out the same way.
 *
 * With no `skillsSource` configured, missing skills fail loudly with a
 * message telling the user to put the skills in the project (run
 * `/facai-init` from the coding-pipline-skills repo, see the README).
 *
 * Decorator-free so vitest/esbuild can exercise it directly.
 *
 * @module @auto-coding/mega/skills-source
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
/** No source configured — the pipeline reads only the project's own skills. */
export const NO_SKILLS_SOURCE = undefined;
/** Validate a raw row config value; absent/unknown kinds mean "no external source". */
export function normalizeSkillsSource(input) {
    if (input === undefined || input === null || typeof input !== 'object')
        return undefined;
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
    // 'builtin' was removed deliberately (the plugin ships no skills); treat it
    // like "no source" so old configs degrade to the project-only read.
    return undefined;
}
/**
 * Resolve one skill directory (the dir whose `SKILL.md` is the skill body)
 * from the configured external source. Returns undefined when no source is
 * configured or the source does not provide the skill.
 */
export class SkillSource {
    config;
    constructor(config) {
        this.config = config;
    }
    /** All skill names this source provides (empty with no source). */
    list() {
        const root = this.root();
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
        const root = this.root();
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
    root() {
        switch (this.config?.kind) {
            case 'dir':
                return existsSync(this.config.path) ? this.config.path : undefined;
            case 'git':
                return this.gitRoot();
            default:
                return undefined;
        }
    }
    /** Clone (once per url+ref, cached) and return the checkout dir. */
    gitRoot() {
        if (this.config?.kind !== 'git')
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
