export function appendSetCookieHeaders(target: Headers, source: Headers): void {
  const setCookie = source.get("set-cookie");
  if (setCookie) {
    target.append("set-cookie", setCookie);
  }
}
