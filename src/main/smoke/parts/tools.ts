import { definePart, runSections } from '../part';
import jwt from './tools/jwt';
import dns from './tools/dns';

export default definePart({
  name: 'tools',
  summary: 'Small tools: JWT decode and verify, the JWT tab, and DNS lookup against a fake DNS server',
  run: (t) => runSections(t, [jwt, dns]),
});
