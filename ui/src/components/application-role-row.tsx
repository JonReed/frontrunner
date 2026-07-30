'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { undoRoleMove } from '@/app/actions';
import type { Role } from '@/lib/roles';
import { Match } from '@/components/match';
import { CvLinks } from '@/components/cv-links';
import { RoleActions } from '@/components/role-actions';
import type { WorkflowHandle } from '@/lib/status';
import type { Followup } from '@/lib/followups';
import { FollowupStatus } from '@/components/followup-status';

function WorkState({ role, building }: { role: Role; building: boolean }) {
  if (role.stage === 'prepare') {
    if (role.hasPdf && !building) return null;
    const label = building
      ? 'CV building'
      : role.url
        ? 'CV needed'
        : 'Job advert unavailable';
    const tone = building
      ? 'text-[var(--color-attention)]'
      : role.url
        ? 'text-[var(--color-ink-faint)]'
        : 'text-[var(--color-attention)]';
    return <span className={`text-xs font-medium ${tone}`}>{label}</span>;
  }
  if (role.stage === 'active') {
    return <span className="text-xs font-medium text-[var(--color-act)]">{role.status}</span>;
  }
  if (role.stage === 'closed') {
    const label = role.status.toLowerCase() === 'rejected'
      ? 'Employer rejected'
      : role.status.toLowerCase() === 'discarded'
        ? 'Not pursuing'
        : 'Ruled out';
    return <span className="text-xs font-medium text-[var(--color-ink-faint)]">{label}</span>;
  }
  return null;
}

export function ApplicationRoleRow({
  role,
  building,
  followup,
}: {
  role: Role;
  building: boolean;
  followup?: Followup;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [undoHandle, setUndoHandle] = useState<WorkflowHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => router.refresh(), 7_000);
    return () => window.clearTimeout(timer);
  }, [notice, router]);

  const undo = () => {
    setError(null);
    startTransition(async () => {
      if (!undoHandle) {
        setError('That move can no longer be undone. Reload the role.');
        return;
      }
      const result = await undoRoleMove(role.num, undoHandle);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setNotice(null);
      setUndoHandle(null);
      router.refresh();
    });
  };

  if (notice) {
    return (
      <li aria-live="polite" className="flex min-h-20 flex-wrap items-center gap-3 rounded-[15px] border-b border-[var(--color-line)] bg-[var(--color-ready-wash)]/40 px-5 py-4 last:border-0">
        <span className="font-medium">{role.company}</span>
        <span className="text-sm text-[var(--color-ink-soft)]">{notice}</span>
        <button
          type="button"
          disabled={pending}
          onClick={undo}
          className="min-h-[40px] cursor-pointer text-sm font-semibold text-[var(--color-act)] hover:underline disabled:opacity-50 sm:min-h-0"
        >
          {pending ? 'Restoring…' : 'Undo'}
        </button>
        {error && <span className="w-full text-sm text-[var(--color-attention)]">{error}</span>}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-3 border-b border-[var(--color-line)] px-5 py-4 transition first:rounded-t-[15px] last:rounded-b-[15px] last:border-0 hover:bg-[var(--color-paper)] sm:flex-row sm:items-center sm:px-6">
      <div className="min-w-0 flex-1">
        <Link href={`/role/${role.num}`} className="group block">
          <div className="text-[15px] font-semibold group-hover:text-[var(--color-act)]">
            {role.company}
          </div>
          <div className="text-sm text-[var(--color-ink-soft)]">{role.role}</div>
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Match score={role.score} />
          {role.hasPdf && (
            <span className="text-xs font-medium text-[var(--color-ready)]">CV ready</span>
          )}
          <WorkState role={role} building={building} />
          {followup && <FollowupStatus followup={followup} />}
          {role.pdf && <CvLinks roleNum={role.num} size="sm" />}
        </div>
      </div>
      <RoleActions
        roleNum={role.num}
        stage={role.stage}
        status={role.status}
        hasPdf={role.hasPdf}
        compact
        onSaved={(message, undo) => {
          setUndoHandle(undo);
          setNotice(message);
        }}
      />
    </li>
  );
}
