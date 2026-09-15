export const PASSWORD_POLICY_REQUIREMENTS = [
  "At least 12 characters",
  "At least one uppercase letter",
  "At least one lowercase letter",
  "At least one number",
] as const;

export function validatePasswordPolicy(password: string): string[] {
  const errors: string[] = [];
  if (password.length < 12) errors.push(PASSWORD_POLICY_REQUIREMENTS[0]);
  if (!/[A-Z]/.test(password)) errors.push(PASSWORD_POLICY_REQUIREMENTS[1]);
  if (!/[a-z]/.test(password)) errors.push(PASSWORD_POLICY_REQUIREMENTS[2]);
  if (!/\d/.test(password)) errors.push(PASSWORD_POLICY_REQUIREMENTS[3]);
  return errors;
}

export function passwordPolicyErrorMessage(password: string): string {
  const missing = validatePasswordPolicy(password);
  return missing.length
    ? `Password does not meet the required policy: ${missing.join(", ")}.`
    : "";
}
