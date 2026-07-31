/**
 * Shared contract for model-suggested employers.
 *
 * The narrowest of the three model contracts in this directory, because it is
 * the only one whose output is not shown to an employer — it is a shortlist of
 * company names the user then chooses from. What it must not do is decide
 * anything: the model proposes names, the person picks, and deterministic code
 * resolves each pick to a real job board and writes the file.
 *
 * WHY A NAME AND A REASON, AND NOTHING ELSE. The obvious temptation is to let
 * the model return the careers URL or the ATS slug it "knows". That would put
 * a model-generated host into the list of places this installation connects
 * to, which is exactly the boundary the rest of the project holds. The
 * resolver already finds the real board from a name by probing public APIs, so
 * the model is asked only for the part it is actually good at.
 *
 * The reason exists so the user can judge the suggestion. "Retailer of a
 * similar size in your area" is checkable; a bare list of names is not.
 */

import {
  tailoringCvContext,
  tailoringProfileContext,
} from './tailoring-contract.mjs';

export const COMPANY_CONTRACT_VERSION = '1.0';
export const MAX_COMPANY_RESPONSE_BYTES = 64 * 1024;

/** Matches the ceiling the application contract enforces on a follow request. */
const MAX_SUGGESTIONS = 20;
const MAX_NAME = 80;
const MAX_REASON = 200;

export const COMPANY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'companies'],
  properties: {
    version: { const: COMPANY_CONTRACT_VERSION },
    companies: {
      type: 'array',
      maxItems: MAX_SUGGESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'why'],
        properties: {
          name: { type: 'string', maxLength: MAX_NAME },
          why: { type: 'string', maxLength: MAX_REASON },
        },
      },
    },
  },
};

function companyError(message) {
  const error = new Error(message);
  error.code = 'INVALID_COMPANY_RESPONSE';
  return error;
}

function cleanText(value, field, maxLength) {
  if (typeof value !== 'string') throw companyError(`${field} must be a string`);
  if (value.length > maxLength) throw companyError(`${field} exceeds ${maxLength} characters`);
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The same shape the application contract will accept as a company name.
 *
 * Duplicated deliberately rather than imported: this module is about what a
 * model may return, that one is about what may become a command argument, and
 * collapsing them would mean loosening one to suit the other later. A name
 * that fails here is dropped rather than rejecting the whole response — one
 * odd suggestion in twenty should not cost the user the other nineteen.
 */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'’()+/-]*$/u;

export function parseCompanyResponse(raw) {
  if (typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') > MAX_COMPANY_RESPONSE_BYTES) {
    throw companyError('company response is too large');
  }
  const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw companyError('company response must be an object');
  }
  if (source.version !== COMPANY_CONTRACT_VERSION) {
    throw companyError(`company response must use contract ${COMPANY_CONTRACT_VERSION}`);
  }
  if (!Array.isArray(source.companies)) {
    throw companyError('company response must contain a companies list');
  }

  const seen = new Set();
  const companies = [];
  for (const entry of source.companies.slice(0, MAX_SUGGESTIONS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = cleanText(entry.name, 'company.name', MAX_NAME);
    if (!name || !NAME_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({ name, why: cleanText(entry.why ?? '', 'company.why', MAX_REASON) });
  }
  return { version: COMPANY_CONTRACT_VERSION, companies };
}

/**
 * @param {object} options
 * @param {string} options.cv           Authoritative CV markdown.
 * @param {string} options.profile      Authoritative profile YAML.
 * @param {string[]} options.following  Employers already followed, to skip.
 * @param {string[]} options.keywords   The user's own title filters.
 * @param {string} options.location     Where they are looking.
 */
export function buildCompanySystemPrompt({
  cv = '',
  profile = '',
  following = [],
  keywords = [],
  location = '',
} = {}) {
  const list = (values) => (values.length ? values.join(', ') : '[none given]');
  return `You are the judgement component of Frontrunner employer discovery.
Return JSON only, matching company contract ${COMPANY_CONTRACT_VERSION}.
Do not add keys outside the contract.

Suggest real, currently-operating employers this candidate could plausibly work
for, based on the sectors, employer types and seniority evidenced in their own
CV and profile. Prefer organisations that employ people in the roles below, in
or near the stated location.

Return the employer's ordinary name only — never a URL, a careers page, a
domain, an ATS slug, or any other address. Frontrunner finds the job board
itself. Do not invent organisations: if you are not confident an employer
exists under that name, leave it out. A short list of real employers is worth
more than a long list containing inventions.

Do not repeat any employer in ALREADY FOLLOWED.
Give at most 15 suggestions. For each, one short reason the candidate can
check — the sector, size or location that makes it relevant.

REQUIRED JSON SCHEMA:
${JSON.stringify(COMPANY_JSON_SCHEMA)}

ROLES THEY ARE LOOKING FOR:
${list(keywords)}

WHERE THEY ARE LOOKING:
${location || '[not given]'}

ALREADY FOLLOWED:
${list(following)}

AUTHORITATIVE CV:
${tailoringCvContext(cv, profile)}

AUTHORITATIVE PROFILE:
${tailoringProfileContext(profile)}`;
}
