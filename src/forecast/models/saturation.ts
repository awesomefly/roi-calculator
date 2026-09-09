import type { ModelResult, Observation } from "../../domain/types";
import { boundedOneDimensionalSearch, linearLeastSquares } from "../math";
import {
  buildDailyPredictions,
  invalidModelResult,
  prepareModelInput,
  type ForecastModel,
  type ModelContext,
} from "./model";

const ID = "saturation" as const;
const LABEL = "饱和模型";

interface SaturationParameters {
  ceiling: number;
  offset: number;
  rate: number;
  shape: number;
  squaredError: number;
}

function parametersAt(observations: Observation[], rate: number, shape: number, latestValue: number): SaturationParameters | null {
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(shape) || shape <= 0) return null;

  const transformedDays = observations.map((observation) => -Math.expm1(-Math.pow(rate * observation.day, shape)));
  const values = observations.map((observation) => observation.value);
  const regression = linearLeastSquares(transformedDays, values);
  if (!regression || regression.slope <= 0) return null;
  const ceiling = regression.slope;
  const offset = regression.intercept;
  if (!Number.isFinite(ceiling) || !Number.isFinite(offset) || offset + ceiling < latestValue || offset < -0.05) return null;

  let squaredError = 0;
  for (const observation of observations) {
    const fitted = ceiling * -Math.expm1(-Math.pow(rate * observation.day, shape)) + offset;
    const residual = (fitted - observation.value) / Math.max(observation.value, 0.01);
    squaredError += residual * residual;
  }
  return Number.isFinite(squaredError) ? { ceiling, offset, rate, shape, squaredError } : null;
}

function bestAtShape(observations: Observation[], shape: number, latestValue: number): SaturationParameters | null {
  const rateSearch = boundedOneDimensionalSearch(
    (logRate) => parametersAt(observations, Math.exp(logRate), shape, latestValue)?.squaredError ?? Number.POSITIVE_INFINITY,
    Math.log(1e-6),
    Math.log(10),
    { gridSize: 48, iterations: 50, tolerance: 1e-9 },
  );
  return rateSearch ? parametersAt(observations, Math.exp(rateSearch.x), shape, latestValue) : null;
}

export class SaturationModel implements ForecastModel {
  fit(observations: Observation[], context: ModelContext = {}): ModelResult {
    const prepared = prepareModelInput(observations, context);
    if (prepared.status !== "ok") return invalidModelResult(ID, LABEL, prepared.status, prepared.reason);
    if (prepared.input.observations.length < 3) {
      return invalidModelResult(ID, LABEL, "insufficient_data", "饱和模型至少需要三个有效观测点。");
    }

    const latestValue = prepared.input.observations[prepared.input.observations.length - 1]?.value ?? Number.NaN;
    const shapeSearch = boundedOneDimensionalSearch(
      (logShape) => bestAtShape(prepared.input.observations, Math.exp(logShape), latestValue)?.squaredError ?? Number.POSITIVE_INFINITY,
      Math.log(0.25),
      Math.log(4),
      { gridSize: 20, iterations: 28, tolerance: 1e-6 },
    );
    const parameters = shapeSearch ? bestAtShape(prepared.input.observations, Math.exp(shapeSearch.x), latestValue) : null;
    if (!parameters) {
      return invalidModelResult(ID, LABEL, "invalid", "饱和模型找不到满足上限约束的有限参数。");
    }

    const output = buildDailyPredictions(
      prepared.input.firstDay,
      prepared.input.forecastEndDay,
      (day) => parameters.ceiling * -Math.expm1(-Math.pow(parameters.rate * day, parameters.shape)) + parameters.offset,
    );
    if (output.reason) return invalidModelResult(ID, LABEL, "invalid", output.reason);
    return {
      id: ID,
      label: LABEL,
      status: "ok",
      parameters: { ceiling: parameters.ceiling, offset: parameters.offset, rate: parameters.rate, shape: parameters.shape },
      predictions: output.predictions,
    };
  }
}

export const saturationModel = new SaturationModel();
