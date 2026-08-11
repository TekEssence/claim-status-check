import { generateAvailityEligibilityTotp } from "../availity/totp";

export function generateUhcEligibilityTotp(
  secretKey: string,
  timeOffsetSeconds = 0,
): string {
  try {
    return generateAvailityEligibilityTotp(secretKey, timeOffsetSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll("Availity", "UHC"));
  }
}
