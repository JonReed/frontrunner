#!/usr/bin/env node

/**
 * cv-sync-check.mjs — Validates that the frontrunner setup is consistent.
 *
 * Checks:
 * 1. workspace/profile/cv.md exists
 * 2. workspace/profile/profile.yml exists and has required fields
 * 3. No hardcoded metrics in _shared.md or batch/batch-prompt.md
 * 4. workspace/profile/article-digest.md freshness (if exists)
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { ROOT as __dirname } from '#paths';
const projectRoot = __dirname;

const warnings = [];
const errors = [];

// 1. Check workspace/profile/cv.md exists
const cvPath = join(projectRoot, 'workspace/profile/cv.md');
if (!existsSync(cvPath)) {
  errors.push('workspace/profile/cv.md not found in project root. Create it with your CV in markdown format.');
} else {
  const cvContent = readFileSync(cvPath, 'utf-8');
  if (cvContent.trim().length < 100) {
    warnings.push('workspace/profile/cv.md seems too short. Make sure it contains your full CV.');
  }
}

// 2. Check profile.yml exists
const profilePath = join(projectRoot, 'workspace', 'profile', 'profile.yml');
if (!existsSync(profilePath)) {
  errors.push('workspace/profile/profile.yml not found. Copy from config/profile.example.yml and fill in your details.');
} else {
  const profileContent = readFileSync(profilePath, 'utf-8');
  const requiredFields = ['full_name', 'email', 'location'];
  for (const field of requiredFields) {
    if (!profileContent.includes(field) || profileContent.includes(`"Jane Smith"`)) {
      warnings.push(`workspace/profile/profile.yml may still have example data. Check field: ${field}`);
      break;
    }
  }
}

// 3. Check for hardcoded metrics in prompt files
const filesToCheck = [
  { path: join(projectRoot, 'modes', '_shared.md'), name: '_shared.md' },
  { path: join(projectRoot, 'batch', 'batch-prompt.md'), name: 'batch-prompt.md' },
];

// Pattern: numbers that look like hardcoded metrics (e.g., "170+ hours", "90% self-service")
const metricPattern = /\b\d{2,4}\+?\s*(hours?|%|evals?|layers?|tests?|fields?|bases?)\b/gi;

for (const { path, name } of filesToCheck) {
  if (!existsSync(path)) continue;
  const content = readFileSync(path, 'utf-8');

  // Skip lines that are clearly instructions (contain "NEVER hardcode" etc.)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('NEVER hardcode') || line.includes('NUNCA hardcode') || line.startsWith('#') || line.startsWith('<!--')) continue;
    const matches = line.match(metricPattern);
    if (matches) {
      warnings.push(`${name}:${i + 1} — Possible hardcoded metric: "${matches[0]}". Should this be read from workspace/profile/cv.md/article-digest.md?`);
    }
  }
}

// 4. Check workspace/profile/article-digest.md freshness
const digestPath = join(projectRoot, 'workspace/profile/article-digest.md');
if (existsSync(digestPath)) {
  const stats = statSync(digestPath);
  const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  if (daysSinceModified > 30) {
    warnings.push(`workspace/profile/article-digest.md is ${Math.round(daysSinceModified)} days old. Consider updating if your projects have new metrics.`);
  }
}

// Output results
console.log('\n=== frontrunner sync check ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('All checks passed.');
} else {
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`  ERROR: ${e}`));
  }
  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`  WARN: ${w}`));
  }
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);
