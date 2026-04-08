/**
 * Mocxy Mock Server — TLS Certificate Helper
 *
 * Auto-generates a self-signed certificate for localhost on first run
 * and caches it in  certs/  so subsequent starts reuse the same cert.
 *
 * Users can override with trusted certs (mkcert / corporate CA) by setting:
 *   TLS_CERT=/path/to/cert.pem  TLS_KEY=/path/to/key.pem  npm start
 */

import selfsigned   from 'selfsigned';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CERTS_DIR  = join(__dirname, 'certs');
const CERT_FILE  = join(CERTS_DIR, 'cert.pem');
const KEY_FILE   = join(CERTS_DIR, 'key.pem');

/**
 * Returns { cert, key } strings ready for https.createServer().
 *
 * Priority:
 *   1. TLS_CERT + TLS_KEY environment variables (user-provided trusted certs)
 *   2. Cached certs/cert.pem + certs/key.pem
 *   3. Auto-generate new self-signed cert (saved to certs/ for reuse)
 */
export async function getCerts() {
  // 1. Environment override — bring-your-own trusted cert
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    console.log('  [TLS] Using certs from environment variables');
    return {
      cert: readFileSync(process.env.TLS_CERT, 'utf8'),
      key:  readFileSync(process.env.TLS_KEY,  'utf8'),
    };
  }

  // 2. Cached self-signed cert
  if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
    return {
      cert: readFileSync(CERT_FILE, 'utf8'),
      key:  readFileSync(KEY_FILE,  'utf8'),
    };
  }

  // 3. Generate new self-signed cert
  console.log('  [TLS] Generating self-signed certificate for localhost…');
  mkdirSync(CERTS_DIR, { recursive: true });

  const attrs = [
    { name: 'commonName',         value: 'localhost' },
    { name: 'organizationName',   value: 'Mocxy Dev' },
  ];
  const opts = {
    days:       3650,        // 10 years — never expires in dev
    algorithm:  'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1'  },
      ]},
    ],
  };

  const pems = await selfsigned.generate(attrs, opts);

  writeFileSync(CERT_FILE, pems.cert, 'utf8');
  writeFileSync(KEY_FILE,  pems.private, 'utf8');

  console.log('  [TLS] Certificate saved to certs/ (reused on next start)');
  console.log('  [TLS] To use a trusted cert:  TLS_CERT=cert.pem TLS_KEY=key.pem npm start');

  return { cert: pems.cert, key: pems.private };
}
