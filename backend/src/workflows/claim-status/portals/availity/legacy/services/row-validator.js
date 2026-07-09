"use strict";

const REQUIRED_FIELDS = ["Payer Name", "Patient Name", "Patient DOB", "Subscriber No", "Service Date", "Charges"];
const DATE_PATTERN = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;

function asText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function validateRow(row, payerMapping) {
  const errors = [];
  const data = row && row.data ? row.data : {};

  for (const field of REQUIRED_FIELDS) {
    if (!asText(data[field])) {
      errors.push(`Missing ${field}`);
    }
  }

  if (asText(data["Service Date"]) && !DATE_PATTERN.test(asText(data["Service Date"]))) {
    errors.push("Invalid Service Date format");
  }

  const payerName = asText(data["Payer Name"]);
  const mappedPayerName = payerName ? payerMapping.get(payerName.toLowerCase()) : "";
  if (payerName && !mappedPayerName) {
    errors.push(`Payer mapping not found for "${payerName}". Update backend/src/workflows/claim-status/portals/availity/config/Payer_mapping_ava.xlsx.`);
  }

  return {
    isValid: errors.length === 0,
    validation_status: errors.length === 0 ? "valid" : "invalid",
    validation_message: errors.join("; "),
    mappedPayerName
  };
}

module.exports = {
  validateRow,
  REQUIRED_FIELDS
};
