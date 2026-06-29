import fs from "node:fs/promises";

const OTP_REGEX = /\b(\d{6})\b/;

type GraphMessage = {
  subject?: string;
  bodyPreview?: string;
  body?: {
    content?: string;
  };
  from?: {
    emailAddress?: {
      address?: string;
      name?: string;
    };
  };
  toRecipients?: Array<{
    emailAddress?: {
      address?: string;
      name?: string;
    };
  }>;
  receivedDateTime?: string;
};

export type MfaOtpOptions = {
  label?: string;
  mailbox: string;
  ownerMailboxes?: string[];
  portalSenderDomains?: string[];
  portalSenderAddresses?: string[];
  graphToken?: string;
  otpTextPath?: string;
  timeoutMs?: number;
  pollMs?: number;
  log: (message: string) => Promise<void>;
};

function extractOtp(text: string): string | null {
  return text.match(OTP_REGEX)?.[1] ?? null;
}

function textEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function parseMailboxList(value: string): string[] {
  return value
    .split(/[,\n;]/)
    .map((mailbox) => mailbox.trim().toLowerCase())
    .filter(Boolean);
}

export function getSharedMfaMailbox(): string {
  return textEnv("SHARED_MFA_MAILBOX") || "mfa_automation@opusbpo.com";
}

export function getSharedMfaOwnerMailboxes(): string[] {
  return parseMailboxList(textEnv("SHARED_MFA_OWNER_MAILBOXES"));
}

function messageMatchesOwner(messageText: string, ownerMailboxes: string[]): boolean {
  if (ownerMailboxes.length === 0) return true;
  const normalizedText = messageText.toLowerCase();
  return ownerMailboxes.some((mailbox) => normalizedText.includes(mailbox));
}

function messageMatchesPortalSender(
  messageText: string,
  portalSenderDomains: string[],
  portalSenderAddresses: string[],
): boolean {
  if (portalSenderDomains.length === 0 && portalSenderAddresses.length === 0) return true;
  const normalizedText = messageText.toLowerCase();
  return (
    portalSenderAddresses.some((address) => normalizedText.includes(address)) ||
    portalSenderDomains.some((domain) => normalizedText.includes(domain))
  );
}

async function readOtpFromTextFile(
  filePath: string,
  ownerMailboxes: string[],
  portalSenderDomains: string[],
  portalSenderAddresses: string[],
  log: (message: string) => Promise<void>,
): Promise<string | null> {
  if (!filePath) return null;
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!messageMatchesOwner(content, ownerMailboxes)) return null;
  if (!messageMatchesPortalSender(content, portalSenderDomains, portalSenderAddresses)) return null;
  const otp = extractOtp(content);
  if (otp) {
    await log("Found newest matching OTP from configured OTP text source.");
  }
  return otp;
}

async function readOtpFromGraph(options: {
  mailbox: string;
  graphToken: string;
  ownerMailboxes: string[];
  portalSenderDomains: string[];
  portalSenderAddresses: string[];
  log: (message: string) => Promise<void>;
}): Promise<string | null> {
  if (!options.graphToken) return null;

  const encodedMailbox = encodeURIComponent(options.mailbox);
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodedMailbox}/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$select=subject,bodyPreview,body,from,toRecipients,receivedDateTime`,
    {
      headers: {
        Authorization: `Bearer ${options.graphToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to read OTP mailbox ${options.mailbox}: HTTP ${response.status}`);
  }

  const body = await response.json() as { value?: GraphMessage[] };
  await options.log(`Checking ${body.value?.length ?? 0} newest MFA inbox email(s).`);

  for (const message of body.value ?? []) {
    const fromAddress = message.from?.emailAddress?.address ?? "";
    const toAddresses = (message.toRecipients ?? []).map((recipient) => recipient.emailAddress?.address ?? "").join("\n");
    const text = [
      message.subject ?? "",
      message.bodyPreview ?? "",
      message.body?.content ?? "",
      fromAddress,
      toAddresses,
    ].join("\n");
    if (!messageMatchesOwner(text, options.ownerMailboxes)) continue;
    if (!messageMatchesPortalSender(text, options.portalSenderDomains, options.portalSenderAddresses)) continue;

    const otp = extractOtp(text);
    if (otp) {
      await options.log(
        `Found newest matching OTP email from ${fromAddress || "unknown sender"} received ${message.receivedDateTime ?? "recently"}.`,
      );
      return otp;
    }
  }
  return null;
}

export async function waitForMfaOtp(options: MfaOtpOptions): Promise<string> {
  const mailbox = options.mailbox || getSharedMfaMailbox();
  const ownerMailboxes = options.ownerMailboxes ?? getSharedMfaOwnerMailboxes();
  const portalSenderDomains = options.portalSenderDomains ?? parseMailboxList(textEnv("SHARED_MFA_PORTAL_SENDER_DOMAINS"));
  const portalSenderAddresses = options.portalSenderAddresses ?? parseMailboxList(textEnv("SHARED_MFA_PORTAL_SENDER_ADDRESSES"));
  const graphToken = options.graphToken ?? textEnv("SHARED_MFA_GRAPH_TOKEN");
  const otpTextPath = options.otpTextPath ?? textEnv("SHARED_MFA_OTP_TEXT_PATH");
  const timeoutMs = options.timeoutMs ?? numberEnv("SHARED_MFA_OTP_TIMEOUT_MS", 120000);
  const pollMs = options.pollMs ?? numberEnv("SHARED_MFA_OTP_POLL_MS", 5000);
  const startedAt = Date.now();
  const label = options.label ? `${options.label} ` : "";

  await options.log(
    ownerMailboxes.length
      ? `Waiting for ${label}OTP in ${mailbox}; using newest email that matches ${ownerMailboxes.join(", ")}.`
      : `Waiting for ${label}OTP in ${mailbox}; using newest matching email.`,
  );

  while (Date.now() - startedAt < timeoutMs) {
    const otpFromFile = await readOtpFromTextFile(
      otpTextPath,
      ownerMailboxes,
      portalSenderDomains,
      portalSenderAddresses,
      options.log,
    );
    if (otpFromFile) return otpFromFile;

    const otpFromGraph = await readOtpFromGraph({
      mailbox,
      graphToken,
      ownerMailboxes,
      portalSenderDomains,
      portalSenderAddresses,
      log: options.log,
    });
    if (otpFromGraph) return otpFromGraph;

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for a 6-digit OTP in ${mailbox}.`);
}
