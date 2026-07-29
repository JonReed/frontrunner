import Link from 'next/link';

/**
 * Three lanes and one clear leader.
 *
 * The shape also resolves to an F at small sizes, but it is intentionally not
 * a letter in a box. The product is about moving a small number of good roles
 * through a process; the mark gives that idea a recognisable shorthand.
 */
export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <rect width="32" height="32" rx="9" fill="var(--color-ink)" />
      <path
        d="M7.5 10h14M7.5 16h10.5M7.5 22h7"
        stroke="white"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
      <circle cx="24" cy="10" r="3.25" fill="var(--color-act)" stroke="white" strokeWidth="1.5" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link
      href="/"
      aria-label="Frontrunner home"
      className="group flex shrink-0 items-center gap-2.5 rounded-md"
    >
      <BrandMark className="size-8 transition-transform duration-200 group-hover:-translate-y-0.5" />
      <span className="text-[17px] font-bold tracking-[-0.025em]">Frontrunner</span>
    </Link>
  );
}
