const WebSocket = require('ws');
const { signNonce, markPaired } = require('./identity');
const { runScrapeJob } = require('./jobs/scrapeJob');

const HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

const JOB_RUNNERS = { 'crawler.crawl': runScrapeJob };

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function jitteredBackoff(attempt) {
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function connect({ identity, config, resources, capabilities, log = console }) {
  let attempt = 0;
  let heartbeatTimer = null;
  let stopped = false;

  function scheduleReconnect() {
    if (stopped) return;
    const delay = jitteredBackoff(attempt++);
    log.info(`Reconnecting in ${Math.round(delay)}ms`);
    setTimeout(open, delay);
  }

  function open() {
    if (stopped) return;
    const socket = new WebSocket(config.coordinatorUrl);
    let nonce = null;

    socket.on('open', () => log.info('Connected to coordinator, awaiting challenge'));

    socket.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { kind, body } = message || {};

      if (kind === 'node.challenge') {
        nonce = body.nonce;
        const hello = {
          nodeId: identity.nodeId,
          publicKey: identity.publicKeyPem,
          protocolVersions: ['BMCL/2.0'],
          capabilities,
          resources,
          clientVersion: require('../package.json').version,
          label: config.label,
        };
        if (config.joinToken && !identity.paired) {
          hello.joinToken = config.joinToken;
        } else {
          hello.signature = signNonce(identity.privateKeyPem, nonce);
        }
        send(socket, { kind: 'node.hello', body: hello });
        return;
      }

      if (kind === 'node.hello.ack') {
        if (!body.ok) {
          log.error(`Handshake rejected: ${body.reason}`);
          socket.close();
          return;
        }
        attempt = 0;
        if (!identity.paired) {
          identity.paired = true;
          markPaired();
        }
        log.info(`Joined mesh as ${body.nodeId}`);
        heartbeatTimer = setInterval(() => {
          send(socket, { kind: 'node.heartbeat', body: { capabilities } });
        }, body.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS);
        return;
      }

      if (kind === 'node.job.assign') {
        const { jobId, op, request } = body;
        const runner = JOB_RUNNERS[op];
        if (!runner) {
          send(socket, { kind: 'node.job.result', body: { jobId, ok: false, error: `unsupported op ${op}` } });
          return;
        }
        try {
          const result = await runner(request);
          send(socket, { kind: 'node.job.result', body: { jobId, ok: true, result } });
        } catch (err) {
          send(socket, { kind: 'node.job.result', body: { jobId, ok: false, error: err.message } });
        }
      }
    });

    socket.on('close', () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      log.warn('Disconnected from coordinator');
      scheduleReconnect();
    });

    socket.on('error', (err) => log.error(`Connection error: ${err.message}`));
  }

  open();

  return {
    stop: () => {
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  };
}

module.exports = { connect };
