"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractTriwestTricareDenied,
  extractWellcarePaid: extractTriwestTricarePaid
} = require("../../../../pages/claim-detail.page");

function splitPatientNameParts(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return { firstWords: [], lastWords: [] };
  }

  if (cleaned.includes(",")) {
    const [lastPart, ...firstParts] = cleaned.split(",");
    return {
      firstWords: extractNameWords(firstParts.join(" ")),
      lastWords: extractNameWords(lastPart)
    };
  }

  const words = extractNameWords(cleaned);
  if (words.length <= 1) {
    return { firstWords: words, lastWords: [] };
  }

  return {
    firstWords: words.slice(0, -1),
    lastWords: words.slice(-1)
  };
}

function extractNameWords(value) {
  return String(value || "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index];
    }
  }

  return previous[right.length];
}

function namesMatchAtNinetyPercent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 3 && (left.startsWith(right) || right.startsWith(left))) {
    return true;
  }

  const longestLength = Math.max(left.length, right.length);
  const distance = levenshteinDistance(left, right);
  return (longestLength - distance) / longestLength >= 0.9;
}

function hasMatchingNameWord(inputWords, portalWords) {
  return inputWords.some((inputWord) => portalWords.some((portalWord) => namesMatchAtNinetyPercent(inputWord, portalWord)));
}

function patientNameWordsMatch(inputName, portalName) {
  const inputParts = splitPatientNameParts(inputName);
  const portalParts = splitPatientNameParts(portalName);
  const hasInputFirst = inputParts.firstWords.length > 0;
  const hasInputLast = inputParts.lastWords.length > 0;
  const firstMatches = hasInputFirst && hasMatchingNameWord(inputParts.firstWords, portalParts.firstWords);
  const lastMatches = hasInputLast && hasMatchingNameWord(inputParts.lastWords, portalParts.lastWords);

  if (hasInputFirst && hasInputLast) {
    return firstMatches && lastMatches;
  }

  return firstMatches || lastMatches;
}

module.exports = createServiceDateWorkflow({
  name: "triwest-tricare",
  payerLabel: "TRIWEST-TRICARE",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "TRIWEST-TRICARE", extractPaid: extractTriwestTricarePaid, extractDenied: extractTriwestTricareDenied }),
  fuzzyPatientNameMatches: patientNameWordsMatch,
});



