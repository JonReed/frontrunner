/**
 * Job status endpoint.
 *
 * Polled rather than streamed: a build takes tens of seconds and polling every
 * couple of seconds is robust across reloads and sleeps, where an SSE
 * connection would need reconnection logic for no real gain.
 */

import { NextResponse } from 'next/server';
import { readJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(job);
}
