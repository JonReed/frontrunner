/**
 * Runtime boundary for hostile provider output.
 *
 * Provider adapters are reviewed code, but everything they parse is remote
 * attacker-controlled data. Every core consumer must call fetchProviderJobs()
 * rather than provider.fetch() directly so one bounded, closed Job schema is
 * enforced independently of adapter quality.
 */

import { normalizeJobText, MAX_JOB_DOCUMENT_CHARS } from '../src/security/job-document.mjs';

export const PROVIDER_CONTRACT_LIMITS = Object.freeze({
  maxJobs: 5_000,
  maxDescriptionChars: MAX_JOB_DOCUMENT_CHARS,
  maxDescriptionCharsPerFetch: 2_000_000,
  maxTitleChars: 500,
  maxUrlChars: 4_096,
  maxCompanyChars: 300,
  maxLocationChars: 1_000,
  maxNoteChars: 1_000,
});

const ARRAY_FLAGS = Object.freeze([
  'workdayTruncated',
  'workdayNoDateSkip',
  'icimsTruncated',
]);
const EARLIEST_POSTED_AT = Date.UTC(1990, 0, 1);
const LATEST_POSTED_AT_OFFSET_MS = 7 * 24 * 60 * 60 * 1_000;

export class ProviderContractError extends Error {
  constructor(providerId, message) {
    super(`${providerId}: provider contract violation — ${message}`);
    this.name = 'ProviderContractError';
    this.providerId = providerId;
  }
}

function boundedString(value, maxChars, { required = false } = {}) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return required ? null : '';
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars - 1)}…`
    : normalized;
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || value.trim().length > PROVIDER_CONTRACT_LIMITS.maxUrlChars) {
    return null;
  }
  const text = boundedString(value, PROVIDER_CONTRACT_LIMITS.maxUrlChars, { required: true });
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return text;
}

function normalizeSalary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const salary = {};
  for (const key of ['min', 'max']) {
    const amount = value[key];
    if (typeof amount === 'number' && Number.isFinite(amount)
      && amount >= 0 && amount <= 1_000_000_000) {
      salary[key] = amount;
    }
  }
  const currency = typeof value.currency === 'string'
    ? value.currency.trim().toUpperCase()
    : '';
  if (/^[A-Z]{3}$/.test(currency)) salary.currency = currency;
  return Object.keys(salary).length ? salary : null;
}

function increment(reasons, reason) {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function normalizeJob(raw, entry, state) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    increment(state.droppedReasons, 'not_object');
    return null;
  }
  try {
    const title = boundedString(raw.title, PROVIDER_CONTRACT_LIMITS.maxTitleChars, { required: true });
    if (!title) {
      increment(state.droppedReasons, 'invalid_title');
      return null;
    }
    const url = normalizeUrl(raw.url);
    if (!url) {
      increment(state.droppedReasons, 'invalid_url');
      return null;
    }
    if (state.urls.has(url)) {
      increment(state.droppedReasons, 'duplicate_url');
      return null;
    }

    const fallbackCompany = typeof entry?.name === 'string' ? entry.name : '';
    const company = boundedString(
      typeof raw.company === 'string' && raw.company.trim() ? raw.company : fallbackCompany,
      PROVIDER_CONTRACT_LIMITS.maxCompanyChars,
    );
    const job = {
      title,
      url,
      company,
      location: boundedString(raw.location, PROVIDER_CONTRACT_LIMITS.maxLocationChars),
    };

    if (typeof raw.description === 'string' && raw.description.trim()) {
      const remaining = PROVIDER_CONTRACT_LIMITS.maxDescriptionCharsPerFetch - state.descriptionChars;
      if (remaining > 0) {
        const description = normalizeJobText(raw.description, {
          maxChars: Math.min(PROVIDER_CONTRACT_LIMITS.maxDescriptionChars, remaining),
        });
        if (description) {
          job.description = description;
          state.descriptionChars += description.length;
        }
      } else {
        state.descriptionBudgetExhausted = true;
      }
    }

    if (typeof raw.postedAt === 'number'
      && Number.isFinite(raw.postedAt)
      && raw.postedAt >= EARLIEST_POSTED_AT
      && raw.postedAt <= Date.now() + LATEST_POSTED_AT_OFFSET_MS) {
      job.postedAt = Math.trunc(raw.postedAt);
    }

    const salary = normalizeSalary(raw.salary);
    if (salary) job.salary = salary;
    const note = boundedString(raw.note, PROVIDER_CONTRACT_LIMITS.maxNoteChars);
    if (note) job.note = note;

    state.urls.add(url);
    return job;
  } catch {
    increment(state.droppedReasons, 'unreadable_record');
    return null;
  }
}

/**
 * Invalid individual rows are dropped with telemetry; a non-array result fails
 * the whole source because treating it as empty would hide an adapter bug.
 */
export function enforceProviderResult(providerId, rawJobs, entry = {}) {
  const id = typeof providerId === 'string' && providerId ? providerId : 'unknown-provider';
  let isArray = false;
  try {
    isArray = Array.isArray(rawJobs);
  } catch {
    // Revoked proxies and similarly hostile values can throw during the check.
  }
  if (!isArray) {
    throw new ProviderContractError(id, 'fetch() must return an array');
  }
  let rawLength;
  try {
    rawLength = rawJobs.length;
  } catch {
    throw new ProviderContractError(id, 'fetch() returned an unreadable array');
  }
  if (!Number.isSafeInteger(rawLength) || rawLength < 0) {
    throw new ProviderContractError(id, 'fetch() returned an array with an invalid length');
  }
  const state = {
    urls: new Set(),
    droppedReasons: {},
    descriptionChars: 0,
    descriptionBudgetExhausted: false,
  };
  const inputJobs = Math.min(rawLength, PROVIDER_CONTRACT_LIMITS.maxJobs);
  if (rawLength > inputJobs) {
    state.droppedReasons.result_limit = rawLength - inputJobs;
  }
  const jobs = [];
  for (let index = 0; index < inputJobs; index++) {
    let raw;
    try {
      raw = rawJobs[index];
    } catch {
      increment(state.droppedReasons, 'unreadable_record');
      continue;
    }
    const normalized = normalizeJob(raw, entry, state);
    if (normalized) jobs.push(normalized);
  }

  for (const flag of ARRAY_FLAGS) {
    try {
      if (rawJobs[flag] === true) {
        Object.defineProperty(jobs, flag, { value: true, enumerable: false });
      }
    } catch {
      // Array metadata is advisory. Hostile access cannot invalidate safe rows.
    }
  }

  const telemetry = Object.freeze({
    providerId: id,
    input: rawLength,
    accepted: jobs.length,
    dropped: rawLength - jobs.length,
    droppedReasons: Object.freeze({ ...state.droppedReasons }),
    truncated: rawLength > PROVIDER_CONTRACT_LIMITS.maxJobs,
    descriptionChars: state.descriptionChars,
    descriptionBudgetExhausted: state.descriptionBudgetExhausted,
  });
  Object.defineProperty(jobs, 'providerContract', {
    value: telemetry,
    enumerable: false,
  });
  return jobs;
}

export async function fetchProviderJobs(provider, entry, ctx) {
  if (!provider || typeof provider.fetch !== 'function') {
    throw new ProviderContractError(provider?.id ?? 'unknown-provider', 'provider has no fetch() function');
  }
  const rawJobs = await provider.fetch(entry, ctx);
  const jobs = enforceProviderResult(provider.id, rawJobs, entry);
  const report = jobs.providerContract;
  if (report.dropped > 0 || report.descriptionBudgetExhausted) {
    const reasons = Object.entries(report.droppedReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(',');
    console.error(
      `⚠️  ${report.providerId}: provider output bounded`
      + ` (accepted=${report.accepted}, dropped=${report.dropped}`
      + `${reasons ? `, reasons=${reasons}` : ''}`
      + `${report.descriptionBudgetExhausted ? ', description_budget_exhausted=true' : ''})`,
    );
  }
  return jobs;
}
