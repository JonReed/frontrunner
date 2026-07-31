/** Minimal, display-only YAML helpers for the profile summary. */

function uncomment(value) {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (quote === '"' && char === '\\' && !escaped) {
        escaped = true;
        continue;
      }
      if (char === quote && !escaped) quote = '';
      escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd();
  }
  return value.trimEnd();
}

function unquote(value) {
  const clean = uncomment(value).trim();
  if (clean.length >= 2 && ((clean.startsWith('"') && clean.endsWith('"'))
    || (clean.startsWith("'") && clean.endsWith("'")))) {
    return clean.slice(1, -1);
  }
  return clean;
}

export function scalar(src, path) {
  const lines = src.split('\n');
  let depth = 0;
  let i = 0;
  for (const key of path) {
    let found = false;
    for (; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)([\w-]+):\s*(.*)$/);
      if (!m) continue;
      if (m[1].length < depth) return null;
      if (m[1].length === depth && m[2] === key) {
        if (key === path[path.length - 1]) {
          const value = unquote(m[3]);
          return value || null;
        }
        depth = m[1].length + 2;
        i++;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return null;
}

export function list(src, header) {
  const lines = src.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s*${header}:\\s*$`).test(line));
  if (start === -1) return [];

  const headerIndent = (lines[start].match(/^\s*/) ?? [''])[0].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    if (indent <= headerIndent) break;

    const item = line.match(/^\s*-\s+(.+)$/);
    if (!item) break;
    out.push(unquote(item[1]));
  }
  return out;
}
