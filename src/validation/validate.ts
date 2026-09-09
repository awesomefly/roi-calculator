import type { Cohort, Observation } from "../domain/types";
import { cohortToRoi } from "./normalize";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  cohortId: string;
  field: string;
  message: string;
  severity: ValidationSeverity;
}

export interface ValidationOptions {
  repairMonotonic?: boolean;
  requireSpend?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  cohorts: Cohort[];
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const observationOrder = (left: Observation, right: Observation) => left.day - right.day;

/** Returns sorted copies with every value raised to the prior cumulative maximum. */
export function cumulativeMax<T extends Observation>(observations: T[]): T[] {
  let maximum = Number.NEGATIVE_INFINITY;

  return observations
    .map((observation) => ({ ...observation }))
    .sort(observationOrder)
    .map((observation) => {
      maximum = Math.max(maximum, observation.value);
      return { ...observation, value: maximum };
    });
}

export function validateCohorts(cohorts: Cohort[], options: ValidationOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const names = new Set<string>();

  const normalizedCohorts = cohorts.map((cohort) => {
    const observations = cohort.observations.map((observation) => ({ ...observation }));
    const sortedObservations = [...observations].sort(observationOrder);
    let normalized = { ...cohort, observations } as Cohort;
    const addError = (field: string, message: string) => {
      errors.push({ cohortId: cohort.id, field, message, severity: "error" });
    };

    if (names.has(cohort.name)) {
      addError("name", "Cohort name must be unique.");
    }
    names.add(cohort.name);

    const seenDays = new Set<number>();
    for (const observation of sortedObservations) {
      if (Number.isInteger(observation.day) && observation.day > 360) {
        addError("observations.day", `Day ${observation.day} must be between 1 and 360.`);
      } else if (!Number.isInteger(observation.day) || observation.day <= 0) {
        addError("observations.day", `Day ${observation.day} must be a positive integer.`);
      } else if (seenDays.has(observation.day)) {
        addError("observations.day", `Day ${observation.day} must not be duplicated.`);
      }
      seenDays.add(observation.day);

      if (!Number.isFinite(observation.value) || observation.value < 0) {
        addError("observations.value", `Value at day ${observation.day} must be a non-negative finite number.`);
      }
      if (cohort.mode === "ltv_cac") {
        const cac = "cac" in observation ? observation.cac : undefined;
        if (!Number.isFinite(cac) || cac === undefined || cac <= 0) {
          addError("observations.cac", `CAC at day ${observation.day} must be a positive finite number.`);
        }
      }
      if (cohort.mode === "roi_retention" && "retention" in observation && observation.retention !== undefined
        && (!Number.isFinite(observation.retention) || observation.retention < 0 || observation.retention > 1)) {
        addError("observations.retention", `Retention at day ${observation.day} must be between 0 and 1.`);
      }
    }

    if (options.requireSpend && (!Number.isFinite(cohort.spend) || !cohort.spend || cohort.spend <= 0)) {
      addError("spend", "Spend must be a positive finite number for aggregation.");
    }

    const descendingDays: number[] = [];
    let previousValue = Number.NEGATIVE_INFINITY;
    for (const observation of sortedObservations) {
      if (Number.isFinite(observation.value) && observation.value < previousValue) {
        descendingDays.push(observation.day);
      }
      if (Number.isFinite(observation.value)) {
        previousValue = Math.max(previousValue, observation.value);
      }
    }

    if (descendingDays.length > 0 && !options.repairMonotonic) {
      addError("observations.value", `Cumulative values decrease at day(s): ${descendingDays.join(", ")}.`);
    } else if (descendingDays.length > 0) {
      warnings.push({
        cohortId: cohort.id,
        field: "observations.value",
        message: `Cumulative values were repaired at day(s): ${descendingDays.join(", ")}.`,
        severity: "warning",
      });
      normalized = { ...normalized, observations: cumulativeMax(sortedObservations) } as Cohort;
    }

    if (cohort.mode === "ltv_cac" && !errors.some((error) => error.cohortId === cohort.id && error.field === "observations.cac")) {
      const descendingRoiDays: number[] = [];
      let previousRoi = Number.NEGATIVE_INFINITY;
      for (const observation of cohortToRoi(normalized).sort(observationOrder)) {
        if (observation.value < previousRoi - 1e-12) descendingRoiDays.push(observation.day);
        previousRoi = Math.max(previousRoi, observation.value);
      }
      if (descendingRoiDays.length > 0) {
        addError("observations.roi", `Converted cumulative ROI decreases at day(s): ${descendingRoiDays.join(", ")}.`);
      }
    }

    return normalized;
  });

  return {
    isValid: errors.length === 0,
    cohorts: normalizedCohorts,
    issues: [...errors, ...warnings],
    errors,
    warnings,
  };
}
