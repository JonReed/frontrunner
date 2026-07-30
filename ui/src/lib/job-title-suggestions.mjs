/**
 * Extract job-title suggestions from CV text without a model call.
 *
 * These are suggestions, never profile facts: onboarding asks which roles the
 * user would take now, and a title they held previously is useful evidence but
 * not consent to target it again. The UI therefore offers each result as an
 * explicit choice instead of silently filling the target-role field.
 */

const ROLE_WORD =
  /\b(?:administrator|analyst|architect|associate|chair|chief|consultant|controller|coordinator|designer|developer|director|engineer|executive|founder|head|lead|manager|officer|operator|owner|partner|planner|president|principal|producer|researcher|scientist|specialist|strategist|supervisor|technician|vice president|vp)\b/iu;

const EXPERIENCE_HEADING =
  /^(?:professional\s+)?(?:career|employment|experience|work history|work experience)$/iu;
const STOP_HEADING =
  /^(?:awards?|certifications?|education|interests?|languages?|memberships?|personal|projects?|publications?|qualifications?|references?|skills?|training)$/iu;
const DATEISH =
  /(?:\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|present|current)\b)/iu;
const CONTACT_OR_LINK = /@|https?:\/\/|www\.|linkedin\.com/iu;
const SECTION_LABEL =
  /^(?:career|employment|experience|professional experience|work history|work experience)$/iu;

function plainLine(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function plausibleTitle(value) {
  if (!value || value.length > 80 || CONTACT_OR_LINK.test(value) || DATEISH.test(value)) return false;
  if (SECTION_LABEL.test(value) || STOP_HEADING.test(value)) return false;
  if (/[.!?]$/u.test(value)) return false;

  const words = value.match(/[\p{L}\p{N}&/+.-]+/gu) ?? [];
  if (words.length === 0 || words.length > 10) return false;
  return ROLE_WORD.test(value);
}

function candidates(line) {
  const clean = plainLine(line);
  if (!clean) return [];
  const segments = clean.split(/\s+(?:\||—|–)\s+/u);

  // Most CVs put company, role and dates on one line separated by a pipe or
  // dash. Considering both the whole line and its bounded segments supports
  // that layout without trying to guess which segment is the company. The
  // unsplit line is considered only when there was no separator, otherwise
  // "Acme — Product Director" would be offered alongside "Product Director".
  return (segments.length > 1 ? segments : [clean])
    .map((part) => part.replace(/^(?:role|position|title)\s*:\s*/iu, '').trim())
    .filter(plausibleTitle)
    .sort((a, b) => a.length - b.length);
}

export function suggestJobTitles(cvText, limit = 8) {
  if (typeof cvText !== 'string' || !cvText.trim() || limit <= 0) return [];

  const suggestions = [];
  const seen = new Set();
  let inExperience = false;

  for (const raw of cvText.split(/\r?\n/u)) {
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/u);
    const label = plainLine(heading?.[1] ?? raw);
    if (EXPERIENCE_HEADING.test(label)) {
      inExperience = true;
      continue;
    }
    if (inExperience && STOP_HEADING.test(label)) break;

    // Outside an explicitly marked experience section, only accept markdown
    // headings. This still supports compact CVs while avoiding skill bullets
    // such as "engineering leadership" being presented as held job titles.
    if (!inExperience && !heading) continue;
    if (/^\s*[-*+]\s+/u.test(raw)) continue;

    for (const title of candidates(raw)) {
      const key = title.toLocaleLowerCase('en');
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(title);
      if (suggestions.length === limit) return suggestions;
    }
  }

  return suggestions;
}
