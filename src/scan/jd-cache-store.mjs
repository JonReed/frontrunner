/**
 * Durable publication boundary for the shared JD cache.
 *
 * Network work happens before this boundary. Publication then re-reads the
 * manifest under one cross-process lock, atomically replaces each bounded JD,
 * and commits the merged manifest last. A crash can leave an unreferenced JD
 * file, but can never expose a manifest entry whose file is partial or lose a
 * concurrent writer's entry.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  basename,
  join,
  relative,
  resolve,
} from 'node:path';

import { withFileLock } from '../lib/file-lock.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { normalizeJobText } from '../security/job-document.mjs';

const MANIFEST_HEADER = 'url\tfile\n';
const CACHE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}\.md$/u;

function containedFile(outDir, file) {
  const root = resolve(outDir);
  const candidate = resolve(file);
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.includes('/../')
    ? candidate
    : null;
}

function validRemoteUrl(value) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || /[\t\r\n]/u.test(value)
  ) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function isRegularFile(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function pathEntryExists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function jdManifestPath(outDir) {
  return join(resolve(outDir), 'index.tsv');
}

export function readJdManifest(outDir) {
  const entries = new Map();
  const index = jdManifestPath(outDir);
  if (!isRegularFile(index)) return entries;
  for (const line of readFileSync(index, 'utf8').split('\n').slice(1)) {
    const [url, file] = line.split('\t');
    const contained = file ? containedFile(outDir, file) : null;
    if (
      url
      && validRemoteUrl(url)
      && contained
      && isRegularFile(contained)
    ) {
      entries.set(url, contained);
    }
  }
  return entries;
}

function manifestText(manifest) {
  const rows = [...manifest.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([url, file]) => `${url}\t${file}`);
  return `${MANIFEST_HEADER}${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

/**
 * @param {string} outDir
 * @param {Array<{url:string,name:string,content:string,overwrite?:boolean}>} entries
 * @param {{
 *   lockOptions?:object,
 *   afterEntryWrite?:(temporary:string, entry:object)=>void,
 *   afterIndexWrite?:(temporary:string)=>void
 * }} [options]
 */
export async function publishJdCacheEntries(outDir, entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('JD cache entries must be an array');
  mkdirSync(outDir, { recursive: true });
  const index = jdManifestPath(outDir);

  return withFileLock(index, async () => {
    const manifest = readJdManifest(outDir);
    let published = 0;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        throw new TypeError('JD cache entry must be an object');
      }
      if (!validRemoteUrl(entry.url)) throw new Error('JD cache URL must be HTTP(S) without credentials');
      if (typeof entry.name !== 'string' || basename(entry.name) !== entry.name || !CACHE_NAME_RE.test(entry.name)) {
        throw new Error('JD cache filename is invalid');
      }
      const file = join(resolve(outDir), entry.name);
      const content = `${normalizeJobText(entry.content)}\n`;
      if (!content.trim()) throw new Error('JD cache content is empty');
      const targetExists = pathEntryExists(file);
      if (targetExists && !isRegularFile(file)) {
        throw new Error('JD cache target must be a regular file');
      }

      if (entry.overwrite === true || !targetExists) {
        replaceFileAtomic(file, content, {
          mode: 0o600,
          afterWrite: temporary => options.afterEntryWrite?.(temporary, entry),
        });
      }
      manifest.set(entry.url, file);
      published++;
    }

    if (published > 0) {
      replaceFileAtomic(index, manifestText(manifest), {
        mode: 0o600,
        afterWrite: options.afterIndexWrite,
      });
    }
    return { published, manifestSize: manifest.size, manifest };
  }, options.lockOptions);
}
