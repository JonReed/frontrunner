// @ts-check
/**
 * Persist JD text that a scanner provider already returned in its list API.
 *
 * Several providers expose a full description at no extra request cost. The
 * scanner needs that text for deterministic filters and fingerprints; keeping
 * it here prevents fetch-jds or a model worker from fetching the same posting
 * again later.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { htmlToText } from './fetch-jds.mjs';

export function readJdManifest(outDir) {
  const entries = new Map();
  const index = join(outDir, 'index.tsv');
  if (!existsSync(index)) return entries;
  for (const line of readFileSync(index, 'utf8').split('\n').slice(1)) {
    const [url, file] = line.split('\t');
    if (url && file && existsSync(file)) entries.set(url, file);
  }
  return entries;
}

function atomicWrite(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

function stableName(url) {
  return `scan-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.md`;
}

/**
 * @param {Array<{url?:unknown,title?:unknown,company?:unknown,location?:unknown,description?:unknown}>} offers
 * @param {{outDir?:string}} [options]
 */
export function cacheProviderDescriptions(offers, { outDir = join(ROOT, 'jds') } = {}) {
  mkdirSync(outDir, { recursive: true });
  const manifest = readJdManifest(outDir);
  let cached = 0;

  for (const offer of offers) {
    const url = typeof offer?.url === 'string' ? offer.url.trim() : '';
    const raw = typeof offer?.description === 'string' ? offer.description.trim() : '';
    if (!url || !raw) continue;

    const text = /<[^>]+>/.test(raw) ? htmlToText(raw) : raw;
    if (!text.trim()) continue;

    const file = manifest.get(url) ?? join(outDir, stableName(url));
    const title = String(offer.title ?? '').replace(/[\r\n]+/g, ' ').trim() || 'Job description';
    const company = String(offer.company ?? '').replace(/[\r\n]+/g, ' ').trim();
    const location = String(offer.location ?? '').replace(/[\r\n]+/g, ' ').trim();
    atomicWrite(
      file,
      `# ${title}\n\n**Company:** ${company}\n**Location:** ${location}\n**URL:** ${url}\n\n---\n\n${text}\n`,
    );
    manifest.set(url, file);
    cached += 1;
  }

  if (cached > 0) {
    const rows = [...manifest.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([url, file]) => `${url}\t${file}`);
    atomicWrite(join(outDir, 'index.tsv'), `url\tfile\n${rows.join('\n')}\n`);
  }

  return { cached, manifestSize: manifest.size };
}
