"use strict";

const aetnaWorkflow = require("./aetna.workflow");
const bcbstxWorkflow = require("./bcbstx.workflow");

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function getWorkflowForPayer({ inputPayerName, mappedPortalPayerName }) {
  const mapped = normalize(mappedPortalPayerName);
  const input = normalize(inputPayerName);

  if (mapped === "AETNA (COMMERCIAL & MEDICARE)" || input.includes("AETNA")) {
    return aetnaWorkflow;
  }

  return bcbstxWorkflow;
}

module.exports = {
  getWorkflowForPayer
};
