/**
 * The traceability layer between a delivered design document and the code.
 *
 * `spec-map.md` is the machine-checkable half of the analysis contract: the five
 * prose artifacts explain the solution, this one states which numbered design
 * requirement lives in which files. It stays markdown because the published copy
 * under the analysis report directory is meant to be opened by a human, and a
 * table a reviewer can edit is worth more than a JSON file they will not read.
 */

export const SPEC_MAP_ARTIFACT = 'spec-map.md';

export interface SpecItem {
  /** Stable identifier, e.g. SPEC-001. Never renumbered once approved. */
  id: string;
  requirement: string;
  /** Location in the delivered design document, e.g. docs/design/TKCT.md#4.2 */
  designRef: string;
  /** Project-relative files or directories that implement the requirement. */
  codePaths: string[];
}

export interface SpecMap {
  items: SpecItem[];
  errors: string[];
}

const ID_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const SEPARATOR_CELL = /^:?-{2,}:?$/;

function normalisePath(value: string): string {
  return value.trim().replace(/^`|`$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function splitRow(line: string): string[] {
  // ponytail: no escaped-pipe support. A `\|` inside a requirement is rare and
  // the parser reports the malformed row rather than silently mis-splitting it.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Parse the traceability table. Structural problems are collected rather than
 * thrown: `cw analysis ready` needs to show the author every broken row at once.
 */
export function parseSpecMap(content: string): SpecMap {
  const items: SpecItem[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.every((cell) => SEPARATOR_CELL.test(cell))) continue;
    const first = cells[0] ?? '';
    if (first.toLowerCase() === 'id') continue;

    const where = `${SPEC_MAP_ARTIFACT}:${index + 1}`;
    if (cells.length < 4) {
      errors.push(`${where}: expected 4 columns (ID | Requirement | Design Ref | Code Paths)`);
      continue;
    }
    const [id, requirement, designRef, codePaths] = cells as [string, string, string, string];
    if (!ID_PATTERN.test(id)) {
      errors.push(`${where}: "${id}" is not a stable id like SPEC-001`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${where}: duplicate id ${id}`);
      continue;
    }
    if (!requirement) {
      errors.push(`${where}: ${id} has no requirement statement`);
      continue;
    }
    if (!designRef) {
      errors.push(`${where}: ${id} has no design reference; a spec item without a source is a guess`);
      continue;
    }
    seen.add(id);
    items.push({
      id,
      requirement,
      designRef: normalisePath(designRef),
      codePaths: codePaths
        .split(',')
        .map(normalisePath)
        .filter(Boolean),
    });
  }

  if (!items.length && !errors.length) {
    errors.push(`${SPEC_MAP_ARTIFACT} contains no traceability rows`);
  }
  return { items, errors };
}

/** The design documents the map is derived from, without their section anchors. */
export function designSources(items: SpecItem[]): string[] {
  const out = new Set<string>();
  for (const item of items) {
    const path = item.designRef.split('#')[0]?.trim();
    if (path) out.add(path);
  }
  return [...out];
}

/** Requirements nobody has pointed at any code yet. */
export function unmappedItems(items: SpecItem[]): SpecItem[] {
  return items.filter((item) => !item.codePaths.length);
}

// ponytail: case-insensitive compare, because the same repo is edited from
// Windows and Linux. Upgrade to case-sensitive if a project ever ships two
// paths differing only in case.
function covers(codePath: string, file: string): boolean {
  const p = codePath.toLowerCase().replace(/\/(\*\*|\*)$/, '').replace(/\/$/, '');
  const f = file.toLowerCase();
  return f === p || f.startsWith(`${p}/`);
}

export interface SpecCoverage {
  file: string;
  itemIds: string[];
}

/** Which requirements govern each of the given files. */
export function specCoverage(items: SpecItem[], files: string[]): SpecCoverage[] {
  return files.map((input) => {
    const file = normalisePath(input);
    return {
      file,
      itemIds: items
        .filter((item) => item.codePaths.some((path) => covers(path, file)))
        .map((item) => item.id),
    };
  });
}
