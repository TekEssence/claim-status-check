"use strict";

const fs = require("fs");
const path = require("path");

function ensureCheckpointDir() {
  const runtimeRoot = process.env.CLAIM_STATUS_RUNTIME_DIR || "/tmp/claim-status-artifacts";
  const dir = path.join(runtimeRoot, "availity", "checkpoints");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function checkpointPath(runId) {
  return path.join(ensureCheckpointDir(), `claim_status_checkpoint_${runId}.json`);
}

function writeCheckpoint(runId, state) {
  fs.writeFileSync(checkpointPath(runId), JSON.stringify(state, null, 2), "utf8");
}

module.exports = {
  checkpointPath,
  writeCheckpoint
};
