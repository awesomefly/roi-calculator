import type { ForecastPoint, ModelResult, Observation } from "../../domain/types";

export interface ModelContext {
  /** Defaults to D360 and may not exceed this application's D360 horizon. */
  forecastEndDay?: number;
}

export interface ForecastModel {
  fit(observations: Observation[], context: ModelContext): ModelResult;
}

export type ParametricModelId = Extract<ModelResult["id"], "logarithmic" | "power" | "saturation">;

export interface PreparedModelInput {
  observations: Observation[];
  firstDay: number;
  forecastEndDay: number;
}

export type PreparationResult =
  | { status: "ok"; input: PreparedModelInput }
  | { status: "invalid" | "insufficient_data"; reason: string };

export function prepareModelInput(observations: Observation[], context: ModelContext = {}): PreparationResult {
  if (!Array.isArray(observations) || observations.length < 2) {
    return { status: "insufficient_data", reason: "至少需要两个观测点才能拟合模型。" };
  }

  const requestedEndDay = context.forecastEndDay ?? 360;
  if (!Number.isSafeInteger(requestedEndDay) || requestedEndDay <= 0 || requestedEndDay > 360) {
    return { status: "invalid", reason: "预测截止日必须是 D1 到 D360 之间的安全整数。" };
  }
  const forecastEndDay = 360;

  const sorted = observations.map((observation) => ({ ...observation })).sort((left, right) => left.day - right.day);
  let previousDay = 0;
  let previousValue = Number.NEGATIVE_INFINITY;
  for (const observation of sorted) {
    if (!Number.isInteger(observation.day) || observation.day <= 0 || observation.day > 360) {
      return { status: "invalid", reason: "观测日必须是 D1 到 D360 之间的整数。" };
    }
    if (observation.day === previousDay) {
      return { status: "invalid", reason: "观测日不能重复。" };
    }
    if (!Number.isFinite(observation.value) || observation.value < 0) {
      return { status: "invalid", reason: "观测值必须是非负有限数。" };
    }
    if (observation.value < previousValue) {
      return { status: "invalid", reason: "累计 ROI 观测值不能下降。" };
    }
    previousDay = observation.day;
    previousValue = observation.value;
  }

  return {
    status: "ok",
    input: { observations: sorted, firstDay: sorted[0]?.day ?? 1, forecastEndDay },
  };
}

export function invalidModelResult(
  id: ParametricModelId,
  label: string,
  status: "invalid" | "insufficient_data",
  reason: string,
): ModelResult {
  return { id, label, status, predictions: [], reason };
}

/** Returns a Chinese reason for an invalid series, otherwise null. */
export function validatePredictionSeries(predictions: ForecastPoint[]): string | null {
  if (predictions.length === 0) return "模型没有生成预测结果。";

  let previousDay: number | undefined;
  let previousValue = Number.NEGATIVE_INFINITY;
  for (const prediction of predictions) {
    if (!Number.isInteger(prediction.day) || (previousDay !== undefined && prediction.day !== previousDay + 1)) {
      return "模型必须生成连续的逐日预测。";
    }
    if (!Number.isFinite(prediction.value)) return "模型生成了非有限预测值。";
    if (prediction.value < 0) return "模型生成了负数预测值。";
    if (prediction.value < previousValue) return "模型生成了递减的累计 ROI。";
    previousDay = prediction.day;
    previousValue = prediction.value;
  }
  return null;
}

export function buildDailyPredictions(
  firstDay: number,
  forecastEndDay: number,
  predict: (day: number) => number,
): { predictions: ForecastPoint[]; reason: string | null } {
  const predictions: ForecastPoint[] = [];
  try {
    for (let day = firstDay; day <= forecastEndDay; day += 1) {
      predictions.push({ day, value: predict(day) });
    }
  } catch {
    return { predictions: [], reason: "模型计算预测值时失败。" };
  }
  const reason = validatePredictionSeries(predictions);
  return reason ? { predictions: [], reason } : { predictions, reason: null };
}
