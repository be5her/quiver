import { definePart, runSections } from '../part';
import core from './tools/core';
import qr from './tools/qr';
import dns from './tools/dns';
import netscan from './tools/netscan';

export default definePart({
  name: 'tools',
  summary: 'Small tools: JWT decode and verify, and the JWT tab; the QR code encoder and its tab; DNS lookup against a fake DNS server; the network scanner on the loopback block',
  run: (t) => runSections(t, [core, qr, dns, netscan]),
});
