import { describe, expect, it } from "vitest";
import type { ForecastPoint, ModelResult, Observation } from "../../domain/types";
import {
  boundedOneDimensionalSearch,
  linearLeastSquares,
  median,
  quantile,
  weightedMedian,
} from "../math";
import { logarithmicModel } from "./logarithmic";
import { buildDailyPredictions, prepareModelInput, validatePredictionSeries } from "./model";
import { powerModel } from "./power";
import { saturationModel } from "./saturation";

const days = [1, 7, 30, 60, 120];

function observationsFor(formula: (day: number) => number): Observation[] {
  return days.map((day) => ({ day, value: formula(day) }));
}

function expectValidDailyForecast(result: ModelResult, expectedRoi360: number): void {
  expect(result.status, result.reason).toBe("ok");
  expect(result.predictions).toHaveLength(360);
  expect(result.predictions[0]?.day).toBe(1);
  expect(result.predictions[result.predictions.length - 1]?.day).toBe(360);

  for (let index = 0; index < result.predictions.length; index += 1) {
    const point = result.predictions[index];
    expect(point?.day).toBe(index + 1);
    expect(Number.isFinite(point?.value)).toBe(true);
    expect(point?.value).toBeGreaterThanOrEqual(0);
    if (index > 0) {
      expect(point?.value).toBeGreaterThanOrEqual(result.predictions[index - 1]?.value ?? 0);
    }
  }

  const actualRoi360 = result.predictions[result.predictions.length - 1]?.value ?? Number.NaN;
  expect(Math.abs(actualRoi360 - expectedRoi360) / expectedRoi360).toBeLessThanOrEqual(0.05);
}

describe("numerical helpers", () => {
  it("fits an intercept and slope with ordinary least squares", () => {
    const result = linearLeastSquares([1, 2, 4], [5, 8, 14]);

    expect(result?.intercept).toBeCloseTo(2, 12);
    expect(result?.slope).toBeCloseTo(3, 12);
  });

  it("returns null for singular or invalid regression input", () => {
    expect(linearLeastSquares([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(linearLeastSquares([1, 2], [1, Number.NaN])).toBeNull();
    expect(linearLeastSquares([1], [2])).toBeNull();
    expect(linearLeastSquares([1, 2], [3])).toBeNull();
  });

  it("calculates interpolated quantiles and medians without mutating input", () => {
    const values = [4, 1, 3, 2];

    expect(quantile(values, 0.25)).toBe(1.75);
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(4);
    expect(median(values)).toBe(2.5);
    expect(values).toEqual([4, 1, 3, 2]);
  });

  it("returns null for invalid quantiles and calculates a weight-aware median", () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([1, Number.POSITIVE_INFINITY], 0.5)).toBeNull();
    expect(quantile([1, 2], -0.1)).toBeNull();
    expect(weightedMedian([1, 10, 100], [1, 8, 1])).toBe(10);
    expect(weightedMedian([1, 2], [0, 0])).toBeNull();
    expect(weightedMedian([1, 2], [1, -1])).toBeNull();
  });

  it("interpolates extreme finite quantiles without overflowing", () => {
    const result = quantile([-Number.MAX_VALUE, Number.MAX_VALUE], 0.5);

    expect(result).toBe(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it("finds a finite minimum inside explicit bounds and rejects invalid objectives", () => {
    const result = boundedOneDimensionalSearch((value) => (value - 2.25) ** 2 + 4, -5, 8);

    expect(result?.x).toBeCloseTo(2.25, 5);
    expect(result?.value).toBeCloseTo(4, 8);
    expect(boundedOneDimensionalSearch(() => Number.NaN, 0, 1)).toBeNull();
    expect(boundedOneDimensionalSearch((value) => value, 1, 1)).toBeNull();
  });
});

describe("prediction validation", () => {
  it.each([
    ["negative", [{ day: 1, value: -0.1 }]],
    ["decreasing", [{ day: 1, value: 0.2 }, { day: 2, value: 0.1 }]],
    ["non-finite", [{ day: 1, value: Number.POSITIVE_INFINITY }]],
  ] satisfies Array<[string, ForecastPoint[]]>)("rejects %s model output", (_case, predictions) => {
    expect(validatePredictionSeries(predictions)).toMatch(/[\u4e00-\u9fff]/u);
  });

  it("accepts finite non-negative non-decreasing daily output", () => {
    expect(validatePredictionSeries([{ day: 1, value: 0 }, { day: 2, value: 0.2 }])).toBeNull();
  });

  it("does not return prediction points when exponential output overflows", () => {
    const result = buildDailyPredictions(1, 360, () => Math.exp(1_000));

    expect(result.predictions).toEqual([]);
    expect(result.reason).toMatch(/[\u4e00-\u9fff]/u);
  });
});

describe("parametric forecast models", () => {
  it("recovers a deterministic logarithmic curve through day 360", () => {
    const result = logarithmicModel.fit(observationsFor((day) => 0.2 + 0.4 * Math.log(day)), {
      forecastEndDay: 360,
    });

    expectValidDailyForecast(result, 2.5544416125800624);
  });

  it("anchors the logarithmic curve to the first demo observation without negative predictions", () => {
    const observations: Observation[] = [
      { day: 1, value: 0.1 },
      { day: 7, value: 0.25 },
      { day: 15, value: 0.36 },
      { day: 30, value: 0.46 },
      { day: 60, value: 0.65 },
      { day: 90, value: 0.9 },
      { day: 120, value: 1.05 },
      { day: 180, value: 1.2 },
      { day: 360, value: 1.6 },
    ];

    const result = logarithmicModel.fit(observations, { forecastEndDay: 360 });

    expect(result.status, result.reason).toBe("ok");
    expect(result.predictions[0]).toEqual({ day: 1, value: 0.1 });
    expect(result.predictions.every((point, index) => (
      point.value >= 0 && (index === 0 || point.value >= result.predictions[index - 1]!.value)
    ))).toBe(true);
  });

  it("recovers a deterministic power curve through day 360", () => {
    const result = powerModel.fit(observationsFor((day) => 0.15 * day ** 0.35), { forecastEndDay: 360 });

    expectValidDailyForecast(result, 1.1770560239951389);
  });

  it("recovers a deterministic bounded saturation curve through day 360", () => {
    const result = saturationModel.fit(
      observationsFor((day) => 2 * (1 - Math.exp(-0.012 * day)) + 0.08),
      { forecastEndDay: 360 },
    );

    expectValidDailyForecast(result, 2.0534002329151124);
  });

  it("starts predictions at the earliest observation when it is later than D1", () => {
    const observations = [7, 30, 120].map((day) => ({ day, value: 0.2 + 0.4 * Math.log(day) }));
    const result = logarithmicModel.fit(observations, { forecastEndDay: 360 });

    expect(result.status, result.reason).toBe("ok");
    expect(result.predictions).toHaveLength(354);
    expect(result.predictions[0]?.day).toBe(7);
    expect(result.predictions[result.predictions.length - 1]?.day).toBe(360);
  });

  it.each([361, 360.5])(
    "rejects an unsafe or out-of-range forecast end day: %p",
    (forecastEndDay) => {
      const result = logarithmicModel.fit(observationsFor((day) => 0.2 + 0.4 * Math.log(day)), {
        forecastEndDay,
      });

      expect(result.status).toBe("invalid");
      expect(result.predictions).toEqual([]);
      expect(result.reason).toMatch(/[\u4e00-\u9fff]/u);
    },
  );

  it("rejects an unsafe forecast end day before prediction allocation", () => {
    const result = prepareModelInput(observationsFor((day) => 0.2 + 0.4 * Math.log(day)), {
      forecastEndDay: Number.MAX_SAFE_INTEGER + 1,
    });

    expect(result.status).toBe("invalid");
  });

  it.each([
    ["logarithmic", logarithmicModel, [{ day: 1, value: Number.NaN }, { day: 7, value: 0.3 }]],
    ["power", powerModel, [{ day: 1, value: 0 }, { day: 7, value: 0.3 }]],
    ["saturation", saturationModel, [{ day: 1, value: 0.4 }, { day: 7, value: 0.3 }]],
  ] as const)("returns a Chinese invalid reason for %s model input it cannot fit", (_name, model, observations) => {
    expect(() => model.fit([...observations], { forecastEndDay: 360 })).not.toThrow();

    const result = model.fit([...observations], { forecastEndDay: 360 });
    expect(result.status).toBe("invalid");
    expect(result.predictions).toEqual([]);
    expect(result.reason).toMatch(/[\u4e00-\u9fff]/u);
  });

  it("fits constant cumulative observations at the valid ceiling boundary", () => {
    const result = saturationModel.fit(observationsFor(() => 0.5), { forecastEndDay: 360 });

    expectValidDailyForecast(result, 0.5);
  });

  it("requires at least three suitable observations for saturation fitting", () => {
    const result = saturationModel.fit(
      [
        { day: 1, value: 0.1 },
        { day: 30, value: 0.6 },
      ],
      { forecastEndDay: 360 },
    );

    expect(result.status).toBe("insufficient_data");
    expect(result.predictions).toEqual([]);
    expect(result.reason).toMatch(/[\u4e00-\u9fff]/u);
  });
});
