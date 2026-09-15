export function mediCalDatesMatch(actual: string, expected: string): boolean {
  const normalize = (value: string): string | null => {
    const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
    const named = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(value.trim());
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const month = numeric ? Number(numeric[1]) : named ? months.indexOf(named[1].toLowerCase()) + 1 : 0;
    const day = Number(numeric?.[2] ?? named?.[2]);
    const year = Number(numeric?.[3] ?? named?.[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (!month || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return `${year}-${month}-${day}`;
  };
  const left = normalize(actual);
  return left !== null && left === normalize(expected);
}

// Use the operator's business timezone, independently of the worker timezone.
export function mediCalIssueDate(now = new Date(), timeZone = 'Asia/Kolkata'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const date = new Date(Date.UTC(read('year'), read('month') - 1, read('day')));
  if (read('hour') < 15) date.setUTCDate(date.getUTCDate() - 1);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}
