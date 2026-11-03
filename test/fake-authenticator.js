'use strict';
// Een nep-authenticator voor tests: een P-256-sleutel, een "none"-attestatie en ondertekende assertions, zodat
// registreren, inloggen en bevestigen met een passkey zonder telefoon te testen zijn.
const crypto = require('node:crypto');

// Minimale CBOR-encoder: gehele getallen, byte strings, tekst en maps.
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: ${typeof v}`);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

class FakeAuthenticator {
  constructor({ origin, rpID }) {
    this.origin = origin;
    this.rpID = rpID;
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.jwk = publicKey.export({ format: 'jwk' });
    this.credId = crypto.randomBytes(16);
    this.id = b64u(this.credId);
    this.counter = 0;
    this.userHandle = null;
  }

  clientData(type, challenge, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  // Antwoord op generateRegistrationOptions.
  register(options, { origin } = {}) {
    this.userHandle = options.user.id;
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]);
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([sha256(this.rpID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, cbor(cose)]);
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, origin)), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  // Antwoord op generateAuthenticationOptions.
  assert(options, { origin } = {}) {
    const count = Buffer.alloc(4); count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(this.rpID), Buffer.from([0x05]), count]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: this.userHandle },
    };
  }
}

module.exports = { FakeAuthenticator };
