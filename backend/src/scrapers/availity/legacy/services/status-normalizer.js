"use strict";

function normalizeStatus(status) {
  const raw = String(status || "").trim();
  const normalized = raw.toUpperCase().replace(/\s+/g, " ");

  if (["IN PROCESS", "IN-PROCESS", "PENDING"].includes(normalized)) {
    return { raw, type: "in_process", display: raw || "IN PROCESS" };
  }
  if (normalized.includes("PAID") || normalized.includes("FINALIZED")) {
    return { raw, type: "paid", display: raw || "PAID" };
  }
  if (normalized.includes("DENIED")) {
    return { raw, type: "denied", display: raw || "DENIED" };
  }

  return { raw, type: "unsupported", display: raw || "UNKNOWN" };
}

module.exports = {
  normalizeStatus
};
