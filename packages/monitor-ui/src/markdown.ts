/**
 * A markdown subset, parsed into blocks.
 *
 * SKILL.md files are written by the kit and the project, and they use a small,
 * predictable slice of markdown. That is not worth a parser dependency — and
 * rendering them means rendering *local files as text*, so this returns data
 * that the component turns into React elements. Nothing is ever injected as
 * HTML, which is what keeps an unvetted skill file from executing anything.
 */

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language?: string; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'rule' };

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const TABLE_ROW = /^\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\|[\s:|-]+\|\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      flush();
      const language = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        body.push(lines[i]!);
        i += 1;
      }
      const block: Block = { kind: 'code', text: body.join('\n') };
      if (language) (block as { language?: string }).language = language;
      blocks.push(block);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) {
        const raw = lines[i]!;
        if (!TABLE_DIVIDER.test(raw)) {
          rows.push(raw.slice(1, raw.lastIndexOf('|')).split('|').map((cell) => cell.trim()));
        }
        i += 1;
      }
      i -= 1;
      if (rows.length) blocks.push({ kind: 'table', rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flush();
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        if (match) {
          items.push(match[1]!.trim());
          i += 1;
          continue;
        }
        // A wrapped continuation line belongs to the item above it.
        if (items.length && /^\s+\S/.test(current)) {
          items[items.length - 1] += ` ${current.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      i -= 1;
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body = [quote[1]!];
      while (i + 1 < lines.length && QUOTE.test(lines[i + 1]!)) {
        i += 1;
        body.push(QUOTE.exec(lines[i]!)![1]!);
      }
      blocks.push({ kind: 'quote', text: body.join(' ').trim() });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/** Inline spans: `code` and **strong**. Everything else stays literal text. */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) spans.push({ kind: 'text', text: text.slice(last, match.index) });
    if (match[1] !== undefined) spans.push({ kind: 'code', text: match[1] });
    else spans.push({ kind: 'strong', text: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ kind: 'text', text: text.slice(last) });
  return spans;
}
