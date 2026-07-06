"use strict";

const fs = require("fs");
const path = require("path");

const logsDir = path.resolve(__dirname, "..", "logs");
const logFilePath = path.join(logsDir, "automation.log");
let logSink = null;

function ensureLogsDirectory() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

function getTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function write(level, message) {
  ensureLogsDirectory();

  const line = `[${getTimestamp()}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFilePath, `${line}\n`, "utf8");

  if (typeof logSink === "function") {
    try {
      logSink({ level, message: String(message || ""), line });
    } catch {
      // Logging must not break automation.
    }
  }
}

module.exports = {
  setLogSink: (sink) => {
    logSink = typeof sink === "function" ? sink : null;
  },
  info: (message) => write("INFO", message),
  success: (message) => write("SUCCESS", message),
  warn: (message) => write("WARN", message),
  error: (message) => write("ERROR", message)
};
