export type RegalMfaPreferences = {
  preferredEmail?: string;
  preferredPhone?: string;
  preferredPhoneSuffix?: string;
  verificationMethod?: string;
};

export type RegalPreferenceOption = {
  value: string;
  label: string;
  description?: string;
  methodKey?: string;
  disabled?: boolean;
};

export function regalPhoneMethod(value: string): string {
  if (/sms|text/i.test(value)) return 'sms';
  if (/call|voice/i.test(value)) return 'call';
  return '';
}

function matchesRegalEmail(text: string, preferred: string): boolean {
  const email = preferred.trim().toLowerCase();
  if (!/^[^\s@*\u2022\u25cf]+@[^\s@*\u2022\u25cf]+\.[^\s@*\u2022\u25cf]+$/.test(email)) return false;
  const addresses = text.match(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+/g) || [];
  if (addresses.length !== 1) return false;
  const parts = addresses[0].replace(/[.!?]+$/, '').split('@');
  // A completely hidden mailbox cannot identify the configured recipient.
  if (!/[a-z0-9]/i.test(parts[0])) return false;
  const pattern = parts.map((part, index) => part.split(/[*\u2022\u25cf]+/)
    .map(chunk => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(index === 0 ? '[^@]+' : '[^@.]+')).join('@');
  return new RegExp(`^${pattern}$`, 'i').test(email);
}

export function matchRegalPreference<T extends RegalPreferenceOption>(
  options: T[], preferences: RegalMfaPreferences, stage: 'authenticator' | 'delivery',
): { option?: T; message?: string } {
  const phone = (preferences.preferredPhone || preferences.preferredPhoneSuffix || '').replace(/\D/g, '');
  const email = preferences.preferredEmail?.trim() || '';
  const method = preferences.verificationMethod?.trim() || '';
  const emailRequested = stage === 'authenticator' && (/^e[- ]?mail$/i.test(method) || !method && Boolean(email));
  const requested = stage === 'authenticator' ? Boolean(phone || email || method) : Boolean(method);
  if (!requested) return {};
  const normalizedMethod = regalPhoneMethod(method);
  const matches = options.filter(option => {
    if (option.disabled) return false;
    const text = `${option.label} ${option.description || ''}`;
    if (emailRequested) {
      return (!phone || Boolean(method))
        && /\be[- ]?mail\b/i.test(`${option.methodKey || ''} ${option.label}`.replace(/_/g, ' '))
        && matchesRegalEmail(text, email);
    }
    if (stage === 'authenticator' && !/phone|sms|text|call|voice/i.test(`${option.methodKey || ''} ${text}`)) return false;
    if (stage === 'authenticator' && phone) {
      const visibleDigits = (/[Xx*]/.test(text) ? text.split(/[Xx*]/).pop() || '' : text).replace(/\D/g, '');
      if (visibleDigits.length < 4 || phone.length < 4 || !phone.endsWith(visibleDigits) && !visibleDigits.endsWith(phone)) return false;
    }
    const optionMethod = regalPhoneMethod(text);
    return !method || Boolean(normalizedMethod) && (stage === 'authenticator' && !optionMethod || optionMethod === normalizedMethod);
  });
  if (matches.length === 1) return { option: matches[0] };
  return { message: matches.length
    ? 'The configured Regal MFA preference matches multiple options. Select an option manually.'
    : 'No available Regal MFA option matches the configured preference. Select an option manually.' };
}
