import {
  getSharedMfaOwnerMailboxes,
  parseMailboxList,
  waitForMfaOtp,
} from "@/backend/src/core/mfa-otp-service";
import { envText } from "./env";

const BLUE_SHIELD_OTP_TIMEOUT_MS = 300000;
const BLUE_SHIELD_OTP_POLL_MS = 5000;

function normalizeGroupName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function ownerMailboxEnvForGroup(group: string): string {
  const normalized = normalizeGroupName(group);
  if (normalized === "iumg") return envText("PORTAL_BLUE_SHIELD_IUMG_MFA_OWNER_MAILBOXES");
  if (normalized === "ipmg") return envText("PORTAL_BLUE_SHIELD_IPMG_MFA_OWNER_MAILBOXES");
  if (normalized === "nur") return envText("PORTAL_BLUE_SHIELD_NUR_MFA_OWNER_MAILBOXES");
  if (normalized === "posada") return envText("PORTAL_BLUE_SHIELD_POSADA_MFA_OWNER_MAILBOXES");
  if (normalized === "wmgu") return envText("PORTAL_BLUE_SHIELD_WMGU_MFA_OWNER_MAILBOXES");
  return "";
}

export async function waitForBlueShieldOtp(options: {
  group: string;
  mailbox: string;
  log: (message: string) => Promise<void>;
}): Promise<string> {
  const portalOwners = parseMailboxList(
    ownerMailboxEnvForGroup(options.group) ||
    envText("PORTAL_BLUE_SHIELD_MFA_OWNER_MAILBOXES"),
  );
  const portalSenderDomains = parseMailboxList(envText("PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS") || "blueshieldca.com");
  const portalSenderAddresses = parseMailboxList(envText("PORTAL_BLUE_SHIELD_OTP_SENDER_ADDRESSES"));
  return waitForMfaOtp({
    label: `Blue Shield ${options.group}`,
    mailbox: options.mailbox,
    ownerMailboxes: portalOwners.length ? portalOwners : getSharedMfaOwnerMailboxes(),
    portalSenderDomains,
    portalSenderAddresses,
    graphToken: envText("PORTAL_BLUE_SHIELD_GRAPH_TOKEN") || undefined,
    otpTextPath: envText("PORTAL_BLUE_SHIELD_OTP_TEXT_PATH") || undefined,
    timeoutMs: BLUE_SHIELD_OTP_TIMEOUT_MS,
    pollMs: BLUE_SHIELD_OTP_POLL_MS,
    log: options.log,
  });
}
