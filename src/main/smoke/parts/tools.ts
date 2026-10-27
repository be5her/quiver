import { definePart, runSections } from '../part';
import core from './tools/core';
import qr from './tools/qr';

export default definePart({
  name: 'tools',
  summary: 'Small tools: JWT decode and verify, and the JWT tab; the QR code encoder and its tab',
  run: (t) => runSections(t, [core, qr]),
});
