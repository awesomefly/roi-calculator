import type { ForecastPoint, RoiObservation, RoiRetentionCohort } from "../../domain/types";
import { anchorMonotoneCurve, retentionAtDay, safeLogit } from "./retentionMath";

export interface TrainedMonotoneRetentionSpline { cohorts: RoiRetentionCohort[]; sampleCount: number }

function interpolateRoi(observations: RoiObservation[], day: number): number | undefined {
  const sorted = observations.filter((point) => point.value >= 0).sort((left, right) => left.day - right.day);
  const exact = sorted.find((point) => point.day === day);
  if (exact) return exact.value;
  const rightIndex = sorted.findIndex((point) => point.day > day);
  if (rightIndex <= 0) return rightIndex === 0 ? sorted[0]?.value : sorted[sorted.length - 1]?.value;
  const left = sorted[rightIndex - 1]!;
  const right = sorted[rightIndex]!;
  const progress = (Math.log(day) - Math.log(left.day)) / (Math.log(right.day) - Math.log(left.day));
  return left.value + progress * (right.value - left.value);
}

function monotoneCubic(knots: Array<{ day: number; value: number }>): ForecastPoint[] {
  const sorted = knots.sort((left, right) => left.day - right.day);
  for (let index = 1; index < sorted.length; index += 1) sorted[index]!.value = Math.max(sorted[index - 1]!.value, sorted[index]!.value);
  const slopes = sorted.slice(0, -1).map((point, index) => (sorted[index + 1]!.value - point.value) / (sorted[index + 1]!.day - point.day));
  const tangents = sorted.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === sorted.length - 1) return slopes[slopes.length - 1] ?? 0;
    const left = slopes[index - 1] ?? 0;
    const right = slopes[index] ?? 0;
    return left <= 0 || right <= 0 ? 0 : 2 * left * right / (left + right);
  });
  let floor = 0;
  return Array.from({ length: 360 }, (_, index) => {
    const day = index + 1;
    const exact = sorted.find((point) => point.day === day);
    if (exact) { floor = Math.max(floor, exact.value); return { day, value: floor }; }
    const rightIndex = sorted.findIndex((point) => point.day > day);
    if (rightIndex <= 0) return { day, value: floor };
    if (rightIndex < 0) { floor = Math.max(floor, sorted[sorted.length - 1]?.value ?? floor); return { day, value: floor }; }
    const left = sorted[rightIndex - 1]!;
    const right = sorted[rightIndex]!;
    const width = right.day - left.day;
    const t = (day - left.day) / width;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    const value = h00 * left.value + h10 * width * tangents[rightIndex - 1]! + h01 * right.value + h11 * width * tangents[rightIndex]!;
    floor = Math.max(floor, Math.min(right.value, Math.max(left.value, value)));
    return { day, value: floor };
  });
}

export function trainMonotoneRetentionSpline(cohorts: RoiRetentionCohort[]): TrainedMonotoneRetentionSpline | undefined {
  const mature = cohorts.filter((cohort) => cohort.observations.some((point) => point.day === 360 && point.value > 0));
  return mature.length ? { cohorts: mature, sampleCount: mature.reduce((sum, cohort) => sum + cohort.observations.length, 0) } : undefined;
}

export function predictMonotoneRetentionSpline(
  model: TrainedMonotoneRetentionSpline,
  cohort: Pick<RoiRetentionCohort, "observations">,
  anchors = cohort.observations,
): ForecastPoint[] {
  const latest = [...cohort.observations].filter((point) => point.day < 360 && point.value > 0).sort((left, right) => left.day - right.day).pop()
    ?? [...cohort.observations].filter((point) => point.value > 0).sort((left, right) => left.day - right.day)[0];
  if (!latest) return [];
  const queryRetention = cohort.observations.filter((point) => point.retention !== undefined);
  const candidates = model.cohorts.flatMap((historical) => {
    const historicalAtLatest = interpolateRoi(historical.observations, latest.day);
    if (historicalAtLatest === undefined || historicalAtLatest <= 0) return [];
    const differences = queryRetention.map((point) => safeLogit(point.retention!) - safeLogit(retentionAtDay(historical.observations, point.day)));
    const distance = differences.length ? Math.sqrt(differences.reduce((sum, value) => sum + value ** 2, 0) / differences.length) : 0;
    return [{ historical, scale: latest.value / historicalAtLatest, weight: Math.exp(-0.5 * (distance / 0.8) ** 2) }];
  });
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (!candidates.length || totalWeight <= 1e-12) return [];
  const days = [...new Set([1, 7, 30, 60, 90, 180, 360, ...model.cohorts.flatMap((item) => item.observations.map((point) => point.day))])].sort((a, b) => a - b);
  const knots = days.map((day) => ({
    day,
    value: candidates.reduce((sum, candidate) => sum + candidate.weight * candidate.scale * (interpolateRoi(candidate.historical.observations, day) ?? 0), 0) / totalWeight,
  }));
  return anchorMonotoneCurve(monotoneCubic(knots), anchors);
}
