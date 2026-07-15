#!/usr/bin/env node
const { loadOrCreateIdentity } = require('./identity');
const { loadConfig } = require('./config');
const { detectResources, detectCapabilities } = require('./capabilities');
const { connect } = require('./connection');

async function main() {
  const identity = loadOrCreateIdentity();
  const config = loadConfig();
  const resources = await detectResources();
  const capabilities = detectCapabilities(resources);

  console.log(`Node identity: ${identity.nodeId}`);
  console.log(`Coordinator: ${config.coordinatorUrl}`);
  console.log(`Capabilities: ${capabilities.map((c) => c.op).join(', ')}`);

  const connection = connect({ identity, config, resources, capabilities, log: console });

  process.on('SIGINT', () => {
    connection.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    connection.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
