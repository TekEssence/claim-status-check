const REQUIRED_FIELDS = [
  "Subscriber No",
  "Service Date",
];

function normalizeHeader(value) {
  return String(value || "").trim();
}

function getField(row, fieldName) {
  if (!row || typeof row !== "object") return "";

  const expected = normalizeHeader(fieldName).toLowerCase();
  const key = Object.keys(row).find((candidate) => normalizeHeader(candidate).toLowerCase() === expected);
  const value = key ? row[key] : "";

  return value == null ? "" : String(value).trim();
}

function normalizeServiceDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    const year = String(value.getFullYear());
    return `${month}/${day}/${year}`;
  }

  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return "";

  const [, monthText, dayText, yearText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
  const date = new Date(year, month - 1, day);

  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;

  if (!valid) return "";

  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

function isValidUsDate(value) {
  return Boolean(normalizeServiceDate(value));
}

function normalizeAmount(value) {
  const text = String(value || "").replace(/[$,\s]/g, "");
  if (!text) return "";

  const amount = Number(text);
  if (!Number.isFinite(amount)) return "";

  return amount.toFixed(2);
}

function normalizeSubscriberNo(value) {
  const text = String(value || "").trim();
  return text.toUpperCase().startsWith("XEE") ? text.slice(3).trim() : text;
}

function validateInputRow(row) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!getField(row, field)) {
      errors.push({
        field,
        reason: "missing_required_field",
        message: `${field} is required.`,
      });
    }
  }

  const serviceDate = getField(row, "Service Date");
  if (serviceDate && !isValidUsDate(serviceDate)) {
    errors.push({
      field: "Service Date",
      reason: "invalid_date_format",
      message: "Service Date must be in MM/DD/YYYY format.",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized: {
      subscriberNo: normalizeSubscriberNo(getField(row, "Subscriber No")),
      serviceDate: normalizeServiceDate(serviceDate),
    },
  };
}

module.exports = {
  REQUIRED_FIELDS,
  getField,
  isValidUsDate,
  normalizeServiceDate,
  normalizeAmount,
  normalizeSubscriberNo,
  validateInputRow,
};
