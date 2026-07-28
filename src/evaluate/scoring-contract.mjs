/**
 * Frontrunner scoring contract.
 *
 * The model supplies structured judgement and evidence. Code owns presentation,
 * score-dependent verbosity, tracker fields, and the machine-readable footer.
 */

export const SCORING_CONTRACT_VERSION = '1.0';

const LEGITIMACY = new Set(['High Confidence', 'Proceed with Caution', 'Suspicious']);
const DIMENSIONS = ['cvMatch', 'northStar', 'comp', 'culture', 'redFlags'];

export function buildScoringPrompt({ cv = '', profile = '', profileMode = '', languageInstruction = '' } = {}) {
  return `You are the judgement component of Frontrunner.
Return JSON only. Do not render Markdown and do not add keys outside the contract.

SCORING_CONTRACT_VERSION: ${SCORING_CONTRACT_VERSION}

Score each dimension from 1 to 5:
- cvMatch: requirements supported by explicit candidate evidence
- northStar: alignment with target roles and direction
- comp: advertised compensation versus the candidate target; use null when absent
- culture: explicit culture/structure/remote evidence; use 3 when genuinely unknown
- redFlags: 5 means no material red flags, 1 means severe blockers

The overall score must be a reasoned weighted judgement from 1 to 5. Posting
legitimacy is separate and must not change the overall score. Never invent
candidate evidence. Unknown facts must be null or listed as unknown.

Required JSON shape:
{
  "version": "${SCORING_CONTRACT_VERSION}",
  "company": "string",
  "role": "string",
  "archetype": "string",
  "overallScore": 1.0,
  "recommendation": "string",
  "dimensions": {
    "cvMatch": {"score": 1.0, "evidence": ["string"]},
    "northStar": {"score": 1.0, "evidence": ["string"]},
    "comp": {"score": null, "evidence": ["string"]},
    "culture": {"score": 1.0, "evidence": ["string"]},
    "redFlags": {"score": 1.0, "evidence": ["string"]}
  },
  "requirements": [{"requirement": "string", "status": "matched|partial|gap|unknown", "evidence": "string"}],
  "risks": ["string"],
  "customization": ["string"],
  "interview": [{"question": "string", "evidenceToUse": "string"}],
  "legitimacy": {"tier": "High Confidence|Proceed with Caution|Suspicious", "signals": ["string"]},
  "keywords": ["string"]
}

OUTPUT LANGUAGE:
${languageInstruction || 'Use the language requested by the candidate profile.'}

CANDIDATE PROFILE:
${profile}

TARGETING RULES:
${profileMode}

CV — the only source of candidate claims:
${cv}`;
}

function finiteScore(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    throw new Error(`${field} must be a number between 1 and 5${nullable ? ', or null' : ''}`);
  }
  return Math.round(n * 10) / 10;
}

function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
}

export function parseScoringResponse(raw) {
  const unfenced = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(unfenced);
  } catch {
    throw new Error('model response is not valid scoring-contract JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('model response must be a JSON object');
  }
  if (value.version !== SCORING_CONTRACT_VERSION) {
    throw new Error(`unsupported scoring contract version: ${value.version ?? 'missing'}`);
  }
  for (const field of ['company', 'role', 'archetype', 'recommendation']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`${field} is required`);
  }
  if (!value.dimensions || typeof value.dimensions !== 'object') throw new Error('dimensions is required');

  const dimensions = {};
  for (const name of DIMENSIONS) {
    const dimension = value.dimensions[name];
    if (!dimension || typeof dimension !== 'object') throw new Error(`dimensions.${name} is required`);
    dimensions[name] = {
      score: finiteScore(dimension.score, `dimensions.${name}.score`, { nullable: name === 'comp' }),
      evidence: strings(dimension.evidence),
    };
  }

  const tier = value.legitimacy?.tier;
  if (!LEGITIMACY.has(tier)) throw new Error('legitimacy.tier is invalid');

  return {
    version: value.version,
    company: value.company.trim(),
    role: value.role.trim(),
    archetype: value.archetype.trim(),
    overallScore: finiteScore(value.overallScore, 'overallScore'),
    recommendation: value.recommendation.trim(),
    dimensions,
    requirements: Array.isArray(value.requirements) ? value.requirements
      .filter((r) => r && typeof r.requirement === 'string')
      .map((r) => ({
        requirement: r.requirement.trim(),
        status: ['matched', 'partial', 'gap', 'unknown'].includes(r.status) ? r.status : 'unknown',
        evidence: typeof r.evidence === 'string' ? r.evidence.trim() : '',
      })) : [],
    risks: strings(value.risks),
    customization: strings(value.customization),
    interview: Array.isArray(value.interview) ? value.interview
      .filter((r) => r && typeof r.question === 'string')
      .map((r) => ({
        question: r.question.trim(),
        evidenceToUse: typeof r.evidenceToUse === 'string' ? r.evidenceToUse.trim() : '',
      })) : [],
    legitimacy: { tier, signals: strings(value.legitimacy?.signals) },
    keywords: strings(value.keywords),
  };
}

const bullets = (items, empty = 'Not enough evidence.') =>
  items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`;

function evidenceLine(dimension) {
  const score = dimension.score === null ? 'unknown' : `${dimension.score}/5`;
  return `**Score:** ${score}\n${bullets(dimension.evidence)}`;
}

export function renderEvaluationReport(result) {
  const compact = result.overallScore < 4;
  const requirements = compact ? result.requirements.slice(0, 6) : result.requirements;
  const risks = compact ? result.risks.slice(0, 4) : result.risks;
  const customization = compact ? result.customization.slice(0, 4) : result.customization;
  const interview = compact ? result.interview.slice(0, 4) : result.interview;
  const signals = compact ? result.legitimacy.signals.slice(0, 4) : result.legitimacy.signals;

  return `## Block A — Decision

**Recommendation:** ${result.recommendation}
**Overall score:** ${result.overallScore.toFixed(1)}/5
**Archetype:** ${result.archetype}

## Block B — CV match

${evidenceLine(result.dimensions.cvMatch)}

${requirements.length ? requirements.map((r) => `- **${r.status}:** ${r.requirement}${r.evidence ? ` — ${r.evidence}` : ''}`).join('\n') : '- No requirements extracted.'}

## Block C — Direction and level

${evidenceLine(result.dimensions.northStar)}

## Block D — Compensation and culture

### Compensation
${evidenceLine(result.dimensions.comp)}

### Culture
${evidenceLine(result.dimensions.culture)}

## Block E — Risks and customization

### Risks
${bullets(risks)}

### Tailoring actions
${bullets(customization)}

## Block F — Interview preparation

${interview.length ? interview.map((i) => `- ${i.question}${i.evidenceToUse ? ` — use: ${i.evidenceToUse}` : ''}`).join('\n') : '- No interview prompts proposed.'}

## Block G — Posting legitimacy

**Legitimacy:** ${result.legitimacy.tier}
${bullets(signals)}

---SCORE_SUMMARY---
COMPANY: ${result.company}
ROLE: ${result.role}
SCORE: ${result.overallScore.toFixed(1)}
ARCHETYPE: ${result.archetype}
LEGITIMACY: ${result.legitimacy.tier}
CONTRACT_VERSION: ${result.version}
---END_SUMMARY---`;
}
