const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IDENTITY_DIR = process.env.AUTOTRADER_NODE_HOME || path.join(os.homedir(), '.autotrader-node');
const IDENTITY_PATH = path.join(IDENTITY_DIR, 'identity.json');

function loadOrCreateIdentity() {
  if (fs.existsSync(IDENTITY_PATH)) {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    return { nodeId: raw.nodeId, publicKeyPem: raw.publicKeyPem, privateKeyPem: raw.privateKeyPem, paired: !!raw.paired };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = {
    nodeId: `node_${crypto.randomBytes(8).toString('hex')}`,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    paired: false,
  };

  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

// Marks the join token as consumed locally so reconnects use signature-based
// auth instead of resending a token the coordinator has already spent.
function markPaired() {
  const raw = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
  raw.paired = true;
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 });
}

function signNonce(privateKeyPem, nonce) {
  return crypto.sign(null, Buffer.from(nonce), privateKeyPem).toString('base64');
}

module.exports = { loadOrCreateIdentity, markPaired, signNonce, IDENTITY_PATH };
