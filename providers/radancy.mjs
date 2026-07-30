// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Radancy (TalentBrew) provider — the career sites Radancy hosts for large
// employers (careers.munichre.com and its ERGO brands, plus many others). The
// search-results page is SERVER-rendered and paginates over bare HTTP:
//
//   GET {origin}/{lang}/search-jobs?p={N}      # 1-based; past-the-end → empty
//
// Each posting is one <li class="search-results-list__item …"> holding:
//   <a class="search-results-list__job-link …" href="/{lang}/job/{city}/{slug}/{cat}/{id}"
//      data-job-id="{id}">{Title}</a>
//   <li class="…__job-info--location"><i></i><span>{City, Country}</span></li>
// The generic `search-results-list__` class prefix is the stable TalentBrew
// markup (a second, module-numbered `job-list-NN-list__` prefix rides alongside
// it and varies per site) — we anchor on the generic one for portability.
//
// The list carries no posting date, so postedAt is omitted. detect() can't be
// host-based (branded domains), so tenants are wired with an explicit
// `provider: radancy` + a search-jobs `api:`/`careers_url`.

const MAX_PAGES = 200;
const DEFAULT_MAX_JOBS = 2000;
const PAGE_DELAY_MS = 150; // polite pacing — full walks are >100 sequential requests
const FRAGMENT_RECORDS_PER_PAGE = 100;

// Minimal HTML entity decoder — mirrors the other HTML-scraping providers.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // String.fromCodePoint throws RangeError outside 0..0x10FFFF or on a lone
      // surrogate half — a malformed/adversarial entity must degrade to the
      // original text, never crash the whole parse.
      const valid = Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Resolve the search-jobs list URL from api:/careers_url; default /en. */
export function resolveListUrl(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (/\/search-jobs\/?$/.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
  const lang = (u.pathname.match(/^\/([a-z]{2})(\/|$)/) || [])[1] || 'en';
  return `${u.origin}/${lang}/search-jobs`;
}

/**
 * Build the lightweight JSON-fragment URL used by TalentBrew's own client.
 * Deliberately omit SearchFiltersModuleName: including it attaches a large
 * facet blob to every response.
 */
export function buildFragmentUrl(listUrl, page, recordsPerPage = FRAGMENT_RECORDS_PER_PAGE) {
  const query = new URLSearchParams({
    ActiveFacetID: '0',
    CurrentPage: String(page),
    RecordsPerPage: String(recordsPerPage),
    Distance: '50',
    RadiusUnitType: '0',
    Keywords: '',
    Location: '',
    ShowRadius: 'False',
    IsPagination: 'True',
    CustomFacetName: '',
    FacetTerm: '',
    FacetType: '0',
    SearchResultsModuleName: 'Search Results',
    SortCriteria: '0',
    SortDirection: '0',
    SearchType: '5',
  });
  return `${listUrl}/results?${query.toString()}`;
}

export function readFragmentTotals(html) {
  if (typeof html !== 'string') return { totalResults: null, totalPages: null };
  const numberFrom = (pattern) => {
    const match = html.match(pattern);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    totalResults: numberFrom(/data-total-results="(\d+)"/u),
    totalPages: numberFrom(/data-total-pages="(\d+)"/u),
  };
}

/**
 * Parse legacy TalentBrew rows where the job anchor is the row and carries
 * data-job-id. Attribute order is intentionally not assumed.
 */
export function parseLegacyResults(html, origin) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const attrs = anchor[1];
    const inner = anchor[2];
    const idMatch = attrs.match(/data-job-id="([^"]+)"/iu);
    const hrefMatch = attrs.match(/href="([^"]+)"/iu);
    if (!idMatch || !hrefMatch) continue;
    const href = decodeEntities(hrefMatch[1]);
    if (!/\/job\//u.test(href) || seen.has(idMatch[1])) continue;
    const heading = inner.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/iu);
    const title = clean(
      heading ? heading[1] : inner.replace(/<span[\s\S]*?<\/span>/giu, ' '),
    );
    if (!title) continue;
    let url;
    try {
      url = new URL(href, origin).href;
    } catch {
      continue;
    }
    const location = inner.match(
      /class="[^"]*job-location[^"]*"[^>]*>([\s\S]*?)<\/span>/iu,
    );
    seen.add(idMatch[1]);
    out.push({
      id: idMatch[1],
      title,
      url,
      location: location ? clean(location[1]) : '',
    });
  }
  return out;
}

/**
 * Parse one search-results page into raw {id, title, url, location} records.
 * @param {string} html @param {string} origin
 */
export function parseResults(html, origin) {
  const modern = parseModernResults(html, origin);
  return modern.length > 0 ? modern : parseLegacyResults(html, origin);
}

export function parseModernResults(html, origin) {
  if (typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  // Split on the stable generic list-item class; slice(0) is the page head.
  const blocks = html.split(/<li class="search-results-list__item/).slice(1);
  for (const block of blocks) {
    const link = block.match(/search-results-list__job-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const href = decodeEntities(link[1]);
    const dataIdM = block.match(/data-job-id="([^"]+)"/);
    const hrefIds = [...href.matchAll(/\/(\d+)(?=[/?#]|$)/g)];
    const id = dataIdM ? dataIdM[1] : (hrefIds.length ? hrefIds[hrefIds.length - 1][1] : href);
    if (seen.has(id)) continue;
    const title = clean(link[2]);
    if (!title) continue;
    let url;
    try {
      url = new URL(href, origin).href;
    } catch {
      continue;
    }
    const locM = block.match(/__job-info--location[\s\S]*?<span>([\s\S]*?)<\/span>/);
    seen.add(id);
    out.push({ id, title, url, location: locM ? clean(locM[1]) : '' });
  }
  return out;
}

/** Resolve the page cap: positive integer `max_pages`, else default. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

function resolveMaxJobs(entry) {
  const value = entry?.max_jobs;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_JOBS;
}

/** @type {Provider} */
export default {
  id: 'radancy',

  detect() {
    // Branded hosts carry no stable Radancy token in the URL — wire explicitly
    // with `provider: radancy`. No auto-detection.
    return null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`radancy: cannot resolve search-jobs URL for ${entry.name}`);
    const origin = new URL(listUrl).origin;

    const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
    const maxPages = resolveMaxPages(entry);
    const maxJobs = resolveMaxJobs(entry);
    const jobs = [];
    const seen = new Set();

    // Prefer the compact JSON results fragment. Unsupported tenants or malformed
    // responses fall back to the existing HTML walk without losing coverage.
    if (typeof ctx.fetchJson === 'function') {
      try {
        const first = await ctx.fetchJson(buildFragmentUrl(listUrl, 1), {
          headers: {
            accept: 'application/json',
            'x-requested-with': 'XMLHttpRequest',
          },
        });
        const firstHtml = typeof first?.results === 'string' ? first.results : '';
        const firstRows = firstHtml ? parseResults(firstHtml, origin) : [];
        if (firstRows.length > 0) {
          const { totalResults, totalPages } = readFragmentTotals(firstHtml);
          const lastPage = Math.min(totalPages ?? maxPages, maxPages);
          const appendFresh = (rows) => {
            let fresh = 0;
            for (const row of rows) {
              if (seen.has(row.id)) continue;
              seen.add(row.id);
              fresh++;
              jobs.push({
                title: row.title,
                url: row.url,
                company: entry.name,
                location: row.location,
              });
            }
            return fresh;
          };
          appendFresh(firstRows);

          for (let page = 2; page <= lastPage && jobs.length < maxJobs; page++) {
            await wait(PAGE_DELAY_MS);
            let rows;
            try {
              const json = await ctx.fetchJson(buildFragmentUrl(listUrl, page), {
                headers: {
                  accept: 'application/json',
                  'x-requested-with': 'XMLHttpRequest',
                },
              });
              const fragment = typeof json?.results === 'string' ? json.results : '';
              rows = fragment ? parseResults(fragment, origin) : [];
            } catch {
              break;
            }
            if (rows.length === 0 || appendFresh(rows) === 0) break;
          }

          const returned = Math.min(jobs.length, maxJobs);
          if (totalResults !== null && returned < totalResults) {
            console.error(
              `⚠️  radancy: ${entry.name} truncated at ${returned} of ${totalResults} postings`
              + ' — raise max_jobs/max_pages on this entry for more',
            );
          }
          return jobs.slice(0, maxJobs);
        }
      } catch {
        // Fall through to the bounded HTML transport.
      }
    }

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await wait(PAGE_DELAY_MS);
      let rows;
      try {
        const html = await ctx.fetchText(`${listUrl}?p=${page}`, { headers: { accept: 'text/html' } });
        rows = parseResults(html, origin);
      } catch {
        break; // keep jobs collected so far — a transient mid-scan failure shouldn't discard earlier pages
      }
      if (rows.length === 0) break; // past the last page

      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        jobs.push({ title: row.title, url: row.url, company: entry.name, location: row.location });
      }
      // No new ids → the server clamped ?p= to the last page (or looped). Stop.
      if (fresh === 0) break;
      if (jobs.length >= maxJobs) break;
    }
    return jobs.slice(0, maxJobs);
  },
};
