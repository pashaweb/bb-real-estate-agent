// Shared formatting for the panel and the detail dialog.

export const eur = (n: number | null | undefined): string =>
  n == null ? '—' : `€${Math.round(n).toLocaleString('es-ES')}`;

export const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`;

/** Green above 8, amber to 6.5, red below. Matches the CLI's verdict bands. */
export const scoreTone = (n: number): string =>
  n >= 8
    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    : n >= 6.5
      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
      : 'bg-red-500/15 text-red-600 dark:text-red-400';

export const districtTone = (flag: string | undefined): string =>
  flag === 'green'
    ? 'bg-emerald-500'
    : flag === 'red'
      ? 'bg-red-500'
      : 'bg-amber-500';
