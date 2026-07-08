// Začátek dnešního dne v UTC (stropy se resetují 00:00 UTC — viz OVERVIEW §8).
export function startOfUtcDayIso(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  return d.toISOString();
}

// Pole ISO začátků posledních `days` UTC dnů (od nejstaršího po dnešek).
export function lastUtcDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
