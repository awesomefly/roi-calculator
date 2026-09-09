import type { Cohort, RoiObservation } from "../domain/types";

/**
 * Parses an explicitly marked percentage or a bare numeric ROI.
 * Bare numbers are deliberately not divided by 100.
 */
export function parseMetric(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const input = value.trim();
  if (!input) return null;

  const isPercent = input.endsWith("%");
  const numericText = isPercent ? input.slice(0, -1).trim() : input;
  if (!numericText) return null;

  const parsed = Number(numericText);
  if (!Number.isFinite(parsed)) return null;

  return isPercent ? parsed / 100 : parsed;
}

/** Converts a cohort's cumulative metric into sorted cumulative ROI observations. */
export function cohortToRoi(cohort: Cohort): RoiObservation[] {
  if (cohort.mode === "ltv_cac") {
    if (cohort.observations.some(({ cac }) => !Number.isFinite(cac) || cac <= 0)) return [];
    return cohort.observations.map((observation) => ({
      day: observation.day,
      value: observation.value / observation.cac,
      ...(observation.contributorCount === undefined ? {} : { contributorCount: observation.contributorCount }),
      ...(observation.contributingSpend === undefined ? {} : { contributingSpend: observation.contributingSpend }),
    })).sort((left, right) => left.day - right.day);
  }
  return cohort.observations.map((observation) => ({ ...observation })).sort((left, right) => left.day - right.day);
}
