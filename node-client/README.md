# autotrader-node-client

Standalone BrainMesh (BMCL/2.0) compute node. Run this on your own Linux server to join a coordinator's mesh and serve scraping/research jobs — no dependency on the main AutoTrader repo.

## Setup

```
npm install
```

Create `~/.autotrader-node/config.json`:

```json
{
  "coordinatorUrl": "wss://your-coordinator.example.com/api/brain-mesh/nodes/socket",
  "joinToken": "the-one-time-token-from-the-dashboard"
}
```

Or set `AUTOTRADER_COORDINATOR_URL` and `AUTOTRADER_JOIN_TOKEN` as environment variables instead.

## Run

```
npm start
```

On first run, an Ed25519 identity keypair is generated at `~/.autotrader-node/identity.json` (private key never leaves this file) and the join token is consumed to register with the coordinator. On subsequent runs the node reconnects using its stored identity — no token needed unless you delete `identity.json` and re-pair.

## What this node can and cannot do

This node only ever serves compute/research ops (currently scraping via `crawler.crawl`). The coordinator enforces — independent of anything this client claims — that order-placement, trading, broker, and rules-engine operations can never be dispatched to a remote node.
