"use strict";

const fs = require("fs");
const path = require("path");

function ensureCheckpointDir() {
  const dir = path.resolve("checkpoints");
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
