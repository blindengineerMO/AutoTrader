const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.AUTOTRADER_NODE_HOME || path.join(os.homedir(), '.autotrader-node');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }

  const coordinatorUrl = process.env.AUTOTRADER_COORDINATOR_URL || fileConfig.coordinatorUrl;
  const joinToken = process.env.AUTOTRADER_JOIN_TOKEN || fileConfig.joinToken;
  const label = process.env.AUTOTRADER_NODE_LABEL || fileConfig.label || os.hostname();

  if (!coordinatorUrl) {
    throw new Error(
      `Missing coordinator URL. Set AUTOTRADER_COORDINATOR_URL or add "coordinatorUrl" to ${CONFIG_PATH}`
    );
  }

  return { coordinatorUrl, joinToken, label };
}

module.exports = { loadConfig, CONFIG_PATH };
