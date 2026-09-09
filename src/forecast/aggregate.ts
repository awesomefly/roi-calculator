import type { Cohort, Observation } from "../domain/types";
import { cohortToRoi } from "../validation/normalize";

const AGGREGATE_ID = "aggregate";
const AGGREGATE_NAME = "全部批次汇总";

function requirePositiveSpend(cohort: Cohort): number {
  const { spend } = cohort;
  if (!Number.isFinite(spend) || spend === undefined || spend <= 0) {
    throw new RangeError(`Cohort ${cohort.id} spend must be a positive finite number for aggregation.`);
  }
  return spend;
}

function validRoiObservations(cohort: Cohort): Observation[] {
  if (cohort.mode === "ltv_cac") {
    for (const observation of cohort.observations) {
      if (!Number.isFinite(observation.cac) || observation.cac <= 0) {
        throw new RangeError(`Cohort ${cohort.id} CAC must be a positive finite number in LTV/CAC mode.`);
      }
    }
  }

  const observations = cohortToRoi(cohort);
  const days = new Set<number>();
  for (const observation of observations) {
    if (
      !Number.isInteger(observation.day) ||
      observation.day <= 0 ||
      !Number.isFinite(observation.value) ||
      observation.value < 0 ||
      days.has(observation.day)
    ) {
      throw new RangeError(`Cohort ${cohort.id} has invalid observations for aggregation.`);
    }
    days.add(observation.day);
  }
  return observations;
}

/** Aggregates exact-day ROI values using each contributing cohort's acquisition cost. */
export function aggregateCohorts(cohorts: Cohort[]): Cohort {
  const valuesByDay = new Map<number, { weightedValue: number; spend: number; count: number }>();

  for (const cohort of cohorts) {
    const spend = requirePositiveSpend(cohort);
    for (const observation of validRoiObservations(cohort)) {
      const existing = valuesByDay.get(observation.day) ?? { weightedValue: 0, spend: 0, count: 0 };
      existing.weightedValue += observation.value * spend;
      existing.spend += spend;
      existing.count += 1;
      valuesByDay.set(observation.day, existing);
    }
  }

  const observations = [...valuesByDay.entries()]
    .sort(([leftDay], [rightDay]) => leftDay - rightDay)
    .map(([day, contribution]) => ({
      day,
      value: contribution.weightedValue / contribution.spend,
      contributorCount: contribution.count,
      contributingSpend: contribution.spend,
    }));

  return {
    id: AGGREGATE_ID,
    name: AGGREGATE_NAME,
    mode: "roi",
    observations,
  };
}
