export type WaystarPaymentProcessId = "cash-log-and-zero-payments" | "bulk-eob-download";

const WAYSTAR_CLIENT_PROCESS_REGISTRY = {
  posada: "cash-log-and-zero-payments",
  bph: "cash-log-and-zero-payments",
  esc: "cash-log-and-zero-payments",
  pscd: "cash-log-and-zero-payments",
  ssce: "cash-log-and-zero-payments",
  taj: "bulk-eob-download",
  geh: "bulk-eob-download",
  bco: "bulk-eob-download",
  twl: "bulk-eob-download",
  wmgu: "bulk-eob-download",
  jtc: "bulk-eob-download",
} as const satisfies Record<string, WaystarPaymentProcessId>;

export function normalizeWaystarClientName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveWaystarPaymentProcess(clientName: string): WaystarPaymentProcessId {
  const normalized = normalizeWaystarClientName(clientName);
  const clientKey = Object.keys(WAYSTAR_CLIENT_PROCESS_REGISTRY)
    .find((candidate) => normalized === candidate || normalized.startsWith(candidate));
  const processId = clientKey
    ? WAYSTAR_CLIENT_PROCESS_REGISTRY[clientKey as keyof typeof WAYSTAR_CLIENT_PROCESS_REGISTRY]
    : undefined;
  if (!processId) {
    throw new Error(`Unsupported Waystar Client Name "${clientName || "(blank)"}". Supported clients: Posada, BPH, ESC, PSCD, SSCE, TAJ, GEH, BCO, TWL, WMGU, and JTC.`);
  }
  return processId;
}
