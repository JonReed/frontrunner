/**
 * Read conservative contact suggestions from the beginning of a CV.
 *
 * Nothing here is authoritative. The setup screen presents these values for
 * review before they can be saved, and it never uses a model or sends the CV
 * away. Email is exact; name and location are intentionally limited to common
 * CV-header forms rather than guessed from arbitrary prose.
 */

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const LINK = /https?:\/\/|www\.|linkedin\.com/iu;
const PHONEISH = /(?:\+?\d[\d\s().-]{7,}\d)/u;
const ROLE_WORD =
  /\b(?:analyst|architect|consultant|designer|developer|director|engineer|executive|founder|head|lead|manager|officer|owner|partner|president|principal|researcher|scientist|specialist|vice president|vp)\b/iu;
const DOCUMENT_LABEL =
  /^(?:curriculum vitae|cv|profile|professional profile|résumé|resume|summary)$/iu;
const LOCATION_LABEL = /^(?:based(?:\s+in)?|location)\s*[:—–-]\s*(.+)$/iu;
const LOCATION_WORD =
  /\b(?:australia|austria|belgium|canada|denmark|england|finland|france|germany|india|ireland|italy|netherlands|norway|poland|portugal|scotland|spain|sweden|switzerland|uk|united kingdom|united states|usa|wales)\b/iu;

function plain(value) {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function usableName(value) {
  if (!value || value.length > 70 || EMAIL.test(value) || LINK.test(value) || /\d/u.test(value)) {
    return false;
  }
  if (DOCUMENT_LABEL.test(value) || ROLE_WORD.test(value) || /[:;,]/u.test(value)) return false;
  const words = value.match(/[\p{L}'’-]+/gu) ?? [];
  return words.length >= 2 && words.length <= 5 && words.join(' ').length === value.length;
}

function locationCandidate(value) {
  const clean = plain(value).replace(EMAIL, '').trim();
  if (!clean || clean.length > 80 || LINK.test(clean) || PHONEISH.test(clean)) return null;

  const labelled = clean.match(LOCATION_LABEL);
  if (labelled) return plain(labelled[1]).replace(/[|·]+$/u, '').trim() || null;

  const words = clean.match(/[\p{L}\p{N}'’.-]+/gu) ?? [];
  if (words.length === 0 || words.length > 8) return null;
  if (!clean.includes(',') && !LOCATION_WORD.test(clean)) return null;
  if (ROLE_WORD.test(clean)) return null;
  return clean;
}

export function suggestCvContact(cvText) {
  if (typeof cvText !== 'string' || !cvText.trim()) {
    return { name: null, email: null, location: null };
  }

  const headerLines = cvText.split(/\r?\n/u).slice(0, 14).map(plain).filter(Boolean);
  const email = headerLines.join('\n').match(EMAIL)?.[0] ?? null;

  let name = null;
  for (const line of headerLines.slice(0, 5)) {
    const firstSegment = plain(line.split(/\s+(?:\||·|—|–)\s+/u)[0]);
    if (usableName(firstSegment)) {
      name = firstSegment;
      break;
    }
  }

  let location = null;
  for (const line of headerLines) {
    const labelled = locationCandidate(line);
    if (LOCATION_LABEL.test(line) && labelled) {
      location = labelled;
      break;
    }
  }
  if (!location) {
    for (const line of headerLines) {
      for (const segment of line.split(/\s+(?:\||·|—|–)\s+/u)) {
        const candidate = locationCandidate(segment);
        if (candidate && candidate !== name) {
          location = candidate;
          break;
        }
      }
      if (location) break;
    }
  }

  return { name, email, location };
}
