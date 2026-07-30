import { recordPdfIndex } from '../../src/cv/pdf-index-store.mjs';

const [file, reportNum] = process.argv.slice(2);
await recordPdfIndex(file, {
  reportNum,
  pdf: `workspace/documents/cv-${reportNum}.pdf`,
  html: `workspace/documents/cv-${reportNum}.html`,
  format: 'a4',
  date: '2026-07-29',
});
