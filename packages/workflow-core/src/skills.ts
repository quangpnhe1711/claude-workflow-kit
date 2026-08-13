/**
 * Installed skills, read from the project's own `.claude/skills`.
 *
 * The kit has no skill registry: a skill is a directory with a `SKILL.md`, and
 * its frontmatter is the only description that exists. The guide in the monitor
 * therefore reads the same files Claude Code reads — documentation that cannot
 * drift from what is installed, because it *is* what is installed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillDoc {
  name: string;
  /** Absolute path of the SKILL.md this was read from. */
  file: string;
  description?: string;
  /** What the skill expects after the slash command, as the author wrote it. */
  argumentHint?: string;
  effort?: string;
  /**
   * A skill the *user* invokes as `/name`. The preset marks these
   * `disable-model-invocation: true` — Claude may not call them on its own, so
   * they are exactly the entry points a human types.
   */
  entry: boolean;
  /** Markdown after the frontmatter. Empty in list responses. */
  body: string;
  /** `## ` headings, in order: the outline of what the skill does. */
  outline: string[];
  bytes: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkill(name: string, file: string, text: string): SkillDoc {
  const match = FRONTMATTER.exec(text);
  const body = match ? text.slice(match[0].length) : text;
  let meta: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1]!) as unknown;
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      // A skill with unreadable frontmatter is still a skill; it just has no
      // description. Refusing to list it would hide an installed capability.
    }
  }

  const str = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };

  const doc: SkillDoc = {
    name: str('name') ?? name,
    file,
    entry: meta['disable-model-invocation'] === true,
    body,
    outline: [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim()),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
  const description = str('description');
  if (description) doc.description = description;
  const hint = str('argument-hint');
  if (hint) doc.argumentHint = hint;
  const effort = str('effort');
  if (effort) doc.effort = effort;
  return doc;
}

export function skillsDir(projectRoot: string): string {
  return join(projectRoot, '.claude', 'skills');
}

/** Every installed skill. `withBody: false` keeps the list payload small. */
export function listSkills(projectRoot: string, opts: { withBody?: boolean } = {}): SkillDoc[] {
  const dir = skillsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const docs: SkillDoc[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    try {
      if (!statSync(file).isFile()) continue;
      const doc = parseSkill(entry.name, file, readFileSync(file, 'utf8'));
      docs.push(opts.withBody ? doc : { ...doc, body: '' });
    } catch {
      // An unreadable skill directory is skipped, not fatal.
    }
  }
  return docs.sort((a, b) => Number(b.entry) - Number(a.entry) || a.name.localeCompare(b.name));
}

export function readSkill(projectRoot: string, name: string): SkillDoc | undefined {
  // The name comes from a URL, so it must not be able to walk out of the dir.
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return undefined;
  const file = join(skillsDir(projectRoot), name, 'SKILL.md');
  if (!existsSync(file)) return undefined;
  try {
    return parseSkill(name, file, readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
