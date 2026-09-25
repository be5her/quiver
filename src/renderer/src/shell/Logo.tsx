/**
 * The Quiver mark (Project Folder, C1 Tucked) drawn with theme colours, for the title bar and
 * other places inside the app. resources/icon.svg is the C4 Solid mark on a dark badge, for installers.
 * Strokes use the fg token; the middle arrow uses the accent token.
 */
export function QuiverMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true" focusable="false" data-testid="quiver-mark">
      <g className="stroke-fg" fill="none" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M40 52 V25 M33 33 L40 25 L47 33" />
        <path d="M64 52 V25 M57 33 L64 25 L71 33" />
      </g>
      <path d="M52 52 V15 M45 23 L52 15 L59 23" className="stroke-accent" fill="none" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M12 40 V84 a8 8 0 0 0 8 8 H80 a8 8 0 0 0 8 -8 V52 a8 8 0 0 0 -8 -8 H50 l-8 -8 H20 a8 8 0 0 0 -8 8 Z"
        className="stroke-fg fill-canvas"
        strokeWidth="9"
        strokeLinejoin="round"
      />
    </svg>
  );
}
