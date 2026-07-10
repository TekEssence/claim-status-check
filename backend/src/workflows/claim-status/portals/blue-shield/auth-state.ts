export function isBlueShieldPingAuthorizationUrl(url: string): boolean {
  return /ping-ext\.blueshieldca\.com|\/resume\/as\/authorization\.ping/i.test(url);
}
