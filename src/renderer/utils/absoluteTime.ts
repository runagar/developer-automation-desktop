/** Local `DD-MM-YYYY HH:mm`, e.g. "26-09-2026 14:55"; `''` for a missing or invalid value. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getDate())}-${pad(at.getMonth() + 1)}-${at.getFullYear()} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
