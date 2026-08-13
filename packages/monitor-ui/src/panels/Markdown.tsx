import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, parseSpans } from '../markdown';

/** Renders the markdown subset as React elements — never as raw HTML. */
export function Markdown({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = (['h2', 'h3', 'h4'] as const)[block.level - 1]!;
            return <Tag key={i}>{inline(block.text)}</Tag>;
          }
          case 'code':
            return (
              <pre key={i} className="md__code">
                <code>{block.text}</code>
              </pre>
            );
          case 'list':
            return block.ordered ? (
              <ol key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            );
          case 'quote':
            return (
              <blockquote key={i} className="md__quote">
                {inline(block.text)}
              </blockquote>
            );
          case 'table':
            return (
              <div key={i} className="md__tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      {(block.rows[0] ?? []).map((cell, j) => (
                        <th key={j}>{inline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.slice(1).map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr key={i} className="md__rule" />;
          default:
            return <p key={i}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}

function inline(text: string): ReactNode {
  return parseSpans(text).map((span, i) => {
    if (span.kind === 'code') return <code key={i}>{span.text}</code>;
    if (span.kind === 'strong') return <strong key={i}>{span.text}</strong>;
    return <Fragment key={i}>{span.text}</Fragment>;
  });
}
