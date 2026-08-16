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
/** Worker row config: an optional external skills source (dir | git). */
export type SkillsSourceConfig = {
    kind: 'dir';
    path: string;
} | {
    kind: 'git';
    url: string;
    ref?: string;
};
/** No source configured — the pipeline reads only the project's own skills. */
export declare const NO_SKILLS_SOURCE: undefined;
/** Validate a raw row config value; absent/unknown kinds mean "no external source". */
export declare function normalizeSkillsSource(input: unknown): SkillsSourceConfig | undefined;
/**
 * Resolve one skill directory (the dir whose `SKILL.md` is the skill body)
 * from the configured external source. Returns undefined when no source is
 * configured or the source does not provide the skill.
 */
export declare class SkillSource {
    private readonly config;
    constructor(config: SkillsSourceConfig | undefined);
    /** All skill names this source provides (empty with no source). */
    list(): string[];
    /** The directory holding `<skill>/SKILL.md`, or undefined. */
    skillDir(skill: string): string | undefined;
    private root;
    /** Clone (once per url+ref, cached) and return the checkout dir. */
    private gitRoot;
}
/** The skill set's SKILL.md bodies by skill name (for tests / tooling). */
export declare function readSkillMd(source: SkillSource, skill: string): string | undefined;
