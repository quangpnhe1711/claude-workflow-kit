/**
 * Scoped-instruction freshness — deliberately small.
 *
 * Writing `.claude/instructions/<area>.instructions.md` stays a Claude job
 * (`/map-repo`). The only thing code owns is the question that skill cannot
 * answer honestly about itself: *is this still true?* That is a filesystem fact
 * — file present, evidence file still there, evidence changed since the last
 * refresh — so it is computed, not asserted.
 *
 * Areas are open. A repository has the areas it has: `database` and `api` in one,
 * `billing` and `reporting` in another. They are discovered from metadata.json
 * and from the files on disk, never from a fixed list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { RuntimePaths } from './store.js';

/** Suffix that marks a scoped instruction file. */
export const INSTRUCTION_SUFFIX = '.instructions.md';

/** Keys in metadata.json that describe the repository rather than an area. */
const NON_AREA_KEYS = new Set(['repo_shape', 'areas']);

/**
 * `last_refresh` is recorded at millisecond resolution while filesystem mtimes
 * are finer, so a file written moments before the refresh can read as newer.
 * One second of slack removes that false "stale" without hiding a real edit.
 */
const MTIME_SLACK_MS = 1000;
export type ConventionArea = string;

export type ConventionAreaStatus = 'OK' | 'MISSING' | 'STALE' | 'UNRECORDED' | 'INVALID';

/** Statuses a convention area's own metadata may claim. */
export const CONVENTION_STATUSES = ['OK', 'PARTIAL', 'STALE', 'UNKNOWN'] as const;

export interface ConventionAreaReport {
  area: ConventionArea;
  file: string;
  status: ConventionAreaStatus;
  /** Why the area is not OK, or how it was validated. */
  detail: string;
  lastRefresh?: string;
  /** Evidence files the cache was derived from, as recorded in metadata.json. */
  evidence: string[];
  /** Evidence files that no longer exist. */
  missingEvidence: string[];
  /** Evidence files modified after the recorded refresh. */
  changedEvidence: string[];
}

export interface ConventionReport {
  conventionsDir: string;
  metadataFile: string;
  metadataPresent: boolean;
  metadataReadable: boolean;
  repoShape?: unknown;
  areas: ConventionAreaReport[];
  /** Areas that need `/map-repo <area>`. */
  refreshNeeded: ConventionArea[];
}

interface AreaMetadata {
  status?: string;
  last_refresh?: string;
  evidence?: unknown;
  /** Set when an area genuinely has no file evidence (e.g. an empty area). */
  allow_no_evidence?: unknown;
}

/**
 * Metadata is written by a model, so it is checked rather than trusted: an
 * invented status, a malformed timestamp, an absolute or escaping evidence path,
 * or an "OK" with nothing behind it are all reported instead of believed.
 */
function validateAreaMetadata(meta: AreaMetadata, evidence: string[]): string | undefined {
  if (meta.status !== undefined) {
    if (typeof meta.status !== 'string' || !(CONVENTION_STATUSES as readonly string[]).includes(meta.status)) {
      return `status "${String(meta.status)}" is not one of ${CONVENTION_STATUSES.join(', ')}`;
    }
  }
  if (meta.last_refresh !== undefined) {
    if (typeof meta.last_refresh !== 'string' || Number.isNaN(Date.parse(meta.last_refresh))) {
      return `last_refresh "${String(meta.last_refresh)}" is not an ISO timestamp`;
    }
  }
  if (meta.evidence !== undefined && !Array.isArray(meta.evidence)) return 'evidence must be a list';
  if (Array.isArray(meta.evidence) && meta.evidence.length !== evidence.length) {
    return 'evidence entries must all be non-empty strings';
  }
  for (const rel of evidence) {
    if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return `evidence path "${rel}" must be project-relative`;
    if (rel.split(/[\\/]/).includes('..')) return `evidence path "${rel}" escapes the project`;
  }
  if (meta.status === 'OK' && !evidence.length && meta.allow_no_evidence !== true) {
    return 'status OK with no evidence files (set allow_no_evidence: true if that is genuinely the case)';
  }
  return undefined;
}

function areaMetadata(metadata: Record<string, unknown> | undefined, area: string): AreaMetadata {
  const direct = metadata?.[area];
  if (direct && typeof direct === 'object') return direct as AreaMetadata;
  const areas = metadata?.['areas'];
  if (areas && typeof areas === 'object') {
    const nested = (areas as Record<string, unknown>)[area];
    if (nested && typeof nested === 'object') return nested as AreaMetadata;
  }
  return {};
}

function evidenceList(meta: AreaMetadata): string[] {
  if (!Array.isArray(meta.evidence)) return [];
  return meta.evidence.filter((e): e is string => typeof e === 'string' && e.length > 0);
}

/**
 * Areas this repository actually has: every area recorded in metadata.json plus
 * every `<area>.instructions.md` on disk. A file with no metadata still has to be
 * reported — an unverifiable instruction is exactly the thing worth flagging.
 */
function discoverAreas(dir: string, metadata: Record<string, unknown> | undefined): string[] {
  const areas = new Set<string>();
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (NON_AREA_KEYS.has(key)) continue;
    if (value && typeof value === 'object') areas.add(key);
  }
  const nested = metadata?.['areas'];
  if (nested && typeof nested === 'object') {
    for (const key of Object.keys(nested as Record<string, unknown>)) areas.add(key);
  }
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(INSTRUCTION_SUFFIX)) {
        areas.add(entry.name.slice(0, -INSTRUCTION_SUFFIX.length));
      }
    }
  } catch {
    // directory absent — nothing mapped yet
  }
  return [...areas].sort();
}

export function inspectConventions(paths: RuntimePaths): ConventionReport {
  const dir = paths.instructionsDir;
  const metadataFile = join(dir, 'metadata.json');

  let metadata: Record<string, unknown> | undefined;
  let metadataReadable = false;
  const metadataPresent = existsSync(metadataFile);
  if (metadataPresent) {
    try {
      metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, unknown>;
      metadataReadable = true;
    } catch {
      metadataReadable = false;
    }
  }

  const areas: ConventionAreaReport[] = discoverAreas(dir, metadata).map((area) => {
    const file = join(dir, `${area}${INSTRUCTION_SUFFIX}`);
    const meta = areaMetadata(metadata, area);
    const evidence = evidenceList(meta);
    const missingEvidence: string[] = [];
    const changedEvidence: string[] = [];

    const report: ConventionAreaReport = {
      area,
      file,
      status: 'OK',
      detail: '',
      evidence,
      missingEvidence,
      changedEvidence,
    };
    if (meta.last_refresh) report.lastRefresh = meta.last_refresh;

    if (!existsSync(file)) {
      report.status = 'MISSING';
      report.detail = 'recorded in metadata.json but the file is gone — run /map-repo';
      return report;
    }

    const invalid = validateAreaMetadata(meta, evidence);
    if (invalid) {
      report.status = 'INVALID';
      report.detail = `metadata.json is not usable: ${invalid}`;
      return report;
    }

    if (!meta.last_refresh) {
      report.status = 'UNRECORDED';
      report.detail = metadataPresent
        ? 'file exists but metadata.json records no last_refresh — cannot verify freshness'
        : 'file exists but metadata.json is missing — cannot verify freshness';
      return report;
    }

    const refreshedMs = Date.parse(meta.last_refresh);
    for (const rel of evidence) {
      const abs = join(paths.projectRoot, rel);
      if (!existsSync(abs)) {
        missingEvidence.push(rel);
        continue;
      }
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        missingEvidence.push(rel);
        continue;
      }
      if (!stat.isFile()) {
        missingEvidence.push(rel);
        continue;
      }
      if (!Number.isNaN(refreshedMs) && stat.mtimeMs > refreshedMs + MTIME_SLACK_MS) {
        changedEvidence.push(rel);
      }
    }

    if (missingEvidence.length || changedEvidence.length) {
      report.status = 'STALE';
      const parts: string[] = [];
      if (missingEvidence.length) parts.push(`evidence gone: ${missingEvidence.join(', ')}`);
      if (changedEvidence.length) parts.push(`evidence changed: ${changedEvidence.join(', ')}`);
      report.detail = parts.join('; ');
      return report;
    }

    report.detail = evidence.length
      ? `verified against ${evidence.length} evidence file(s), refreshed ${meta.last_refresh}`
      : `refreshed ${meta.last_refresh}, no evidence files recorded`;
    return report;
  });

  const out: ConventionReport = {
    conventionsDir: dir,
    metadataFile,
    metadataPresent,
    metadataReadable,
    areas,
    refreshNeeded: areas.filter((a) => a.status !== 'OK').map((a) => a.area),
  };
  if (metadata && 'repo_shape' in metadata) out.repoShape = metadata['repo_shape'];
  return out;
}

export function formatConventionReport(report: ConventionReport): string {
  const icon: Record<ConventionAreaStatus, string> = {
    OK: '✓',
    MISSING: '✕',
    STALE: '!',
    UNRECORDED: '?',
    INVALID: '✕',
  };
  const lines: string[] = [`instructions  ${report.conventionsDir}`];
  if (!report.areas.length) lines.push('no areas mapped yet — run /map-repo <area> when knowledge is worth persisting');
  else if (!report.metadataPresent) lines.push('metadata     missing — run /map-repo');
  else if (!report.metadataReadable) lines.push(`metadata     unreadable at ${report.metadataFile}`);

  for (const area of report.areas) {
    lines.push(`${icon[area.status]} ${area.area.padEnd(9)} ${area.status.padEnd(10)} ${area.detail}`);
    if (area.evidence.length) lines.push(`  ${' '.repeat(9)} evidence: ${area.evidence.join(', ')}`);
  }

  lines.push(
    report.refreshNeeded.length
      ? `\nrefresh needed: /map-repo ${report.refreshNeeded.join(' ')}`
      : '\nevery mapped area is verified — read the one that covers what you are touching',
  );
  lines.push(
    'precedence: local intentional convention near the touched code > these files > generic default',
  );
  return lines.join('\n');
}
