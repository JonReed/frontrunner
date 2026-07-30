const LABELED_SEGMENT = /^([a-z][a-z_-]*):\s*(.*)$/i;
const PIPELINE_LABELS = new Set(['posted', 'trust', 'note']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the metadata portion after a pipeline row's URL.
 *
 * The scanner emits positional company/role/location/compensation cells, then
 * labeled metadata. Empty positional cells are significant: dropping them can
 * turn `posted:` or `trust:` into a location in UI readers.
 */
export function parsePipelineMetadata(raw) {
  if (typeof raw !== 'string') {
    return { company: '', role: '', location: '', compensation: '', posted: null };
  }

  const cells = raw.split('|').map((cell) => cell.trim());
  if (cells[0] === '') cells.shift();

  const positional = [];
  const labels = new Map();
  for (const [index, cell] of cells.entries()) {
    const match = index >= 2 ? cell.match(LABELED_SEGMENT) : null;
    const label = match?.[1]?.toLowerCase();
    if (label && PIPELINE_LABELS.has(label)) {
      labels.set(label, match[2].trim());
    } else {
      positional.push(cell);
    }
  }

  const posted = labels.get('posted');
  return {
    company: positional[0] ?? '',
    role: positional[1] ?? '',
    location: positional[2] ?? '',
    compensation: positional[3] ?? '',
    posted: posted && ISO_DATE.test(posted) ? posted : null,
  };
}
