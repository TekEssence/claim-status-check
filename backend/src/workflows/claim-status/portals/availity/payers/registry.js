"use strict";

const aetnaWorkflow = require("./aetna/registry");
const blueCrossBlueShieldWorkflow = require("./blue-cross-blue-shield/registry");
const humanaWorkflow = require("./humana/registry");
const wellcareWorkflow = require("./wellcare/registry");
const wellpointWorkflow = require("./wellpoint/registry");

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function getWorkflowForPayer({ inputPayerName, mappedPortalPayerName }) {
  const mapped = normalize(mappedPortalPayerName);
  const input = normalize(inputPayerName);

  if (mapped.includes("AETNA") || input.includes("AETNA")) {
    return aetnaWorkflow;
  }

  if (mapped.includes("WELLCARE") || input.includes("WELLCARE")) {
    return wellcareWorkflow;
  }

  if (mapped.includes("HUMANA") || input.includes("HUMANA")) {
    return humanaWorkflow;
  }

  if (mapped.includes("WELLPOINT") || input.includes("WELLPOINT")) {
    return wellpointWorkflow;
  }

  if (
    mapped.includes("BCBSTX") ||
    mapped.includes("BLUE CROSS") ||
    mapped.includes("BLUE SHIELD") ||
    input.includes("BLUE CROSS") ||
    input.includes("BLUE SHIELD") ||
    input.includes("BCBS")
  ) {
    return blueCrossBlueShieldWorkflow;
  }

  throw new Error(`No Availity payer workflow configured for payer: ${inputPayerName || mappedPortalPayerName}`);
}

module.exports = {
  getWorkflowForPayer
};
