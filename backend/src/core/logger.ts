import type { LogEvent } from "../scrapers/types";

export type Logger = {
  debug: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  info: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  warn: (message: string, meta?: Record<string, unknown>) => Promise<void>;
  error: (message: string, meta?: Record<string, unknown>) => Promise<void>;
};

export function createEventLogger(options: {
  jobId: string;
  portalId: string;
  emit: (event: Record<string, unknown>) => Promise<void>;
}): Logger {
  const write = async (event: LogEvent) => {
    await options.emit({
      type: "log",
      jobId: options.jobId,
      portalId: options.portalId,
      level: event.level,
      message: event.message,
      eventName: event.eventName,
      rowIndex: event.rowIndex,
      meta: event.meta,
    });
  };

  return {
    debug: (message, meta) => write({ level: "debug", message, meta }),
    info: (message, meta) => write({ level: "info", message, meta }),
    warn: (message, meta) => write({ level: "warn", message, meta }),
    error: (message, meta) => write({ level: "error", message, meta }),
  };
}
