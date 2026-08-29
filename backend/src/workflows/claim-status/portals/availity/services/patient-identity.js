"use strict";

function extractBracketedPatientId(value) {
  return String(value || "").match(/\[\s*([^\]]+?)\s*]/)?.[1]?.replace(/[^a-z0-9]/gi, "").toUpperCase() || "";
}

module.exports = { extractBracketedPatientId };
