// @ts-check
/**
 * Persist JD text that a scanner provider already returned in its list API.
 *
 * Several providers expose a full description at no extra request cost. The
 * scanner needs that text for deterministic filters and fingerprints; keeping
 * it here prevents fetch-jds or a model worker from fetching the same posting
 * again later.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { htmlToText } from './fetch-jds.mjs';
import {
  publishJdCacheEntries,
  readJdManifest,
} from './jd-cache-store.mjs';

export { readJdManifest };

function stableName(url) {
  return `scan-${createHash('sha256').update(url).digest('hex').slice(0, 16)}.md`;
}

/**
 * @param {Array<{url?:unknown,title?:unknown,company?:unknown,location?:unknown,description?:unknown}>} offers
 * @param {{outDir?:string}} [options]
 */
export async function cacheProviderDescriptions(offers, {
  outDir = join(ROOT, 'jds'),
  publishOptions = {},
} = {}) {
  const manifest = readJdManifest(outDir);
  let cached = 0;
  const publications = [];

  for (const offer of offers) {
    const url = typeof offer?.url === 'string' ? offer.url.trim() : '';
    const raw = typeof offer?.description === 'string' ? offer.description.trim() : '';
    if (!url || !raw) continue;

    const text = /<[^>]+>/.test(raw) ? htmlToText(raw) : raw;
    if (!text.trim()) continue;

    const name = manifest.get(url)?.split(/[/\\]/u).at(-1) ?? stableName(url);
    const title = String(offer.title ?? '').replace(/[\r\n]+/g, ' ').trim() || 'Job description';
    const company = String(offer.company ?? '').replace(/[\r\n]+/g, ' ').trim();
    const location = String(offer.location ?? '').replace(/[\r\n]+/g, ' ').trim();
    publications.push({
      url,
      name,
      content: `# ${title}\n\n**Company:** ${company}\n**Location:** ${location}\n**URL:** ${url}\n\n---\n\n${text}`,
      overwrite: true,
    });
    cached += 1;
  }

  if (cached > 0) {
    const result = await publishJdCacheEntries(outDir, publications, publishOptions);
    return { cached, manifestSize: result.manifestSize };
  }

  return { cached, manifestSize: manifest.size };
}
