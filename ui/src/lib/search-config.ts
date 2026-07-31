/**
 * search-config.ts — bounded UI adapter for the search-configuration writer.
 *
 * Same shape as jobs.ts and profile-save.ts, for the same reason: Turbopack
 * stays rooted inside ui/, so no backend module is bundled into Next.js. One
 * fixed controller script, bounded JSON over stdin.
 *
 * Nothing here decides where anything is written, and nothing here can name a
 * company's careers URL or API endpoint — a request selects a list to change
 * or a company to switch off, never a host to talk to.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const SEARCH_CONTROL = join(ROOT, 'src', 'application', 'search-control.mjs');
const RESPONSE_LIMIT = 512 * 1024;
const RESPONSE_TIMEOUT_MS = 15_000;

export interface SearchCompany {
  name: string;
  enabled: boolean;
}

export interface SearchConfig {
  exists: boolean;
  /**
   * True when the settings exist but could not be read.
   *
   * Distinct from `exists: false` because the remedies are opposite: a missing
   * file is created with one click, while a malformed one must not be — the
   * screen would offer a button that cannot help, and pressing it would return
   * the same screen indefinitely.
   */
  unreadable: boolean;
  keywords: string[];
  excluded: string[];
  locations: string[];
  blockedLocations: string[];
  companies: SearchCompany[];
}

export interface SetupAnswers {
  roles: string[];
  location: string;
  remote: string;
}

const EMPTY: SearchConfig = {
  exists: false,
  unreadable: false,
  keywords: [],
  excluded: [],
  locations: [],
  blockedLocations: [],
  companies: [],
};

function controllerError(stderr: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error.slice(0, 1_000);
  } catch {
    // Fall through to the bounded generic transport failure.
  }
  return fallback;
}

function invokeSearchControl(payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SEARCH_CONTROL], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    const consume = () => {
      const newline = stdout.indexOf('\n');
      if (newline < 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch {
        child.kill('SIGTERM');
        reject(new Error('The secure backend returned an invalid response.'));
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > RESPONSE_LIMIT) {
        child.kill('SIGTERM');
        fail('The secure backend returned too much data.');
        return;
      }
      consume();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.once('error', (error) => fail(error.message));
    child.once('close', (code) => {
      consume();
      if (!settled) {
        fail(controllerError(
          stderr,
          `The secure backend stopped before responding (exit ${String(code)}).`,
        ));
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The secure backend did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify(payload));
  });
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Never throws. Every screen that reads this also has something useful to show
 * without it, and a settings file that cannot be parsed should not take down
 * the page that exists to fix it.
 */
export async function readSearchConfig(): Promise<SearchConfig> {
  let value: unknown;
  try {
    value = await invokeSearchControl({ version: '1', action: 'read' });
  } catch (error) {
    // A parse failure is a state the user has to be told about; every other
    // transport failure is indistinguishable from "not set up yet" and is
    // safest reported as such.
    const detail = error instanceof Error ? error.message : '';
    return /could not be read/iu.test(detail) ? { ...EMPTY, unreadable: true } : EMPTY;
  }
  const config = (value as { config?: unknown })?.config;
  if (!config || typeof config !== 'object') return EMPTY;
  const c = config as Partial<SearchConfig>;
  return {
    exists: c.exists === true,
    unreadable: false,
    keywords: isStringList(c.keywords) ? c.keywords : [],
    excluded: isStringList(c.excluded) ? c.excluded : [],
    locations: isStringList(c.locations) ? c.locations : [],
    blockedLocations: isStringList(c.blockedLocations) ? c.blockedLocations : [],
    companies: Array.isArray(c.companies)
      ? c.companies.flatMap((entry) => {
          const item = entry as Partial<SearchCompany>;
          return typeof item?.name === 'string'
            ? [{ name: item.name, enabled: item.enabled !== false }]
            : [];
        })
      : [],
  };
}

/**
 * Create the search configuration from the shipped template, seeded with the
 * onboarding answers.
 *
 * Idempotent, and separate from saveSearchLists: this is the call that makes
 * "search" work at all on a fresh installation, and it must never fail merely
 * because the file already exists.
 */
export async function seedSearchConfig(answers?: SetupAnswers): Promise<{ created: boolean }> {
  const value = await invokeSearchControl({
    version: '1',
    action: 'seed',
    ...(answers ? { answers } : {}),
  });
  return { created: (value as { created?: unknown })?.created === true };
}

export async function saveSearchLists(
  lists: Record<string, string[]>,
): Promise<string[]> {
  const value = await invokeSearchControl({ version: '1', action: 'save', lists });
  const written = (value as { written?: unknown })?.written;
  return isStringList(written) ? written : [];
}

export async function setCompanyEnabled(
  company: string,
  enabled: boolean,
): Promise<{ company: string; enabled: boolean }> {
  const value = await invokeSearchControl({
    version: '1',
    action: 'company',
    company,
    enabled,
  });
  const result = value as { company?: unknown; enabled?: unknown };
  return {
    company: typeof result?.company === 'string' ? result.company : company,
    enabled: result?.enabled === true,
  };
}
