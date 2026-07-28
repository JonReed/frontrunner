/**
 * Serve generated documents (CV PDFs and their HTML) to the browser.
 *
 * These live in the career-ops checkout, outside Next's public/ directory, so
 * they need an explicit route. That makes path validation the whole job of
 * this file: a naive implementation here would let any query string read any
 * file on the user's machine.
 *
 * Only paths that resolve INSIDE output/ are served, checked after resolution
 * so that '..' segments cannot escape.
 */

import { NextResponse } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ROOT } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const ALLOWED_ROOT = resolve(ROOT, 'output');

const TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
};

export async function GET(req: Request) {
  const rel = new URL(req.url).searchParams.get('path');
  if (!rel) return NextResponse.json({ error: 'missing path' }, { status: 400 });

  const abs = resolve(ROOT, rel);
  // Containment check AFTER resolution — '..' is neutralised by this, not by
  // string matching on the input.
  if (abs !== ALLOWED_ROOT && !abs.startsWith(ALLOWED_ROOT + sep)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
  const type = TYPES[ext];
  if (!type) return NextResponse.json({ error: 'unsupported type' }, { status: 415 });

  const stream = createReadStream(abs);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      'content-type': type,
      // inline so the browser previews the CV rather than dropping it in
      // Downloads — people want to LOOK at it before sending it anywhere.
      'content-disposition': `inline; filename="${abs.split(sep).pop()}"`,
      'cache-control': 'no-store',
    },
  });
}
