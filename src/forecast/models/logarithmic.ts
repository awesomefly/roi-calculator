import type { ModelResult, Observation } from "../../domain/types";
import { boundedOneDimensionalSearch, linearLeastSquares } from "../math";
import {
  buildDailyPredictions,
  invalidModelResult,
  prepareModelInput,
  type ForecastModel,
  type ModelContext,
} from "./model";

const ID = "logarithmic" as const;
const LABEL = "对数模型";

export class LogarithmicModel implements ForecastModel {
  fit(observations: Observation[], context: ModelContext = {}): ModelResult {
    const prepared = prepareModelInput(observations, context);
    if (prepared.status !== "ok") return invalidModelResult(ID, LABEL, prepared.status, prepared.reason);

    const fitAtOffset = (offset: number) => {
      const xs = prepared.input.observations.map((point) => Math.log(point.day + offset));
      const ys = prepared.input.observations.map((point) => point.value);
      const regression = linearLeastSquares(xs, ys);
      if (!regression || regression.slope < 0) return null;
      const error = prepared.input.observations.reduce((sum, point, index) => {
        const fitted = regression.intercept + regression.slope * (xs[index] ?? 0);
        if (!Number.isFinite(fitted) || fitted < 0) return Number.POSITIVE_INFINITY;
        const relative = (fitted - point.value) / Math.max(point.value, 0.01);
        return sum + relative * relative;
      }, 0);
      return { ...regression, offset, error };
    };
    const search = boundedOneDimensionalSearch(
      (logOffset) => fitAtOffset(Math.exp(logOffset))?.error ?? Number.POSITIVE_INFINITY,
      Math.log(0.01),
      Math.log(360),
      { gridSize: 96, iterations: 80, tolerance: 1e-9 },
    );
    const parameters = search ? fitAtOffset(Math.exp(search.x)) : null;
    if (!parameters) {
      return invalidModelResult(ID, LABEL, "invalid", "对数模型参数不可用，无法生成非递减预测。");
    }

    const output = buildDailyPredictions(
      prepared.input.firstDay,
      prepared.input.forecastEndDay,
      (day) => parameters.intercept + parameters.slope * Math.log(day + parameters.offset),
    );
    if (output.reason) return invalidModelResult(ID, LABEL, "invalid", output.reason);
    return {
      id: ID,
      label: LABEL,
      status: "ok",
      parameters: { intercept: parameters.intercept, slope: parameters.slope, timeOffset: parameters.offset },
      predictions: output.predictions,
    };
  }
}

export const logarithmicModel = new LogarithmicModel();
