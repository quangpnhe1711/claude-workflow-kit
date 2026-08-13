/**
 * Token usage, read from Claude Code's own session transcript.
 *
 * The kit never sees the model call, so usage cannot be measured from inside a
 * hook. Claude Code writes one JSONL line per assistant message under
 * `~/.claude/projects/<project-slug>/<sessionId>.jsonl`, and each carries
 * `message.usage` and `message.model`. A run already records the session that
 * owns it, so the join is exact.
 *
 * What this reads: four integers, a model id and a timestamp per message.
 * What it deliberately never touches: `message.content`. Prompts and replies
 * stay where Claude Code put them; the kit copies numbers, not conversations.
 *
 * This is best-effort by contract. A different Claude Code version, a missing
 * transcript or a session that ran elsewhere all produce "unavailable", which
 * the UI renders as N/A — never as zero.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { KitConfig } from './types.js';

export interface SessionUsage {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Models seen in the window, in first-seen order. */
  models: string[];
  messages: number;
  /** Timestamp of the last message counted — the idempotency marker. */
  through?: string;
  estimatedCost: number | null;
}

/** Per-million-token prices. Absent model = no cost, never a guessed one. */
export type ModelPricing = NonNullable<KitConfig['pricing']>;

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Compare paths the way the slug does: ignore separators and case. */
function fold(text: string): string {
  return text.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Claude Code derives the directory name from the working directory, and the
 * exact transformation has changed between versions, so match on a folded
 * comparison instead of reproducing it.
 */
export function transcriptDirFor(projectRoot: string): string | undefined {
  const root = projectsRoot();
  if (!existsSync(root)) return undefined;
  const wanted = fold(resolve(projectRoot));
  let best: string | undefined;
  for (const name of readdirSync(root)) {
    const folded = fold(name);
    if (folded === wanted) return join(root, name);
    // A slug that folds to a suffix of the path (drive letter dropped, or a
    // nested cwd) is a candidate, but an exact match always wins.
    if (!best && (wanted.endsWith(folded) || folded.endsWith(wanted))) best = join(root, name);
  }
  return best;
}

export function transcriptFileFor(projectRoot: string, sessionId: string): string | undefined {
  const direct = transcriptDirFor(projectRoot);
  if (direct) {
    const file = join(direct, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  // A session can be recorded under a different project directory (the user
  // started Claude Code from a subdirectory). Fall back to a scan.
  const root = projectsRoot();
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root)) {
    const file = join(root, name, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

function pick(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function costOf(usage: Omit<SessionUsage, 'estimatedCost'>, pricing: ModelPricing | undefined): number | null {
  if (!pricing) return null;
  // Cost needs a price for every model that produced these tokens; pricing one
  // of three models would produce a number that looks complete and is not.
  const rates = usage.models.map((model) => pricing[model]);
  if (!usage.models.length || rates.some((rate) => !rate)) return null;
  const rate = rates[0]!;
  const perMillion = (tokens: number, price: number | undefined) => (tokens / 1_000_000) * (price ?? 0);
  return (
    perMillion(usage.inputTokens, rate.inputPer1M) +
    perMillion(usage.outputTokens, rate.outputPer1M) +
    perMillion(usage.cacheReadTokens, rate.cacheReadPer1M) +
    perMillion(usage.cacheWriteTokens, rate.cacheWritePer1M)
  );
}

export interface UsageWindow {
  /** Count messages at or after this ISO timestamp. */
  from?: string;
  /** Count messages at or before this ISO timestamp. */
  to?: string;
}

/** Fold one transcript file. Returns undefined when there is nothing to read. */
export function readSessionUsage(
  file: string,
  sessionId: string,
  window: UsageWindow = {},
  pricing?: ModelPricing,
): SessionUsage | undefined {
  let text: string;
  try {
    if (!statSync(file).isFile()) return undefined;
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }

  const usage: Omit<SessionUsage, 'estimatedCost'> = {
    sessionId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    models: [],
    messages: 0,
  };

  for (const line of text.split('\n')) {
    if (!line || !line.includes('"usage"')) continue;
    let entry: { timestamp?: string; message?: { model?: string; usage?: Record<string, unknown> } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const raw = entry.message?.usage;
    if (!raw) continue;
    const at = entry.timestamp;
    if (window.from && at && at < window.from) continue;
    if (window.to && at && at > window.to) continue;

    usage.inputTokens += pick(raw['input_tokens']);
    usage.outputTokens += pick(raw['output_tokens']);
    usage.cacheReadTokens += pick(raw['cache_read_input_tokens']);
    usage.cacheWriteTokens += pick(raw['cache_creation_input_tokens']);
    usage.messages += 1;
    const model = entry.message?.model;
    if (typeof model === 'string' && model && !usage.models.includes(model)) usage.models.push(model);
    if (at && (!usage.through || at > usage.through)) usage.through = at;
  }

  if (!usage.messages) return undefined;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { ...usage, estimatedCost: costOf(usage, pricing) };
}

/** Usage for one run's owning session, restricted to the run's own window. */
export function readRunUsage(
  projectRoot: string,
  sessionId: string,
  window: UsageWindow,
  pricing?: ModelPricing,
): SessionUsage | undefined {
  const file = transcriptFileFor(projectRoot, sessionId);
  if (!file) return undefined;
  return readSessionUsage(file, sessionId, window, pricing);
}
