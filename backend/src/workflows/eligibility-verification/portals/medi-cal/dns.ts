import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const officialHosts = ['www.medi-cal.ca.gov', 'mcweb.apps.prd.cammis.medi-cal.ca.gov', 'provider-portal.apps.prd.cammis.medi-cal.ca.gov', 'secure.medi-cal.ca.gov', 'raiseis.cammis.medi-cal.ca.gov'];

export async function mediCalDnsArgs(loginUrl: string, log: (message: string) => Promise<void> = async () => {}, dependencies = {
  lookup: (host: string) => lookup(host),
  resolve: async (host: string): Promise<string> => {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Secure DNS lookup failed.');
    const data = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    const address = data.Status === 0 ? data.Answer?.find(answer => answer.type === 1 && isIP(answer.data) === 4)?.data : undefined;
    if (!address) throw new Error('Secure DNS returned no IPv4 address.');
    return address;
  },
}): Promise<string[]> {
  if (!officialHosts.includes(new URL(loginUrl).hostname)) return [];
  const rules: string[] = [];
  for (const host of officialHosts) {
    try { await dependencies.lookup(host); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!['ENOTFOUND', 'EAI_AGAIN'].includes(code ?? '')) throw error;
      let address: string;
      try { address = await dependencies.resolve(host); }
      catch { throw new Error(`Cannot resolve Medi-Cal host ${host} using system or secure DNS. Check network access and retry.`); }
      if (isIP(address) !== 4) throw new Error('Secure DNS returned an invalid address.');
      rules.push(`MAP ${host} ${address}`);
      await log(`System DNS could not resolve ${host}; using secure DNS for this browser session. HTTPS certificate verification remains enabled.`);
    }
  }
  return rules.length ? [`--host-resolver-rules=${rules.join(', ')}`] : [];
}
