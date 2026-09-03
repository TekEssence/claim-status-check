"use strict";

const aetnaWorkflow = require("./aetna/registry");
const anthemCaWorkflow = require("./anthem-ca/registry");
const blueCrossBlueShieldWorkflow = require("./blue-cross-blue-shield/registry");
const carelonBehavioralHealthWorkflow = require("./carelon-behavioral-health/registry");
const centralHealthMedicarePlanWorkflow = require("./central-health-medicare-plan/registry");
const healthNetWorkflow = require("./health-net/registry");
const humanaWorkflow = require("./humana/registry");
const molinaWorkflow = require("./molina/registry");
const providenceHealthPlanWorkflow = require("./providence-health-plan/registry");
const scanHealthWorkflow = require("./scan-health/registry");
const triwestTricareWorkflow = require("./triwest-tricare/registry");
const triwestVaCcnWorkflow = require("./triwest-va-ccn/registry");
const wellcareWorkflow = require("./wellcare/registry");
const wellpointWorkflow = require("./wellpoint/registry");

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function getWorkflowForPayer({ inputPayerName, mappedPortalPayerName }) {
  const mapped = normalize(mappedPortalPayerName);
  const input = normalize(inputPayerName);

  if (
    mapped.includes("ANTHEM - CT") ||
    mapped.includes("ANTHEM CT") ||
    mapped.includes("ANTHEM - NH") ||
    mapped.includes("ANTHEM NH") ||
    mapped.includes("ANTHEM BCBS NY") ||
    input.includes("ANTHEM - CT") ||
    input.includes("ANTHEM CT") ||
    input.includes("ANTHEM - NH") ||
    input.includes("ANTHEM NH") ||
    input.includes("ANTHEM BCBS NY")
  ) {
    return blueCrossBlueShieldWorkflow;
  }

  if (mapped.includes("AETNA") || input.includes("AETNA")) {
    return aetnaWorkflow;
  }

  if (mapped.includes("CARELON") || input.includes("CARELON") || mapped.includes("BHOMD") || input.includes("BHOMD")) {
    return carelonBehavioralHealthWorkflow;
  }

  if (mapped.includes("ANTHEM") || input.includes("ANTHEM")) {
    return anthemCaWorkflow;
  }

  if (mapped.includes("WELLCARE") || input.includes("WELLCARE")) {
    return wellcareWorkflow;
  }

  if (mapped.includes("HUMANA") || input.includes("HUMANA")) {
    return humanaWorkflow;
  }

  if (
    mapped.includes("CENTRAL HEALTH") ||
    input.includes("CENTRAL HEALTH")
  ) {
    return centralHealthMedicarePlanWorkflow;
  }

  if (mapped.includes("HEALTH NET") || mapped.includes("HEALTHNET") || input.includes("HEALTH NET") || input.includes("HEALTHNET")) {
    return healthNetWorkflow;
  }

  if (mapped.includes("MOLINA") || input.includes("MOLINA")) {
    return molinaWorkflow;
  }

  if (mapped.includes("PROVIDENCE") || input.includes("PROVIDENCE")) {
    return providenceHealthPlanWorkflow;
  }

  if (mapped.includes("SCAN") || input.includes("SCAN")) {
    return scanHealthWorkflow;
  }

  if (
    mapped.includes("VA CCN") ||
    mapped.includes("VACC") ||
    input.includes("VA CCN") ||
    input.includes("VACC")) {
    return triwestVaCcnWorkflow;
  }

  if (
    mapped.includes("TRIWEST") ||
    mapped.includes("TRICARE") ||
    input.includes("TRIWEST") ||
    input.includes("TRICARE")
  ) {
    return triwestTricareWorkflow;
  }

  if (mapped.includes("WELLPOINT") || input.includes("WELLPOINT")) {
    return wellpointWorkflow;
  }

  if (
    mapped.includes("BCBSTX") ||
    mapped.includes("BLUE CROSS") ||
    mapped.includes("BLUE SHIELD") ||
    mapped.includes("FLORIDA BLUE") ||
    mapped.includes("REGENCE") ||
    mapped.includes("CAREFIRST") ||
    input.includes("BLUE CROSS") ||
    input.includes("BLUE SHIELD") ||
    input.includes("FLORIDA BLUE") ||
    input.includes("REGENCE") ||
    input.includes("CAREFIRST") ||
    input.includes("BCBS")
  ) {
    return blueCrossBlueShieldWorkflow;
  }

  throw new Error(`No Availity payer workflow configured for payer: ${inputPayerName || mappedPortalPayerName}`);
}

module.exports = {
  getWorkflowForPayer
};
