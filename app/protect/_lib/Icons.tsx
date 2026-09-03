/**
 * The app's icon set, drawn in the same language as the Payung mark in
 * Shell.tsx: a 24x24 box, 2px round-capped strokes, currentColor only, no
 * fills. Emoji used to do this job — they render as someone else's artwork at
 * someone else's weight on every platform, and eight of them in a row is the
 * loudest "assembled from a template" signal an interface can send.
 *
 * Every icon here is decorative: the surrounding text always carries the
 * meaning, so they are aria-hidden and never the sole label for a control.
 */
type IconProps = { size?: number; className?: string };

function svg(size: number, className: string | undefined, children: React.ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The mark itself: a canopy with a hooked handle. The floor, drawn. */
export function IconUmbrella({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M3 12a9 9 0 0 1 18 0" />
      <path d="M3 12h18" />
      <path d="M12 12v6.5a2.5 2.5 0 0 1-4 1.6" />
    </>
  );
}

/** Plain language in, structured goal out. */
export function IconSpeak({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M4 5h16v11H9l-5 4V5Z" />
      <path d="M8.5 10.5h7" />
    </>
  );
}

/** Reading the live book. */
export function IconScan({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
      <path d="M8.5 11h5" />
    </>
  );
}

/** A floor under a falling price — the product in one glyph. */
export function IconFloor({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M4 5v6.5a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4V5" />
      <path d="M4 20h16" />
      <path d="M12 9v4" />
      <path d="m9.5 11 2.5 2.5 2.5-2.5" />
    </>
  );
}

/** Custody stays with the user. */
export function IconSelfCustody({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <rect x="4" y="10.5" width="16" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  );
}

/** Live market data, not an estimate. */
export function IconLive({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M3 13h3.5l2.5-6 3 12 2.5-8 2 4H21" />
    </>
  );
}

/** Verifiable on-chain. */
export function IconChain({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.2 7.2" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.4-1.5" />
    </>
  );
}

export function IconWallet({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
      <rect x="4" y="7.5" width="16" height="11.5" rx="2.5" />
      <path d="M16.5 13.2h.01" />
    </>
  );
}

export function IconCheck({ size = 24, className }: IconProps) {
  return svg(size, className, <path d="m5 12.5 4.5 4.5L19 7.5" />);
}

export function IconWarn({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M12 4.5 21 20H3l9-15.5Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  );
}

export function IconArrowRight({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </>
  );
}

export function IconExternal({ size = 24, className }: IconProps) {
  return svg(
    size,
    className,
    <>
      <path d="M13 5h6v6" />
      <path d="m19 5-8.5 8.5" />
      <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
    </>
  );
}
