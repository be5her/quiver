import { Component } from '@angular/core';

/**
 * The Quiver mark (Project Folder, C1 Tucked) drawn with theme colours, for the title bar and other
 * places inside the app: `<svg qQuiverMark class="size-5"></svg>`. resources/icon.svg is the C4 Solid
 * mark on a dark badge, for installers. Strokes use the fg token; the middle arrow uses the accent token.
 */
@Component({
  selector: 'svg[qQuiverMark]',
  templateUrl: './quiver-mark.svg',
  host: { viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false', 'data-testid': 'quiver-mark' },
})
export class QuiverMark {}
