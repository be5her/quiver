/**
 * The Quiver mark drawn with theme colours, for the title bar and other places inside the app.
 * resources/icon.svg is the same drawing on a dark badge, used for the installers.
 */
export function QuiverMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true" focusable="false" data-testid="quiver-mark">
      <g transform="rotate(28 512 512)" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="512" cy="500" rx="142" ry="44" className="fill-accent" opacity="0.45" />
        <g className="fill-fg stroke-fg" strokeWidth="38">
          <g transform="rotate(-16 512 760)">
            <line x1="512" y1="520" x2="512" y2="220" />
            <path d="M512 120 L566 250 L512 222 L458 250 Z" stroke="none" />
          </g>
          <g>
            <line x1="512" y1="520" x2="512" y2="220" />
            <path d="M512 120 L566 250 L512 222 L458 250 Z" stroke="none" />
          </g>
          <g transform="rotate(16 512 760)">
            <line x1="512" y1="520" x2="512" y2="220" />
            <path d="M512 120 L566 250 L512 222 L458 250 Z" stroke="none" />
          </g>
        </g>
        <path d="M370 500 Q512 588 654 500 L630 890 Q512 950 394 890 Z" className="fill-accent" />
        <path d="M370 500 Q512 588 654 500" fill="none" className="stroke-accent-fg" strokeWidth="16" opacity="0.7" />
        <path d="M384 690 Q512 748 640 690" fill="none" className="stroke-accent-fg" strokeOpacity="0.35" strokeWidth="26" />
      </g>
    </svg>
  );
}
