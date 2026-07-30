import Link from 'next/link';

export function Brand() {
  return (
    <Link
      href="/"
      aria-label="Frontrunner home"
      className="group flex shrink-0 items-center rounded-md"
    >
      <span className="text-[12px] font-bold uppercase tracking-[0.22em] transition-[letter-spacing] duration-200 group-hover:tracking-[0.24em] sm:text-[13px]">
        Frontrunner
      </span>
    </Link>
  );
}
