import type { ModelResult, Observation } from "../../domain/types";
import { median } from "../math";
import {
  buildDailyPredictions,
  invalidModelResult,
  prepareModelInput,
  type ForecastModel,
  type ModelContext,
} from "./model";

const ID = "power" as const;
const LABEL = "幂函数模型";

export class PowerModel implements ForecastModel {
  fit(observations: Observation[], context: ModelContext = {}): ModelResult {
    const prepared = prepareModelInput(observations, context);
    if (prepared.status !== "ok") return invalidModelResult(ID, LABEL, prepared.status, prepared.reason);
    if (prepared.input.observations.some((observation) => observation.value <= 0)) {
      return invalidModelResult(ID, LABEL, "invalid", "幂函数模型要求所有观测值大于零。");
    }

    const xs = prepared.input.observations.map((observation) => Math.log(observation.day));
    const ys = prepared.input.observations.map((observation) => Math.log(observation.value));
    const slopes: number[] = [];
    for (let left = 0; left < xs.length; left += 1) {
      for (let right = left + 1; right < xs.length; right += 1) {
        const deltaX = (xs[right] ?? 0) - (xs[left] ?? 0);
        if (Math.abs(deltaX) > Number.EPSILON) slopes.push(((ys[right] ?? 0) - (ys[left] ?? 0)) / deltaX);
      }
    }
    const slope = median(slopes);
    const intercept = slope === null ? null : median(ys.map((value, index) => value - slope * (xs[index] ?? 0)));
    if (slope === null || intercept === null || slope < 0) {
      return invalidModelResult(ID, LABEL, "invalid", "幂函数模型参数不可用，无法生成非递减预测。");
    }

    const output = buildDailyPredictions(
      prepared.input.firstDay,
      prepared.input.forecastEndDay,
      (day) => Math.exp(intercept + slope * Math.log(day)),
    );
    if (output.reason) return invalidModelResult(ID, LABEL, "invalid", output.reason);
    return {
      id: ID,
      label: LABEL,
      status: "ok",
      parameters: { coefficient: Math.exp(intercept), exponent: slope, robustMethod: 1 },
      predictions: output.predictions,
    };
  }
}

export const powerModel = new PowerModel();
