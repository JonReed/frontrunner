// tests/providers/radancy.test.mjs — Radancy (TalentBrew) SSR search-results parser.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — radancy (TalentBrew SSR search-results parser)');
try {
  const radancyModule = await import(pathToFileURL(join(ROOT, 'providers/radancy.mjs')).href);
  const radancy = radancyModule.default;
  const {
    resolveListUrl: radListUrl,
    parseResults,
    parseLegacyResults,
    parseModernResults,
    buildFragmentUrl,
    readFragmentTotals,
  } = radancyModule;

  if (radancy.id === 'radancy') pass('radancy.id is "radancy"');
  else fail(`radancy.id is ${JSON.stringify(radancy.id)}`);

  // resolveListUrl — keeps explicit search-jobs URLs, defaults to /{lang}.
  if (radListUrl({ api: 'https://careers.munichre.com/en/search-jobs' }) === 'https://careers.munichre.com/en/search-jobs') pass('radancy.resolveListUrl() keeps an explicit search-jobs URL');
  else fail('radancy.resolveListUrl() should keep the search-jobs URL');
  if (radListUrl({ careers_url: 'https://careers.munichre.com/de/some-page' }) === 'https://careers.munichre.com/de/search-jobs') pass('radancy.resolveListUrl() defaults to /{lang}/search-jobs');
  else fail(`radancy.resolveListUrl() default wrong: ${radListUrl({ careers_url: 'https://careers.munichre.com/de/some-page' })}`);

  // detect — never auto-claims (branded hosts, wire explicitly).
  if (radancy.detect({ careers_url: 'https://careers.munichre.com/en/search-jobs' }) === null) pass('radancy.detect() returns null (explicit wiring only)');
  else fail('radancy.detect() should not auto-claim');

  // parseResults — the tricky part: anchor on the STABLE generic class prefix,
  // read title + location within one <li>, resolve the relative href.
  const card = (id, title, loc) =>
    '<li class="search-results-list__item job-list-01-list__item">' +
    '<div class="search-results-list__content">' +
    `<h5 class="search-results-list__job-title"><a class="search-results-list__job-link job-card-brand-hover--x" href="/en/job/city/${id}-slug/3193/${id}" data-job-id="${id}" id="job-${id}">${title}</a></h5>` +
    `<ul class="search-results-list__job-info-list"><li class="search-results-list__job-info job-list-01-list__job-info--location"><i class="icon"></i> <span>${loc}</span> </li></ul>` +
    '</li>';
  const html = '<html>' + card('40548453568', 'Innendienst f&#252;r Versicherungsagentur', 'Bingen am Rhein, Germany') + card('40546200896', 'Category Manager', 'London, United Kingdom') + '</html>';
  const rows = parseResults(html, 'https://careers.munichre.com');
  if (rows.length === 2) pass('radancy.parseResults() yields one row per search-results item');
  else fail(`radancy.parseResults() returned ${rows.length}, expected 2`);
  if (rows[0]?.title === 'Innendienst für Versicherungsagentur') pass('radancy.parseResults() decodes entities in titles');
  else fail(`radancy.parseResults() title wrong: ${JSON.stringify(rows[0]?.title)}`);
  if (rows[0]?.url === 'https://careers.munichre.com/en/job/city/40548453568-slug/3193/40548453568' && rows[0]?.location === 'Bingen am Rhein, Germany') pass('radancy.parseResults() builds absolute URLs and extracts the location span');
  else fail(`radancy.parseResults() url/loc wrong: ${JSON.stringify(rows[0])}`);
  if (parseResults('<html>no items</html>', 'https://x').length === 0 && parseResults(undefined, 'https://x').length === 0) pass('radancy.parseResults() returns [] for item-less / non-string input');
  else fail('radancy.parseResults() should return [] without items');

  // decodeEntities (exercised via parseResults) — a malformed/out-of-range
  // numeric entity (a lone surrogate half) must degrade to the literal text,
  // never throw RangeError and abort the whole parse.
  const badEntityCard = card('999', 'Bad&#xD800;Entity', 'Berlin, Germany');
  const badRows = parseResults('<html>' + badEntityCard + '</html>', 'https://careers.munichre.com');
  if (badRows.length === 1 && badRows[0].title === 'Bad&#xD800;Entity') pass('radancy.parseResults() tolerates an invalid numeric entity (no RangeError crash)');
  else fail(`radancy.parseResults() should degrade a malformed entity to literal text, got: ${JSON.stringify(badRows)}`);

  // fetch — paginates ?p=N, stops when a page brings no fresh ids.
  const radPages = [html, '<html>' + card('111', 'C', 'Kiel, Germany') + '</html>', '<html></html>'];
  let radCalls = 0;
  const radSeen = [];
  const radCtx = { sleep: async () => {}, fetchText: async (url) => { radSeen.push(url); return radPages[radCalls++] ?? '<html></html>'; } };
  const radJobs = await radancy.fetch({ name: 'Munich Re', api: 'https://careers.munichre.com/en/search-jobs' }, radCtx);
  if (radJobs.length === 3 && radCalls === 3) pass('radancy.fetch() paginates and stops on the first empty page');
  else fail(`radancy.fetch() returned ${radJobs.length} jobs after ${radCalls} calls`);
  if (radSeen[0]?.endsWith('?p=1') && radSeen[1]?.endsWith('?p=2')) pass('radancy.fetch() pages via ?p=N (1-based)');
  else fail(`radancy.fetch() paged wrong: ${JSON.stringify(radSeen)}`);

  // fetch — a mid-scan failure preserves jobs already collected, never
  // discards earlier pages.
  let partialCalls = 0;
  const partialCtx = {
    sleep: async () => {},
    fetchText: async () => {
      partialCalls++;
      if (partialCalls === 1) return html; // 2 jobs
      throw new Error('network blip on page 2');
    },
  };
  const partialJobs = await radancy.fetch({ name: 'Munich Re', api: 'https://careers.munichre.com/en/search-jobs' }, partialCtx);
  if (partialJobs.length === 2 && partialCalls === 2) pass('radancy.fetch() preserves jobs from earlier pages when a later page fetch throws');
  else fail(`radancy.fetch() partial-failure handling wrong: ${partialJobs.length} jobs after ${partialCalls} calls`);

  // fetch — stops on a page whose ids are all already-seen (server clamped
  // ?p= to the last page, or looped), NOT just on a literally empty page.
  // fresh === 0 must halt pagination without appending duplicate jobs.
  const dupPage = '<html>' + card('40548453568', 'Innendienst f&#252;r Versicherungsagentur', 'Bingen am Rhein, Germany') + '</html>';
  const dupPages = [html, dupPage, '<html>' + card('999', 'Never reached', 'X') + '</html>'];
  let dupCalls = 0;
  const dupCtx = { sleep: async () => {}, fetchText: async () => dupPages[dupCalls++] ?? '<html></html>' };
  const dupJobs = await radancy.fetch({ name: 'Munich Re', api: 'https://careers.munichre.com/en/search-jobs' }, dupCtx);
  if (dupJobs.length === 2 && dupCalls === 2) pass('radancy.fetch() stops when a page brings only already-seen ids (fresh === 0), without appending duplicates');
  else fail(`radancy.fetch() duplicate-page stop wrong: ${dupJobs.length} jobs after ${dupCalls} calls`);

  const legacy = `
    <section id="search-results" data-total-results="2" data-total-pages="1">
      <li>
        <a href="/job/acton/patient-service-representative/34088/98479156752"
           data-job-id="98479156752">
          <h2>Patient Service Representative</h2>
          <span class="job-id job-info">1062355</span>
          <span class="job-location 1">Acton, Massachusetts</span>
        </a>
        <button class="js-save-job-btn" data-job-id="98479156752"></button>
      </li>
      <li>
        <a data-job-id="98187357488"
           href="/job/eden-prairie/principal-architect/34088/98187357488">
          <h2>Principal Architect &amp; Integration</h2>
          <span class="job-location">Eden Prairie, Minnesota</span>
        </a>
      </li>
    </section>`;

  const legacyRows = parseLegacyResults(legacy, 'https://careers.example.com');
  if (
    legacyRows.length === 2
    && legacyRows[0]?.title === 'Patient Service Representative'
    && legacyRows[0]?.location === 'Acton, Massachusetts'
    && legacyRows[1]?.title === 'Principal Architect & Integration'
  ) {
    pass('radancy.parseLegacyResults() handles legacy anchors without counting save buttons');
  } else {
    fail(`radancy.parseLegacyResults() legacy rows = ${JSON.stringify(legacyRows)}`);
  }
  if (
    parseModernResults(legacy, 'https://careers.example.com').length === 0
    && parseResults(legacy, 'https://careers.example.com').length === 2
  ) {
    pass('radancy.parseResults() falls back from modern to legacy markup');
  } else {
    fail('radancy.parseResults() legacy fallback failed');
  }
  if (
    parseLegacyResults(`${legacy}${legacy}`, 'https://careers.example.com').length === 2
    && parseLegacyResults('<a data-job-id="1">missing href</a>', 'https://x').length === 0
  ) {
    pass('radancy.parseLegacyResults() deduplicates ids and rejects malformed rows');
  } else {
    fail('radancy.parseLegacyResults() malformed/dedup guard failed');
  }

  const fragmentUrl = new URL(buildFragmentUrl('https://careers.example.com/search-jobs', 3));
  if (
    fragmentUrl.pathname === '/search-jobs/results'
    && fragmentUrl.searchParams.get('CurrentPage') === '3'
    && fragmentUrl.searchParams.get('RecordsPerPage') === '100'
    && fragmentUrl.searchParams.get('SearchResultsModuleName') === 'Search Results'
    && !fragmentUrl.searchParams.has('SearchFiltersModuleName')
  ) {
    pass('radancy.buildFragmentUrl() requests compact paged results without facet payloads');
  } else {
    fail(`radancy.buildFragmentUrl() = ${fragmentUrl.href}`);
  }
  const totals = readFragmentTotals(legacy);
  if (totals.totalResults === 2 && totals.totalPages === 1) {
    pass('radancy.readFragmentTotals() reads server pagination bounds');
  } else {
    fail(`radancy.readFragmentTotals() = ${JSON.stringify(totals)}`);
  }

  const fragmentCalls = [];
  const fragmentJobs = await radancy.fetch(
    { name: 'Legacy Co', api: 'https://careers.example.com/search-jobs' },
    {
      sleep: async () => {},
      fetchJson: async (url) => {
        fragmentCalls.push(url);
        return { results: legacy };
      },
      fetchText: async () => {
        throw new Error('heavy HTML fallback must not run');
      },
    },
  );
  if (
    fragmentJobs.length === 2
    && fragmentJobs.every(job => job.company === 'Legacy Co')
    && fragmentCalls.every(url => url.includes('/search-jobs/results'))
  ) {
    pass('radancy.fetch() prefers the compact JSON fragment transport');
  } else {
    fail(`radancy.fetch() fragment transport = ${JSON.stringify(fragmentJobs)}`);
  }

  let fallbackTextCalls = 0;
  const fallbackJobs = await radancy.fetch(
    { name: 'Modern Co', api: 'https://careers.munichre.com/en/search-jobs' },
    {
      sleep: async () => {},
      fetchJson: async () => {
        throw new Error('fragment unavailable');
      },
      fetchText: async () => (fallbackTextCalls++ === 0 ? html : '<html></html>'),
    },
  );
  if (fallbackJobs.length === 2 && fallbackTextCalls === 2) {
    pass('radancy.fetch() falls back to bounded HTML when fragments are unavailable');
  } else {
    fail(`radancy.fetch() fallback = ${fallbackJobs.length}/${fallbackTextCalls}`);
  }

  const cappedJobs = await radancy.fetch(
    {
      name: 'Legacy Co',
      api: 'https://careers.example.com/search-jobs',
      max_jobs: 1,
    },
    {
      sleep: async () => {},
      fetchJson: async () => ({
        results: legacy.replace('data-total-results="2"', 'data-total-results="1"'),
      }),
      fetchText: async () => {
        throw new Error('unused');
      },
    },
  );
  if (cappedJobs.length === 1) pass('radancy.fetch() enforces max_jobs on fragments');
  else fail(`radancy.fetch() max_jobs returned ${cappedJobs.length}`);
} catch (e) {
  fail(`radancy provider tests crashed: ${e.message}`);
}
