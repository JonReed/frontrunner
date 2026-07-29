/**
 * Locked, atomic publisher for data/pdf-index.tsv.
 */

import { mutateFileLocked } from '../lib/locked-file.mjs';

export const PDF_INDEX_HEADER =
  '# report\tpdf\thtml\tformat\tdate — written by generate-pdf.mjs, do not edit\n';

function field(value, name, { allowEmpty = false } = {}) {
  const text = String(value ?? '');
  if ((!allowEmpty && text.length === 0)
      || text.length > 1_024
      || /[\t\r\n\0-\x1f\x7f]/u.test(text)) {
    throw new TypeError(`PDF index ${name} is invalid`);
  }
  return text;
}

function relativePath(value, name, { allowEmpty = false } = {}) {
  const text = field(value, name, { allowEmpty });
  if (!text && allowEmpty) return '';
  if (text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(text)) {
    throw new TypeError(`PDF index ${name} must be repository-relative`);
  }
  const segments = text.replaceAll('\\', '/').split('/');
  if (segments.some(segment => segment === '..' || segment === '')) {
    throw new TypeError(`PDF index ${name} must be a contained relative path`);
  }
  return segments.join('/');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizedReport(value) {
  return String(value ?? '').trim().replace(/^0+(?=\d)/u, '');
}

export function pdfIndexLine(entry) {
  const report = field(entry.reportNum, 'report number', { allowEmpty: true });
  if (report && !/^\d{1,9}$/u.test(report)) {
    throw new TypeError('PDF index report number is invalid');
  }
  const pdf = relativePath(entry.pdf, 'PDF path');
  const html = relativePath(entry.html, 'HTML path', { allowEmpty: true });
  const format = field(entry.format, 'format');
  if (!/^[a-z0-9-]{1,24}$/u.test(format)) {
    throw new TypeError('PDF index format is invalid');
  }
  const date = field(entry.date, 'date');
  if (!validDate(date)) {
    throw new TypeError('PDF index date is invalid');
  }
  return {
    line: [report, pdf, html, format, date].join('\t'),
    report,
    pdf,
  };
}

export async function recordPdfIndex(file, entry, options = {}) {
  const next = pdfIndexLine(entry);
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('PDF index maxBytes must be a positive integer');
  }
  await mutateFileLocked(file, current => {
    if (Buffer.byteLength(current, 'utf8') > maxBytes) {
      throw new Error('PDF index exceeds the safe update limit');
    }
    const rows = current.split(/\r?\n/u).filter(line => {
      if (!line.trim() || line.startsWith('#')) return false;
      const columns = line.split('\t');
      if (columns[1] === next.pdf) return false;
      if (next.report && normalizedReport(columns[0]) === normalizedReport(next.report)) return false;
      return true;
    });
    rows.push(next.line);
    const content = `${PDF_INDEX_HEADER}${rows.join('\n')}\n`;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new Error('PDF index update would exceed the safe limit');
    }
    return content;
  }, {
    initial: '',
    lockOptions: options.lockOptions,
    writeOptions: options.writeOptions,
  });
}
