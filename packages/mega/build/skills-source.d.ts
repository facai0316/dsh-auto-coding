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
/** Worker row config: which skills source to use. */
export type SkillsSourceConfig = {
    kind: 'builtin';
} | {
    kind: 'dir';
    path: string;
} | {
    kind: 'git';
    url: string;
    ref?: string;
};
export declare const DEFAULT_SKILLS_SOURCE: SkillsSourceConfig;
/** Validate a raw row config value; unknown/invalid kinds fall back to builtin. */
export declare function normalizeSkillsSource(input: unknown): SkillsSourceConfig;
/**
 * Resolve one skill directory (the dir whose `SKILL.md` is the skill body)
 * from the configured source. Returns undefined when the source does not
 * provide the skill. `builtinRoot` is the absolute path of the package's
 * `assets/skills/` (the caller derives it from `import.meta.url` so the
 * location survives bundling).
 */
export declare class SkillSource {
    private readonly config;
    private readonly builtinRoot;
    constructor(config: SkillsSourceConfig, builtinRoot: string);
    /** All skill names this source provides. */
    list(): string[];
    /** The directory holding `<skill>/SKILL.md`, or undefined. */
    skillDir(skill: string): string | undefined;
    private rootSync;
    /** Clone (once per url+ref, cached) and return the checkout dir. */
    private gitRootSync;
}
/** The skill set's SKILL.md bodies by skill name (for tests / tooling). */
export declare function readSkillMd(source: SkillSource, skill: string): string | undefined;
