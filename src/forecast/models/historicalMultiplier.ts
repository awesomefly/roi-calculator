import type { Cohort, ModelResult, Observation } from "../../domain/types";
import { cohortToRoi } from "../../validation/normalize";
import { weightedMedian } from "../math";
import { buildDailyPredictions } from "./model";

const ID = "historical_multiplier" as const;
const LABEL = "历史倍率";
const FORECAST_END_DAY = 360;
const MINIMUM_MATURE_COHORTS = 1;

interface MatureCohort {
  observations: Observation[];
  roi360: number;
  spend?: number;
}

interface RatioEntry {
  ratio: number;
  spend?: number;
}

interface MultiplierPoint {
  day: number;
  value: number;
}

function failure(status: "invalid" | "insufficient_data", reason: string): ModelResult {
  return { id: ID, label: LABEL, status, predictions: [], reason };
}

function isValidCumulativeCurve(observations: Observation[]): boolean {
  if (observations.length === 0) return false;

  let previousDay = 0;
  let previousValue = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    if (
      !Number.isInteger(observation.day) ||
      observation.day <= 0 ||
      observation.day > FORECAST_END_DAY ||
      observation.day === previousDay ||
      !Number.isFinite(observation.value) ||
      observation.value < 0 ||
      observation.value < previousValue
    ) {
      return false;
    }
    previousDay = observation.day;
    previousValue = observation.value;
  }
  return true;
}

function asMatureCohort(cohort: Cohort): MatureCohort | null {
  const observations = cohortToRoi(cohort);
  if (!isValidCumulativeCurve(observations)) return null;

  const roi360Points = observations.filter((observation) => observation.day === FORECAST_END_DAY);
  const roi360 = roi360Points[0]?.value;
  if (roi360Points.length !== 1 || roi360 === undefined || !Number.isFinite(roi360) || roi360 <= 0) {
    return null;
  }

  const spend = Number.isFinite(cohort.spend) && (cohort.spend ?? 0) > 0 ? cohort.spend : undefined;
  return { observations, roi360, spend };
}

function robustRatio(entries: RatioEntry[]): number | null {
  if (entries.length === 0) return null;
  return weightedMedian(
    entries.map((entry) => entry.ratio),
    entries.map(() => 1),
  );
}

function buildMultiplierShape(cohorts: MatureCohort[]): MultiplierPoint[] | null {
  const entriesByDay = new Map<number, RatioEntry[]>();

  for (const cohort of cohorts) {
    for (const observation of cohort.observations) {
      if (observation.value <= 0) continue;
      const ratio = cohort.roi360 / observation.value;
      if (!Number.isFinite(ratio) || ratio <= 0) continue;

      const entries = entriesByDay.get(observation.day) ?? [];
      entries.push({ ratio, spend: cohort.spend });
      entriesByDay.set(observation.day, entries);
    }
  }

  const shape: MultiplierPoint[] = [];
  for (const [day, entries] of entriesByDay) {
    const value = robustRatio(entries);
    if (value !== null && Number.isFinite(value) && value > 0) shape.push({ day, value });
  }
  shape.sort((left, right) => left.day - right.day);

  return shape.some((point) => point.day < FORECAST_END_DAY) && shape.some((point) => point.day === FORECAST_END_DAY)
    ? shape
    : null;
}

function interpolate(points: MultiplierPoint[], day: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return Number.NaN;
  if (day <= first.day) return first.value;
  if (day >= last.day) return last.value;

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    const left = points[index - 1];
    if (!left || !right || day > right.day) continue;
    const fraction = (day - left.day) / (right.day - left.day);
    return left.value + (right.value - left.value) * fraction;
  }
  return Number.NaN;
}

function interpolateObservedTarget(observations: Observation[], day: number): number {
  const first = observations[0];
  const last = observations[observations.length - 1];
  if (!first || !last) return Number.NaN;
  if (day <= first.day) return first.value;
  if (day >= last.day) return last.value;

  for (let index = 1; index < observations.length; index += 1) {
    const right = observations[index];
    const left = observations[index - 1];
    if (!left || !right || day > right.day) continue;
    const fraction = (day - left.day) / (right.day - left.day);
    return left.value + (right.value - left.value) * fraction;
  }
  return Number.NaN;
}

function fit(target: Cohort, training: Cohort[]): ModelResult {
  if (!target || !Array.isArray(training)) {
    return failure("invalid", "历史倍率模型输入无效。");
  }

  const targetObservations = cohortToRoi(target);
  if (!isValidCumulativeCurve(targetObservations)) {
    return failure("invalid", "目标批次必须包含有效、非递减的累计 ROI 曲线。");
  }

  const eligible = training
    .filter((cohort) => cohort?.id !== target.id)
    .map(asMatureCohort)
    .filter((cohort): cohort is MatureCohort => cohort !== null);
  if (eligible.length < MINIMUM_MATURE_COHORTS) {
    return failure("insufficient_data", "历史倍率模型至少需要一个不含目标批次的有效 ROI360 成熟批次。");
  }

  const multiplierShape = buildMultiplierShape(eligible);
  if (!multiplierShape) {
    return failure("invalid", "成熟批次没有足够的有效观测分母来构建历史倍率曲线。");
  }

  const latest = targetObservations[targetObservations.length - 1];
  if (!latest) return failure("invalid", "目标批次没有可用的累计 ROI 观测。");
  const anchorMultiplier = interpolate(multiplierShape, latest.day);
  if (!Number.isFinite(anchorMultiplier) || anchorMultiplier <= 0) {
    return failure("invalid", "目标批次最新观测日没有可用的历史倍率。");
  }

  const first = targetObservations[0];
  if (!first) return failure("invalid", "目标批次没有可用的累计 ROI 观测。");
  const output = buildDailyPredictions(first.day, FORECAST_END_DAY, (day) => {
    if (day <= latest.day) return interpolateObservedTarget(targetObservations, day);
    const dayMultiplier = interpolate(multiplierShape, day);
    return Math.max(latest.value, (latest.value * anchorMultiplier) / dayMultiplier);
  });
  if (output.reason) return failure("invalid", `历史倍率曲线无效：${output.reason}`);

  return { id: ID, label: LABEL, status: "ok", predictions: output.predictions };
}

export function fitHistoricalMultiplier(target: Cohort, training: Cohort[]): ModelResult {
  try {
    return fit(target, training);
  } catch {
    return failure("invalid", "历史倍率模型计算失败，请检查批次数据。");
  }
}

/** Builds the saved multi-cohort curve from equal-weight same-day multiplier medians. */
export function fitAggregateHistoricalMultiplier(cohorts: Cohort[]): ModelResult {
  try {
    const mature = cohorts.map(asMatureCohort).filter((cohort): cohort is MatureCohort => cohort !== null);
    if (mature.length === 0) {
      return failure("insufficient_data", "历史倍率模型至少需要一个含真实 D360 的成熟批次。");
    }
    const shape = buildMultiplierShape(mature);
    if (!shape) return failure("invalid", "成熟批次没有足够的真实观测日来构建历史倍率曲线。");
    const meanRoi360 = mature.reduce((sum, cohort) => sum + cohort.roi360, 0) / mature.length;
    let previous = 0;
    const output = buildDailyPredictions(1, FORECAST_END_DAY, (day) => {
      const multiplier = interpolate(shape, day);
      const value = meanRoi360 / multiplier;
      previous = Math.max(previous, value);
      return previous;
    });
    if (output.reason) return failure("invalid", `历史倍率批次综合曲线无效：${output.reason}`);
    return {
      id: ID,
      label: LABEL,
      status: "ok",
      parameters: { matureCohortCount: mature.length, meanObservedD360: meanRoi360 },
      predictions: output.predictions,
    };
  } catch {
    return failure("invalid", "历史倍率批次综合曲线计算失败，请检查批次数据。");
  }
}

/** Builds an empirical single-cohort curve only when D360 is actually observed. */
export function fitSingleCohortHistoricalMultiplier(observations: Observation[]): ModelResult {
  try {
    const sorted = observations.map((point) => ({ ...point })).sort((left, right) => left.day - right.day);
    if (!isValidCumulativeCurve(sorted)) return failure("invalid", "历史倍率模型需要有效、非递减的累计 ROI 观测。");
    const roi360 = sorted.find((point) => point.day === FORECAST_END_DAY)?.value;
    const earlier = sorted.filter((point) => point.day < FORECAST_END_DAY && point.value > 0);
    if (roi360 === undefined || !Number.isFinite(roi360) || roi360 <= 0 || earlier.length === 0) {
      return failure("insufficient_data", "历史倍率模型需要真实 D360 观测和至少一个更早的正 ROI 观测点。");
    }
    const output = buildDailyPredictions(1, FORECAST_END_DAY, (day) => interpolateObservedTarget(sorted, day));
    if (output.reason) return failure("invalid", `历史倍率曲线无效：${output.reason}`);
    return {
      id: ID,
      label: LABEL,
      status: "ok",
      parameters: { observedD360: roi360, observedPointCount: sorted.length },
      predictions: output.predictions,
    };
  } catch {
    return failure("invalid", "历史倍率模型计算失败，请检查批次数据。");
  }
}
