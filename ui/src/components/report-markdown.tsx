import { Fragment, type ReactNode } from 'react';
import { safeExternalUrl } from '@/lib/urls';

const tokenPattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^) \n]+\)|\*[^*\n]+\*)/g;

function inline(value: string): ReactNode[] {
  const parts = value.split(tokenPattern);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded bg-[var(--color-paper)] px-1 py-0.5 text-[0.9em]">{part.slice(1, -1)}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeExternalUrl(link[2]);
      return href
        ? <a key={index} href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--color-act)] underline underline-offset-2">{link[1]}</a>
        : <Fragment key={index}>{link[1]}</Fragment>;
    }
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function tableCells(row: string) {
  return row.split('|').slice(1, -1).map((cell) => cell.trim());
}

export function ReportMarkdown({ body }: { body: string }) {
  const lines = body.split('\n');
  const nodes: ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].trimEnd().startsWith('|')) rows.push(lines[i++].trimEnd());
      i--;
      const separator = rows.findIndex((row) => /^\|[\s\-:|]+\|$/.test(row));
      const header = separator === 1 ? tableCells(rows[0]) : null;
      const bodyRows = rows
        .filter((_, index) => index !== separator && !(header && index === 0))
        .map(tableCells);
      nodes.push(
        <div key={`table-${i}`} className="overflow-x-auto">
          <table className="w-full text-sm">
            {header && <thead><tr className="border-b border-[var(--color-line-strong)]">{header.map((cell, j) => <th key={j} className="py-2 pr-4 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">{inline(cell)}</th>)}</tr></thead>}
            <tbody>{bodyRows.map((row, r) => <tr key={r} className="border-b border-[var(--color-line)] last:border-0">{row.map((cell, c) => <td key={c} className="py-2 pr-4 align-top">{inline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trimEnd())) {
        items.push(lines[i++].trimEnd().replace(/^[-*]\s+/, ''));
      }
      i--;
      nodes.push(<ul key={`list-${i}`} className="ml-4 list-disc space-y-1.5">{items.map((item, j) => <li key={j}>{inline(item)}</li>)}</ul>);
      continue;
    }
    const heading = line.match(/^###\s+(.+)/);
    if (heading) {
      nodes.push(<h4 key={i} className="mt-5 mb-1.5 font-semibold text-[var(--color-ink)]">{inline(heading[1])}</h4>);
    } else if (line.startsWith('> ')) {
      nodes.push(<blockquote key={i} className="border-l-2 border-[var(--color-line-strong)] pl-3 italic">{inline(line.slice(2))}</blockquote>);
    } else if (line.startsWith('```') || !line.trim()) {
      continue;
    } else {
      nodes.push(<p key={i}>{inline(line)}</p>);
    }
  }
  return <>{nodes}</>;
}
