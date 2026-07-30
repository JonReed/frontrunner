#!/usr/bin/env node

/**
 * prepare-application.mjs — ATS auto-fill for Greenhouse, Ashby, and Lever.
 *
 * Detects the ATS from the apply URL, reads candidate data from
 * workspace/profile/profile.yml, and prints a prefill summary to stdout.
 * Never POSTs anything — the user reviews the output, opens the apply URL,
 * and submits themselves.
 *
 * Usage:
 *   node src/evaluate/prepare-application.mjs --url <apply_url> --pdf workspace/documents/<cv>.pdf
 *   node src/evaluate/prepare-application.mjs --url <apply_url> --pdf workspace/documents/<cv>.pdf --cover cover.txt
 *
 * Supported ATS:
 *   Greenhouse  boards.greenhouse.io / greenhouse.io
 *   Ashby       jobs.ashbyhq.com / ashbyhq.com
 *   Lever       jobs.(eu.)?lever.co / lever.co
 */

import { basename, resolve, relative, isAbsolute, join } from 'node:path';

import { OUTPUT_DIR, PROFILE_FILE, ROOT } from '#paths';
import { readBoundedRegularFileSync } from '../lib/safe-file-read.mjs';
const ALLOWED_HOSTS = new Set([
  'boards.greenhouse.io',
  'greenhouse.io',
  'jobs.ashbyhq.com',
  'ashbyhq.com',
  'jobs.lever.co',
  'jobs.eu.lever.co',
  'lever.co',
]);

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const applyUrl  = get('--url');
const pdfPath   = get('--pdf');
const coverPath = get('--cover');

if (!applyUrl || !pdfPath) {
  console.error('Usage: node src/evaluate/prepare-application.mjs --url <apply_url> --pdf <pdf_path> [--cover <cover_txt>]');
  process.exit(1);
}

// ── PDF validation ────────────────────────────────────────────────────

const outputDir = OUTPUT_DIR;
const absPdf    = resolve(ROOT, pdfPath);

const relPdf = relative(outputDir, absPdf);
if (relPdf === '' || relPdf.startsWith('..') || isAbsolute(relPdf)) {
  console.error(`Error: --pdf must point to a file inside workspace/documents/ (got ${pdfPath})`);
  process.exit(1);
}
let pdfBytes;
try {
  pdfBytes = readBoundedRegularFileSync(absPdf, {
    maxBytes: 25 * 1024 * 1024,
    encoding: null,
    label: 'PDF',
  });
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.error(`Error: PDF not found at ${pdfPath}`);
  } else {
    console.error(`Error: unsafe PDF at ${pdfPath}: ${error.message}`);
  }
  process.exit(1);
}
if (pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
  console.error(`Error: ${pdfPath} does not contain a PDF file`);
  process.exit(1);
}

// ── URL validation ────────────────────────────────────────────────────

let parsedUrl;
try {
  parsedUrl = new URL(applyUrl);
} catch {
  console.error(`Error: invalid URL: ${applyUrl}`);
  process.exit(1);
}

if (parsedUrl.protocol !== 'https:') {
  console.error(`Error: URL must use https (got ${parsedUrl.protocol})`);
  process.exit(1);
}

if (!ALLOWED_HOSTS.has(parsedUrl.hostname)) {
  console.error(`Error: "${parsedUrl.hostname}" is not a supported ATS host.`);
  console.error(`Supported: ${[...ALLOWED_HOSTS].join(', ')}`);
  process.exit(1);
}

// ── ATS detection ─────────────────────────────────────────────────────

const SAFE_SLUG = /^[a-zA-Z0-9._-]+$/;

/**
 * @param {URL} url
 * @returns {{ ats: string, companySlug: string, jobId: string } | null}
 */
function detectAts(url) {
  const path = url.pathname;
  const GH  = new Set(['boards.greenhouse.io', 'greenhouse.io']);
  const ASH = new Set(['jobs.ashbyhq.com', 'ashbyhq.com']);
  const LEV = new Set(['jobs.lever.co', 'jobs.eu.lever.co', 'lever.co']);

  const gh = path.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (gh && GH.has(url.hostname)) {
    const [, company, jobId] = gh;
    if (!SAFE_SLUG.test(company)) return null;
    return { ats: 'greenhouse', companySlug: company, jobId };
  }

  const seg = path.match(/^\/([^/]+)\/([^/?#]+)/);
  if (seg && ASH.has(url.hostname)) {
    const [, company, jobId] = seg;
    if (!SAFE_SLUG.test(company) || !SAFE_SLUG.test(jobId)) return null;
    return { ats: 'ashby', companySlug: company, jobId };
  }

  if (seg && LEV.has(url.hostname)) {
    const [, company, jobId] = seg;
    if (!SAFE_SLUG.test(company) || !SAFE_SLUG.test(jobId)) return null;
    return { ats: 'lever', companySlug: company, jobId };
  }

  return null;
}

// ── Profile reader ────────────────────────────────────────────────────

function readProfile() {
  const raw = readBoundedRegularFileSync(PROFILE_FILE, {
    maxBytes: 1024 * 1024,
    allowMissing: true,
    label: 'workspace/profile/profile.yml',
  });
  if (raw === null) return {};

  const pick = (key) => {
    const m = raw.match(new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
    return m ? m[1].trim() : '';
  };

  const fullName = pick('full_name');
  const [firstName, ...rest] = fullName.split(' ');
  return {
    firstName:    firstName || '',
    lastName:     rest.join(' ') || '',
    email:        pick('email'),
    phone:        pick('phone'),
    location:     pick('location'),
    linkedin:     pick('linkedin'),
    portfolioUrl: pick('portfolio_url'),
  };
}

// ── Cover letter reader (optional) ────────────────────────────────────

function readCover() {
  if (!coverPath) return null;
  const abs = resolve(ROOT, coverPath);
  const rel = relative(outputDir, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`--cover must point to a file inside workspace/documents/ (got ${coverPath})`);
  }
  const text = readBoundedRegularFileSync(abs, {
    maxBytes: 1024 * 1024,
    label: 'cover letter',
  }).trim();
  return { text, wordCount: text.split(/\s+/).filter(Boolean).length };
}

// ── Field maps per ATS ────────────────────────────────────────────────

function buildGreenhouseFields(profile, cover, pdfFile) {
  return [
    ['first_name',   profile.firstName],
    ['last_name',    profile.lastName],
    ['email',        profile.email],
    ['phone',        profile.phone],
    ['resume',       `${pdfFile}  ← attach this file`],
    cover ? ['cover_letter', `${cover.wordCount} words — ${cover.text.slice(0, 80).replace(/\n/g, ' ')}…`] : null,
    profile.linkedin     ? ['linkedin_profile', profile.linkedin]     : null,
    profile.portfolioUrl ? ['website',          profile.portfolioUrl] : null,
  ].filter(Boolean);
}

function buildAshbyFields(profile, cover, pdfFile) {
  return [
    ['firstName', profile.firstName],
    ['lastName',  profile.lastName],
    ['email',     profile.email],
    ['phone',     profile.phone],
    ['resume',    `${pdfFile}  ← attach this file`],
    cover ? ['coverLetter', `(${cover.wordCount} words — paste from cover file)`] : null,
    profile.linkedin ? ['linkedInUrl', profile.linkedin] : null,
  ].filter(Boolean);
}

function buildLeverFields(profile, cover, pdfFile) {
  return [
    ['name',   `${profile.firstName} ${profile.lastName}`.trim()],
    ['email',  profile.email],
    ['phone',  profile.phone],
    ['resume', `${pdfFile}  ← attach this file`],
    cover ? ['comments', `(${cover.wordCount} words — paste from cover file)`] : null,
    profile.linkedin     ? ['urls[LinkedIn]',  profile.linkedin]     : null,
    profile.portfolioUrl ? ['urls[Portfolio]', profile.portfolioUrl] : null,
  ].filter(Boolean);
}

// ── Main ──────────────────────────────────────────────────────────────

const detected = detectAts(parsedUrl);
if (!detected) {
  console.error(`Error: URL not recognized as Greenhouse, Ashby, or Lever.\n  URL: ${applyUrl}`);
  process.exit(1);
}

const { ats, companySlug, jobId } = detected;
const pdfFile   = basename(absPdf);
const pdfSizeKb = (pdfBytes.byteLength / 1024).toFixed(1);
const profile   = readProfile();
const cover     = readCover();

let fields;
if (ats === 'greenhouse') fields = buildGreenhouseFields(profile, cover, pdfFile);
if (ats === 'ashby')      fields = buildAshbyFields(profile, cover, pdfFile);
if (ats === 'lever')      fields = buildLeverFields(profile, cover, pdfFile);

const labelWidth = Math.max(...fields.map(([k]) => k.length)) + 2;
const atsLabel   = ats.charAt(0).toUpperCase() + ats.slice(1);

console.log(`\n── ${atsLabel} · ${companySlug} · job ${jobId} ${'─'.repeat(20)}`);
console.log();
for (const [key, value] of fields) {
  console.log(`  ${key.padEnd(labelWidth)}${value || '(not set — check workspace/profile/profile.yml)'}`);
}
console.log(`\n  PDF     ${pdfFile} (${pdfSizeKb} KB)`);
if (cover) console.log(`  Cover   ${coverPath} (${cover.wordCount} words)`);
console.log('\n── Next step ' + '─'.repeat(38));
console.log(`  Open:   ${applyUrl}`);
console.log('  Fill the form using the values above, attach the PDF, then submit.');
console.log();
