/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TimeMode = 'ksp' | 'earth';

// KSP: 6h day, 426d year
const KSP_DAY_SEC = 21600;
const KSP_YEAR_SEC = 426 * KSP_DAY_SEC; // 9,201,600s

// Earth: 24h day, 365d year
const EARTH_DAY_SEC = 86400;
const EARTH_YEAR_SEC = 365 * EARTH_DAY_SEC; // 31,536,000s

export function formatUT(utSeconds: number | undefined | null, mode: TimeMode): string {
  if (utSeconds === undefined || utSeconds === null || isNaN(utSeconds)) {
    return 'Unconstrained';
  }

  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  const yearSec = mode === 'ksp' ? KSP_YEAR_SEC : EARTH_YEAR_SEC;
  const daysInYear = mode === 'ksp' ? 426 : 365;

  const totalSeconds = Math.max(0, utSeconds);
  const year = Math.floor(totalSeconds / yearSec) + 1;
  const remSecYear = totalSeconds % yearSec;
  const day = Math.floor(remSecYear / daySec) + 1;
  const remSecDay = Math.floor(remSecYear % daySec);

  const hours = Math.floor(remSecDay / 3600);
  const minutes = Math.floor((remSecDay % 3600) / 60);
  const seconds = Math.floor(remSecDay % 60);

  const pad = (n: number) => String(n).padStart(2, '0');

  return `Y${year} D${day} ${pad(hours)}:${pad(minutes)}:${pad(seconds)} (${Math.round(utSeconds).toLocaleString()}s)`;
}

export function formatShortUT(utSeconds: number | undefined | null, mode: TimeMode): string {
  if (utSeconds === undefined || utSeconds === null || isNaN(utSeconds)) {
    return 'Any';
  }

  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  const yearSec = mode === 'ksp' ? KSP_YEAR_SEC : EARTH_YEAR_SEC;

  const totalSeconds = Math.max(0, utSeconds);
  const year = Math.floor(totalSeconds / yearSec) + 1;
  const remSecYear = totalSeconds % yearSec;
  const day = Math.floor(remSecYear / daySec) + 1;

  return `Y${year} D${day}`;
}

export function formatDuration(durationSec: number | undefined | null, mode: TimeMode): string {
  if (durationSec === undefined || durationSec === null || isNaN(durationSec)) {
    return '0s';
  }

  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  const yearSec = mode === 'ksp' ? KSP_YEAR_SEC : EARTH_YEAR_SEC;

  const years = Math.floor(durationSec / yearSec);
  const remSecYear = durationSec % yearSec;
  const days = Math.floor(remSecYear / daySec);
  const remSecDay = Math.floor(remSecYear % daySec);
  const hours = Math.floor(remSecDay / 3600);

  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (days > 0 || years > 0 || parts.length === 0) parts.push(`${days}d`);
  //if (hours > 0 || parts.length === 0) parts.push(`${hours}h`);

  return parts.join(' ');
}

export function utToYearDay(utSeconds: number | undefined | null, mode: TimeMode): { year: number; day: number } {
  if (utSeconds === undefined || utSeconds === null || isNaN(utSeconds) || utSeconds < 0) {
    return { year: 1, day: 1 };
  }

  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  const yearSec = mode === 'ksp' ? KSP_YEAR_SEC : EARTH_YEAR_SEC;

  const totalSeconds = Math.max(0, utSeconds);
  const year = Math.floor(totalSeconds / yearSec) + 1;
  const remSecYear = totalSeconds % yearSec;
  const day = Math.floor(remSecYear / daySec) + 1;

  return { year, day };
}

export function parseKSPTimeToUT(year: number, day: number, hours: number, minutes: number, seconds: number, mode: TimeMode): number {
  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  const yearSec = mode === 'ksp' ? KSP_YEAR_SEC : EARTH_YEAR_SEC;

  const yZero = Math.max(0, year - 1);
  const dZero = Math.max(0, day - 1);

  return yZero * yearSec + dZero * daySec + hours * 3600 + minutes * 60 + seconds;
}

export function daysToSeconds(days: number, mode: TimeMode): number {
  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  return days * daySec;
}

export function secondsToDays(seconds: number, mode: TimeMode): number {
  const daySec = mode === 'ksp' ? KSP_DAY_SEC : EARTH_DAY_SEC;
  return seconds / daySec;
}
