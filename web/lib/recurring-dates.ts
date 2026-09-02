/**
 * Generate weekly recurring calendar dates for a routine schedule — ports the
 * Python recurring mode (weekday + start_date + weeks). Returns YYYY-MM-DD
 * strings: the first occurrence of `weekday` on/after `startDate`, then every 7
 * days, `weeks` times. All in UTC so a date never shifts by timezone.
 */
export function recurringDates(startDate: string, weekday: number, weeks: number): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];
  const w = (((Math.floor(weekday) % 7) + 7) % 7); // 0=Sun..6=Sat
  const n = Math.max(1, Math.min(52, Math.floor(weeks) || 1));

  const first = new Date(start);
  const shift = (w - first.getUTCDay() + 7) % 7; // days to the first matching weekday
  first.setUTCDate(first.getUTCDate() + shift);

  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(first);
    d.setUTCDate(first.getUTCDate() + i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
