import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.mjs';

export function readFile(path) {
  const fullPath = join(ROOT, path);
  let content = readFileSync(fullPath, 'utf8');
  if (content.trim().startsWith('..') && content.trim().split('\n').length === 1) {
    const target = join(dirname(fullPath), content.trim());
    if (existsSync(target)) content = readFileSync(target, 'utf8');
  }
  return content;
}

export const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
export const readTextLF = (path) => normalizeEol(readFile(path));
