/**
 * Convention cache inspection — deliberately small.
 *
 * Discovering and writing conventions stays a Claude job (`refresh-conventions`,
 * `wf-convention-manager`). The only thing code owns is the question those
 * skills cannot answer honestly about themselves: *is the cache still valid?*
 * That is a filesystem fact — file present, evidence file still there, evidence
 * changed since the last refresh — so it is computed, not asserted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { RuntimePaths } from './store.js';

export const CONVENTION_AREAS = ['code', 'comments', 'testing', 'database'] as const;

/**
 * `last_refresh` is recorded at millisecond resolution while filesystem mtimes
 * are finer, so a file written moments before the refresh can read as newer.
 * One second of slack removes that false "stale" without hiding a real edit.
 */
const MTIME_SLACK_MS = 1000;
export type ConventionArea = (typeof CONVENTION_AREAS)[number];

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
  /** Areas that need `/refresh-conventions <area>`. */
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

export function inspectConventions(paths: RuntimePaths): ConventionReport {
  const dir = paths.conventionsDir;
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

  const areas: ConventionAreaReport[] = CONVENTION_AREAS.map((area) => {
    const file = join(dir, `${area}.md`);
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
      report.detail = 'no cached convention — run /refresh-conventions';
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
  const lines: string[] = [`conventions  ${report.conventionsDir}`];
  if (!report.metadataPresent) lines.push('metadata     missing — run /refresh-conventions');
  else if (!report.metadataReadable) lines.push(`metadata     unreadable at ${report.metadataFile}`);

  for (const area of report.areas) {
    lines.push(`${icon[area.status]} ${area.area.padEnd(9)} ${area.status.padEnd(10)} ${area.detail}`);
    if (area.evidence.length) lines.push(`  ${' '.repeat(9)} evidence: ${area.evidence.join(', ')}`);
  }

  lines.push(
    report.refreshNeeded.length
      ? `\nrefresh needed: /refresh-conventions ${report.refreshNeeded.join(' ')}`
      : '\nall cached areas valid — reuse them, do not rescan the repository',
  );
  lines.push(
    'precedence: local intentional convention near the touched code > this cache > generic external skill',
  );
  return lines.join('\n');
}
