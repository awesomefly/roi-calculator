import { describe, expect, it } from "vitest";
import type { Cohort, ModelResult, RoiObservation } from "../domain/types";
import {
  evaluateModels,
  type EvaluationFitContext,
  type EvaluationModel,
} from "./evaluate";

type ModelId = ModelResult["id"];

function dailyResult(
  id: ModelId,
  label: string,
  observations: RoiObservation[],
  predict: (day: number, observations: RoiObservation[]) => number,
): ModelResult {
  const firstDay = observations[0]?.day ?? 1;
  return {
    id,
    label,
    status: "ok",
    predictions: Array.from({ length: 361 - firstDay }, (_, index) => {
      const day = firstDay + index;
      return { day, value: predict(day, observations) };
    }),
  };
}

function fakeModel(
  id: ModelId,
  predict: (day: number, observations: RoiObservation[]) => number,
  onFit?: (observations: RoiObservation[], context: EvaluationFitContext) => void,
): EvaluationModel {
  return {
    id,
    label: id,
    fit(observations, context) {
      onFit?.(observations, context);
      return dailyResult(id, id, observations, predict);
    },
  };
}

function cohort(id: string, d60: number, d360: number): Cohort {
  return {
    id,
    name: id,
    mode: "roi",
    observations: [
      { day: 1, value: d60 / 6 },
      { day: 60, value: d60 },
      { day: 360, value: d360 },
    ],
  };
}

const linearObservations: RoiObservation[] = [
  { day: 1, value: 0.01 },
  { day: 7, value: 0.07 },
  { day: 30, value: 0.3 },
  { day: 60, value: 0.6 },
];

describe("evaluateModels temporal backtesting", () => {
  it("applies each model's own minimum training size", () => {
    const observations: RoiObservation[] = [
      { day: 1, value: 0.1 },
      { day: 7, value: 0.2 },
      { day: 30, value: 0.3 },
    ];
    const logarithmic = fakeModel("logarithmic", (day) => day / 100);
    const power = fakeModel("power", (day) => day / 100);
    const saturation: EvaluationModel = {
      ...fakeModel("saturation", (day) => day / 100),
      minimumTrainingObservations: 3,
    };

    const output = evaluateModels({ observations, models: [logarithmic, power, saturation] });

    expect(output.rankedModels.map(({ id }) => id).sort()).toEqual(["logarithmic", "power"]);
    expect(output.models.find(({ id }) => id === "saturation")).toMatchObject({ eligible: false, residuals: [] });
  });

  it("fits every held-out point using earlier observations only", () => {
    const fitDays: number[][] = [];
    const contextDays: number[][] = [];
    const model = fakeModel(
      "logarithmic",
      (day) => day / 100,
      (observations, context) => {
        fitDays.push(observations.map(({ day }) => day));
        contextDays.push(context.targetCohort.observations.map(({ day }) => day));
      },
    );

    const output = evaluateModels({ observations: linearObservations, models: [model] });

    expect(fitDays).toEqual([
      [1, 7],
      [1, 7, 30],
      [1, 7, 30, 60],
    ]);
    expect(contextDays).toEqual(fitDays);
    expect(output.models[0]?.residuals.map(({ day }) => day)).toEqual([30, 60]);
    expect(output.models[0]?.backtestError).toBeCloseTo(0, 12);
  });

  it("uses at least two training points and a finite epsilon MAPE for zero actuals", () => {
    const trainingSizes: number[] = [];
    const observations = [
      { day: 1, value: 0 },
      { day: 7, value: 0 },
      { day: 30, value: 0 },
      { day: 60, value: 0.1 },
    ];
    const model = fakeModel(
      "power",
      () => 0.001,
      (training) => trainingSizes.push(training.length),
    );

    const output = evaluateModels({ observations, models: [model] });
    const evaluated = output.models[0];

    expect(trainingSizes).toEqual([2, 3, 4]);
    expect(evaluated?.residuals[0]).toMatchObject({
      day: 30,
      actual: 0,
      predicted: 0.001,
      signed: -0.001,
      absolute: 0.001,
    });
    expect(Number.isFinite(evaluated?.residuals[0]?.absolutePercentageError)).toBe(true);
    expect(Number.isFinite(evaluated?.backtestError)).toBe(true);
  });

  it("excludes a model that misses any required common holdout instead of scoring partial coverage", () => {
    const partial: EvaluationModel = {
      id: "power",
      label: "partial",
      fit(observations) {
        if (observations.length === 2) {
          return {
            id: "power",
            label: "partial",
            status: "ok",
            predictions: Array.from({ length: 330 }, (_, index) => ({
              day: index + 31,
              value: (index + 31) / 100,
            })),
          };
        }
        return dailyResult("power", "partial", observations, (day) => day / 100);
      },
    };
    const output = evaluateModels({
      observations: linearObservations,
      models: [partial, fakeModel("logarithmic", (day) => day / 100)],
    });

    expect(output.rankedModels.map(({ id }) => id)).toEqual(["logarithmic"]);
    expect(output.models.find(({ id }) => id === "power")).toMatchObject({ eligible: false });
    expect(output.models.find(({ id }) => id === "power")?.reason).toMatch(/回测|缺失/u);
  });
});

describe("evaluateModels ranking and constraints", () => {
  it("invalidates a model whose future cumulative forecast falls below the latest observation", () => {
    const observations: RoiObservation[] = [
      { day: 1, value: 0.1 },
      { day: 7, value: 0.4 },
      { day: 30, value: 0.8 },
    ];
    const belowLatest = fakeModel("logarithmic", (day) => Math.min(0.7, day / 10));

    const output = evaluateModels({ observations, models: [belowLatest] });

    expect(output.selectedModelId).toBeUndefined();
    expect(output.rankedModels).toEqual([]);
    expect(output.models[0]).toMatchObject({ status: "invalid", eligible: false, predictions: [] });
    expect(output.models[0]?.reason).toMatch(/最新观测|累计/u);
  });

  it("excludes invalid output from selection while retaining it for display", () => {
    const invalid: EvaluationModel = {
      id: "power",
      label: "invalid",
      fit() {
        return {
          id: "power",
          label: "invalid",
          status: "ok",
          predictions: [
            { day: 1, value: 0.2 },
            { day: 2, value: 0.1 },
          ],
        };
      },
    };
    const valid = fakeModel("logarithmic", (day) => day / 100);

    const output = evaluateModels({ observations: linearObservations, models: [invalid, valid] });

    expect(output.selectedModelId).toBe("logarithmic");
    expect(output.rankedModels.map(({ id }) => id)).toEqual(["logarithmic"]);
    expect(output.models.map(({ id }) => id)).toEqual(["logarithmic", "power"]);
    expect(output.models[1]).toMatchObject({ id: "power", status: "invalid", eligible: false });
    expect(output.models[1]?.reason).toMatch(/[\u4e00-\u9fff]/u);
  });

  it("breaks equal-error ties by stability penalty and then model ID", () => {
    const stable = (day: number) => (day <= 60 ? day / 100 : 0.6 + (day - 60) / 1_000);
    const accelerating = (day: number) => (day <= 60 ? day / 100 : 0.6 + (day - 60) / 10);
    const output = evaluateModels({
      observations: linearObservations,
      models: [
        fakeModel("power", accelerating),
        fakeModel("saturation", stable),
        fakeModel("logarithmic", stable),
      ],
    });

    expect(output.models.slice(0, 3).map(({ id }) => id)).toEqual([
      "logarithmic",
      "saturation",
      "power",
    ]);
    expect(output.models[2]?.stabilityPenalty).toBeGreaterThan(output.models[0]?.stabilityPenalty ?? 0);
    expect(output.selectedModelId).toBe("logarithmic");
  });

  it("selects the lowest total score even when it has a higher temporal error", () => {
    const exactButAccelerating = (day: number) =>
      day <= 60 ? day / 100 : 0.6 + (day - 60) / 10;
    const slightlyBiasedButStable = (day: number) =>
      day <= 60 ? day * 0.011 : 0.66 + (day - 60) / 1_000;
    const output = evaluateModels({
      observations: linearObservations,
      models: [
        fakeModel("power", exactButAccelerating),
        fakeModel("logarithmic", slightlyBiasedButStable),
      ],
    });

    const power = output.models.find(({ id }) => id === "power");
    const logarithmic = output.models.find(({ id }) => id === "logarithmic");
    expect(power?.backtestError).toBeLessThan(logarithmic?.backtestError ?? Number.POSITIVE_INFINITY);
    expect(power?.score).toBeGreaterThan(logarithmic?.score ?? Number.NEGATIVE_INFINITY);
    expect(output.rankedModels.map(({ id }) => id)).toEqual(["logarithmic", "power"]);
    expect(output.selectedModelId).toBe("logarithmic");
  });

  it("measures acceleration for forecasts whose first prediction is after D1", () => {
    const observations = [7, 30, 60, 90].map((day) => ({ day, value: day / 100 }));
    const stable = (day: number) => day / 100;
    const accelerating = (day: number) => (day <= 90 ? day / 100 : 0.9 + (day - 90) / 10);
    const output = evaluateModels({
      observations,
      models: [fakeModel("logarithmic", stable), fakeModel("power", accelerating)],
    });

    const stablePenalty = output.models.find(({ id }) => id === "logarithmic")?.stabilityPenalty ?? Number.NaN;
    const accelerationPenalty = output.models.find(({ id }) => id === "power")?.stabilityPenalty ?? Number.NaN;
    expect(accelerationPenalty).toBeGreaterThan(stablePenalty);
  });

  it("keeps an insufficient historical model visible but never selects it", () => {
    const historical: EvaluationModel = {
      id: "historical_multiplier",
      label: "历史倍率",
      fit() {
        return {
          id: "historical_multiplier",
          label: "历史倍率",
          status: "insufficient_data",
          predictions: [],
          reason: "成熟批次不足。",
        };
      },
    };
    const output = evaluateModels({
      observations: linearObservations,
      models: [historical, fakeModel("power", (day) => day / 100)],
    });

    expect(output.models.find(({ id }) => id === "historical_multiplier")).toMatchObject({
      status: "insufficient_data",
      eligible: false,
    });
    expect(output.rankedModels.map(({ id }) => id)).toEqual(["power"]);
    expect(output.selectedModelId).toBe("power");
  });
});

describe("evaluateModels evidence and confidence", () => {
  it("counts valid D360 cohorts even when dispersion cannot use an exact D60 point", () => {
    const matureWithoutD60 = ["a", "b", "c"].map((id, index): Cohort => ({
      id,
      name: id,
      mode: "roi",
      observations: [
        { day: 30, value: 0.3 + index / 100 },
        { day: 360, value: 1.2 + index / 100 },
      ],
    }));

    const output = evaluateModels({
      observations: linearObservations,
      matureCohorts: matureWithoutD60,
      models: [fakeModel("logarithmic", (day) => day / 100)],
    });

    expect(output.matureCohortCount).toBe(3);
  });

  it("penalizes historical-multiplier dispersion and rewards a larger mature sample", () => {
    const historical = fakeModel("historical_multiplier", (day) => day / 100);
    const stableThree = [cohort("a", 0.5, 1), cohort("b", 0.6, 1.2), cohort("c", 0.7, 1.4)];
    const stableSix = [
      ...stableThree,
      cohort("d", 0.8, 1.6),
      cohort("e", 0.9, 1.8),
      cohort("f", 1, 2),
    ];
    const dispersed = [cohort("low", 0.5, 0.5), cohort("middle", 0.5, 1.5), cohort("high", 0.5, 4.5)];

    const small = evaluateModels({ observations: linearObservations, matureCohorts: stableThree, models: [historical] });
    const large = evaluateModels({ observations: linearObservations, matureCohorts: stableSix, models: [historical] });
    const noisy = evaluateModels({ observations: linearObservations, matureCohorts: dispersed, models: [historical] });

    expect(large.models[0]?.stabilityPenalty).toBeLessThan(small.models[0]?.stabilityPenalty ?? 0);
    expect(noisy.models[0]?.historicalDispersion).toBeGreaterThan(small.models[0]?.historicalDispersion ?? 0);
    expect(noisy.models[0]?.stabilityPenalty).toBeGreaterThan(small.models[0]?.stabilityPenalty ?? 0);
    expect(noisy.warnings.join("")).toMatch(/离散/u);
  });

  it("uses usable D60-D360 ratios, not total mature count, for historical sample penalty", () => {
    const withoutD60 = ["a", "b", "c", "d", "e"].map((id, index): Cohort => ({
      id,
      name: id,
      mode: "roi",
      observations: [
        { day: 30, value: 0.2 + index / 100 },
        { day: 360, value: 1 + index / 100 },
      ],
    }));
    const oneUsable = [...withoutD60, cohort("only-d60", 0.5, 1)];
    const threeUsable = [cohort("x", 0.5, 1), cohort("y", 0.6, 1.2), cohort("z", 0.7, 1.4)];
    const historical = fakeModel("historical_multiplier", (day) => day / 100);

    const sparse = evaluateModels({ observations: linearObservations, matureCohorts: oneUsable, models: [historical] });
    const supported = evaluateModels({ observations: linearObservations, matureCohorts: threeUsable, models: [historical] });

    expect(sparse.models[0]?.stabilityPenalty).toBeGreaterThan(supported.models[0]?.stabilityPenalty ?? 0);
    expect(sparse.warnings.join("")).toMatch(/D60.*D360.*不足/u);
  });

  it("lowers confidence and explains sparse, early, inaccurate, disagreeing evidence in Chinese", () => {
    const observations = [
      { day: 1, value: 0.1 },
      { day: 7, value: 0.2 },
      { day: 14, value: 0.3 },
    ];
    const low = evaluateModels({
      observations,
      matureCohorts: [cohort("a", 0.5, 0.5), cohort("b", 0.5, 1.5), cohort("c", 0.5, 4.5)],
      models: [
        fakeModel("logarithmic", (day) => Math.max(0.3, 0.1 + day / 100)),
        fakeModel("power", (day) => Math.max(0.3, 0.1 + day / 10)),
      ],
    });

    expect(low.confidence).toBe("low");
    expect(low.modelDisagreement).toBeGreaterThan(0);
    expect(low.warnings.length).toBeGreaterThan(0);
    expect(low.warnings.join("")).toMatch(/[一-鿿]/u);
    expect(low.confidenceReasons.join("")).toMatch(/[一-鿿]/u);
  });

  it("can report high confidence when every evidence dimension is strong", () => {
    const observations = [1, 7, 30, 60, 90, 120].map((day) => ({ day, value: day / 100 }));
    const mature = Array.from({ length: 8 }, (_, index) =>
      cohort(`m${index}`, 0.5 + index / 100, 1 + index / 50),
    );
    const output = evaluateModels({
      observations,
      matureCohorts: mature,
      models: [
        fakeModel("logarithmic", (day) => day / 100),
        fakeModel("power", (day) => day / 100 + 0.001),
      ],
    });

    expect(output.confidence).toBe("high");
    expect(output.residuals).toEqual(output.models[0]?.residuals);
    expect(output.confidenceReasons).toEqual(expect.arrayContaining([expect.stringMatching(/充足|较低|一致/u)]));
  });

  it("treats disagreement as unmeasurable with fewer than two eligible models", () => {
    const observations = [1, 7, 30, 60, 90, 120].map((day) => ({ day, value: day / 100 }));
    const mature = Array.from({ length: 8 }, (_, index) =>
      cohort(`single-${index}`, 0.5 + index / 100, 1 + index / 50),
    );
    const output = evaluateModels({
      observations,
      matureCohorts: mature,
      models: [fakeModel("logarithmic", (day) => day / 100)],
    });

    expect(output.modelDisagreement).toBeUndefined();
    expect(output.warnings.join("")).toMatch(/少于两个|无法评估/u);
    expect(output.confidence).toBe("medium");
    expect(output.confidenceReasons.join("")).not.toMatch(/模型.*一致/u);
  });
});
