import { Prec, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, type BlockInfo } from '@codemirror/view';

/** What a gutter left of the line numbers shows for one line (a blame's commit, say). */
export interface LineMarker {
  /** Shown in the gutter; empty for a line that only carries the colour (the rest of a run). */
  text: string;
  /** The tooltip. */
  title?: string;
  /** A CSS colour for the bar on the marker's left edge. */
  color?: string;
  /** Draws a line above it: the first line of a run. */
  start?: boolean;
  /** Kept as `data-id` on the element, and handed back with clicks. */
  id?: string;
}

export interface LineMarkerEvent {
  /** 1-based. */
  line: number;
  marker: LineMarker;
  event: MouseEvent;
}

class Marker extends GutterMarker {
  constructor(readonly marker: LineMarker) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof Marker && other.marker === this.marker;
  }

  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = this.marker.start ? 'cm-lineMarker cm-lineMarker-start' : 'cm-lineMarker';
    el.textContent = this.marker.text;
    if (this.marker.title) el.title = this.marker.title;
    if (this.marker.color) el.style.setProperty('--marker-color', this.marker.color);
    if (this.marker.id) el.dataset['id'] = this.marker.id;
    return el;
  }
}

const markerTheme = EditorView.theme({
  '.cm-lineMarkers .cm-gutterElement': { padding: '0' },
  '.cm-lineMarker': {
    boxSizing: 'border-box',
    height: '100%',
    width: '30ch',
    padding: '0 8px 0 6px',
    borderLeft: '3px solid var(--marker-color, transparent)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans, inherit)',
    fontSize: '11.5px',
  },
  '.cm-lineMarker-start': { borderTop: '1px solid var(--edge)' },
  '.cm-lineMarker:hover': { color: 'var(--fg)', backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
});

/**
 * A gutter left of the line numbers with one marker per line (`markers[0]` is line 1; null leaves a line blank).
 * A click or right-click on a marker reports its line.
 */
export function lineMarkerGutter(markers: readonly (LineMarker | null)[], on: { click?(e: LineMarkerEvent): void; menu?(e: LineMarkerEvent): void }): Extension {
  const made = markers.map((m) => (m ? new Marker(m) : null));
  const at = (view: EditorView, block: BlockInfo) => {
    const line = view.state.doc.lineAt(block.from).number;
    return { line, marker: markers[line - 1] ?? null };
  };
  const handler = (report?: (e: LineMarkerEvent) => void) => (view: EditorView, block: BlockInfo, event: Event) => {
    const { line, marker } = at(view, block);
    if (!marker || !report) return false;
    report({ line, marker, event: event as MouseEvent });
    return true;
  };
  return [
    // Above the line numbers' precedence, so the gutter sits left of them.
    Prec.high(
      gutter({
        class: 'cm-lineMarkers',
        lineMarker: (view, block) => made[view.state.doc.lineAt(block.from).number - 1] ?? null,
        initialSpacer: () => new Marker({ text: '' }),
        domEventHandlers: { click: handler(on.click), contextmenu: handler(on.menu) },
      }),
    ),
    markerTheme,
  ];
}
