export function linuxChromeUserAgent(browserVersion: string | undefined): string {
  const majorVersion = String(browserVersion || "").match(/\d+/)?.[0] || "122";
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
}
