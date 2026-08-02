import { copyFileSync, existsSync, readFileSync } from 'node:fs';

export const BLOCK_START = '<!-- CW:START -->';
export const BLOCK_END = '<!-- CW:END -->';

/**
 * Insert or replace the managed block in a CLAUDE.md. Everything outside the
 * markers belongs to the project and is never touched.
 */
export function mergeClaudeMd(existing: string | undefined, block: string): string {
  const managed = `${BLOCK_START}\n<!-- Managed by claude-workflow-kit. Edits inside this block are overwritten on update. -->\n\n${block.trim()}\n\n${BLOCK_END}`;

  if (!existing || existing.trim() === '') {
    return `# Project AI Engineering Rules\n\n${managed}\n`;
  }

  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + managed + existing.slice(end + BLOCK_END.length);
  }
  return `${existing.replace(/\s*$/, '')}\n\n${managed}\n`;
}

export function stripClaudeMdBlock(existing: string): string {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return existing;
  const out = existing.slice(0, start) + existing.slice(end + BLOCK_END.length);
  return `${out.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`;
}

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

type HookMap = Record<string, HookMatcher[]>;

export interface SettingsLike {
  hooks?: HookMap;
  [key: string]: unknown;
}

export function isKitHookCommand(command: string | undefined): boolean {
  return Boolean(command && command.includes('cw-hook.mjs'));
}

/**
 * Merge the kit's hooks into existing settings without disturbing anything the
 * user configured. Kit entries are matched by their command, so a rerun
 * replaces rather than duplicates them.
 */
export function mergeSettings(existing: SettingsLike | undefined, template: SettingsLike): SettingsLike {
  const out: SettingsLike = { ...(existing ?? {}) };
  const currentHooks: HookMap = { ...((existing?.hooks as HookMap) ?? {}) };

  for (const [event, templateMatchers] of Object.entries(template.hooks ?? {})) {
    const kept = (currentHooks[event] ?? [])
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((h) => !isKitHookCommand(h.command)),
      }))
      .filter((entry) => (entry.hooks ?? []).length > 0);

    currentHooks[event] = [...kept, ...templateMatchers];
  }

  out.hooks = currentHooks;
  return out;
}

/** Remove every kit hook, and drop hook events that end up empty. */
export function removeKitHooks(existing: SettingsLike | undefined): SettingsLike {
  if (!existing) return {};
  const out: SettingsLike = { ...existing };
  const hooks: HookMap = {};
  for (const [event, matchers] of Object.entries((existing.hooks as HookMap) ?? {})) {
    const kept = matchers
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((h) => !isKitHookCommand(h.command)),
      }))
      .filter((entry) => (entry.hooks ?? []).length > 0);
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

/** Keep one backup per file so a bad merge is always recoverable. */
export function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const target = `${file}.cw-backup`;
  copyFileSync(file, target);
  return target;
}

export function readJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
