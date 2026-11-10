export type RegalMfaPreferences = {
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

export function matchRegalPreference<T extends RegalPreferenceOption>(
  options: T[], preferences: RegalMfaPreferences, stage: 'authenticator' | 'delivery',
): { option?: T; message?: string } {
  const phone = (preferences.preferredPhone || preferences.preferredPhoneSuffix || '').replace(/\D/g, '');
  const method = preferences.verificationMethod?.trim() || '';
  const requested = stage === 'authenticator' ? Boolean(phone || method) : Boolean(method);
  if (!requested) return {};
  const normalizedMethod = regalPhoneMethod(method);
  const matches = options.filter(option => {
    if (option.disabled) return false;
    const text = `${option.label} ${option.description || ''}`;
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
