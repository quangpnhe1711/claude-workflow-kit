/**
 * Tool calls -> normalised observability events.
 *
 * The policy already reads every tool call to decide whether it may proceed; this
 * turns the same payload into a fact worth keeping ("PermissionService.ts was
 * read", "npm ran"). What it deliberately does NOT keep is the payload itself.
 *
 * The redaction rule is inverted from the usual one: nothing is persisted unless
 * this module can normalise it into a known shape. A path becomes a
 * project-relative path or nothing; a command becomes one program name or
 * nothing. Arguments, file contents, stdin, environment and full command lines
 * never reach disk, so a credential in an argument cannot leak into a run's
 * event log by accident.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { argvOf, commandSegments, isCommandTool, isFileWriteTool, programName, targetPaths } from './policy.js';
import type { EventType, KitConfig } from './types.js';

/** One fact worth recording. `data` is already redacted and safe to persist. */
export interface Observation {
  type: EventType;
  data: Record<string, string>;
}

export type TelemetryConfig = Pick<
  KitConfig,
  'mutationTools' | 'mutationToolPatterns' | 'commandTools' | 'testCommands'
>;

/** Tools that read files. Reading is the other half of "what did it look at?". */
const READ_TOOLS = ['read', 'notebookread', 'view', 'cat'];

/** A path outside the project is recorded as a category, never as a path. */
export const OUTSIDE_PROJECT = '<outside-project>';

/** A program name we cannot vouch for is recorded as a category, never verbatim. */
export const UNKNOWN_PROGRAM = '<unrecognised>';

const SAFE_PROGRAM = /^[a-z0-9][a-z0-9._+-]{0,39}$/;

/**
 * Project-relative, slash-normalised, or a category. Absolute paths outside the
 * project are private information (home directories carry user names), so they
 * are counted without being named.
 */
export function safePath(rawPath: string, projectRoot: string): string | undefined {
  const text = rawPath.trim();
  if (!text || text.length > 400) return undefined;
  const absolute = isAbsolute(text) ? resolve(text) : resolve(projectRoot, text);
  const root = resolve(projectRoot);
  if (absolute !== root && !absolute.startsWith(root + sep)) return OUTSIDE_PROJECT;
  const rel = relative(root, absolute).split(sep).join('/');
  return rel || '.';
}

/** argv[0] of each segment, reduced to a bare program name we can vouch for. */
export function safePrograms(command: string): string[] {
  const out: string[] = [];
  for (const segment of commandSegments(command)) {
    const argv = argvOf(segment);
    if (!argv.length) continue;
    const program = programName(argv[0]!).toLowerCase();
    out.push(SAFE_PROGRAM.test(program) ? program : UNKNOWN_PROGRAM);
  }
  return out;
}

function isTestProgram(program: string, config: TelemetryConfig): boolean {
  return config.testCommands.some((t) => t.toLowerCase() === program);
}

function commandOf(toolInput: Record<string, unknown> | undefined): string | undefined {
  const value = toolInput?.['command'] ?? toolInput?.['cmd'] ?? toolInput?.['script'];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export interface TelemetryInput {
  /** TOOL_START, TOOL_END or TOOL_FAIL — the lifecycle point being reported. */
  phase: 'start' | 'end' | 'fail';
  toolName: string | undefined;
  toolInput: Record<string, unknown> | undefined;
  projectRoot: string;
  config: TelemetryConfig;
}

/**
 * What this tool call did, as events. Returns nothing for a tool we cannot
 * classify — an unknown tool is not a reason to persist its raw arguments.
 */
export function observe(input: TelemetryInput): Observation[] {
  const { phase, toolName, toolInput, projectRoot, config } = input;
  if (!toolName) return [];
  const out: Observation[] = [];

  if (isCommandTool(toolName, config)) {
    const command = commandOf(toolInput);
    if (!command) return [];
    // One command line can chain several programs; each is a fact of its own.
    const programs = [...new Set(safePrograms(command))];
    for (const program of programs) {
      const test = isTestProgram(program, config);
      const type: EventType =
        phase === 'start'
          ? test
            ? 'TEST_STARTED'
            : 'COMMAND_STARTED'
          : phase === 'fail'
            ? test
              ? 'TEST_FAILED'
              : 'COMMAND_FAILED'
            : test
              ? 'TEST_PASSED'
              : 'COMMAND_COMPLETED';
      out.push({ type, data: { executable: program } });
    }
    return out;
  }

  // A write is worth recording once, when it actually happened. Recording it on
  // PreToolUse would count writes that the gate then denied.
  const write = isFileWriteTool(toolName, config);
  const read = READ_TOOLS.includes(toolName.toLowerCase());
  if (!write && !read) return [];
  if (phase !== 'end') return [];

  for (const raw of new Set(targetPaths(toolInput))) {
    const path = safePath(raw, projectRoot);
    if (!path) continue;
    out.push({ type: write ? 'FILE_CHANGED' : 'FILE_READ', data: { path } });
  }
  return out;
}
