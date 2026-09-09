import { describe, expect, it } from "vitest";
import type { ForecastPoint, ModelResult } from "../domain/types";
import type { ModelPackageV4 } from "../io/savedCurves";
import type { AggregateModelResult } from "./multiCohortFit";
import { estimateWithModelPackage } from "./savedCurve";

function linear(end: number): ForecastPoint[] {
  return Array.from({ length: 360 }, (_, index) => ({ day: index + 1, value: end * (index + 1) / 360 }));
}

function bent(end: number): ForecastPoint[] {
  return Array.from({ length: 360 }, (_, index) => {
    const day = index + 1;
    return { day, value: day <= 30 ? day / 300 : 0.1 + (day - 30) * (end - 0.1) / 330 };
  });
}

function model(id: ModelResult["id"], label: string, predictions: ForecastPoint[]): ModelResult {
  return { id, label, status: "ok", predictions };
}

function aggregate(result: ModelResult): AggregateModelResult {
  return { ...result, cohortFits: [], cohortBacktests: [], validCohortCount: result.status === "ok" ? 1 : 0, backtestCohortCount: 0 };
}

const modelPackage: ModelPackageV4 = {
  version: 4,
  id: "package-1",
  name: "业务模型包",
  createdAt: "2026-08-25T00:00:00.000Z",
  sourceSnapshots: [{ id: "history", name: "成熟历史", mode: "roi", observations: [{ day: 30, value: 0.1 }] }],
  roiObservationsByCohort: [{ cohortId: "history", observations: [{ day: 30, value: 0.1 }] }],
  models: [
    aggregate(model("logarithmic", "对数模型", linear(1.2))),
    aggregate(model("power", "幂函数模型", bent(1.8))),
    aggregate({ id: "historical_multiplier", label: "历史倍率", status: "insufficient_data", predictions: [], reason: "缺少真实 D360" }),
    aggregate({ id: "saturation", label: "饱和模型", status: "invalid", predictions: [], reason: "拟合未收敛" }),
  ],
  validModelIds: ["logarithmic", "power"],
  evaluationMode: "single_cohort_no_backtest",
  ensembleRule: "equal_valid_models",
  cohortWeightRule: "equal_valid_cohorts",
};

describe("model-package estimation", () => {
  it("uses every observation with linearly increasing recency weights", () => {
    const result = estimateWithModelPackage({
      modelPackage,
      observations: [{ day: 10, value: 0.04 }, { day: 20, value: 0.075 }, { day: 30, value: 0.1 }],
      targetRoi: 1.37,
      targetDay: 360,
    });

    expect(result.models[0]?.calibration?.observationWeights).toEqual([1, 2, 3]);
    expect(result.models[0]?.calibration?.scale).toEqual(expect.any(Number));
  });

  it("forms a pointwise equal average with a min-max model disagreement range", () => {
    const result = estimateWithModelPackage({
      modelPackage,
      observations: [{ day: 30, value: 0.1 }],
      targetRoi: 1.37,
      targetDay: 360,
    });

    expect(result.ensemble?.predictions[359]).toEqual({ day: 360, value: 1.5, lower: 1.2, upper: 1.8 });
    expect(result.ensemble?.roiAtTargetDay).toBe(1.5);
    expect(result.ensemble?.targetGap).toBeCloseTo(0.13, 8);
    expect(result.validModelCount).toBe(2);
  });

  it("uses an observed target crossing before the predicted crossing", () => {
    const result = estimateWithModelPackage({
      modelPackage,
      observations: [{ day: 20, value: 0.08 }, { day: 40, value: 1.4 }],
      targetRoi: 1.37,
      targetDay: 180,
    });

    expect(result.ensemble?.targetDay).toBe(40);
    expect(result.ensemble?.reachesTarget).toBe(true);
  });

  it("excludes a packaged failed model without blocking the valid-model ensemble", () => {
    const result = estimateWithModelPackage({
      modelPackage,
      observations: [{ day: 30, value: 0.1 }],
      targetRoi: 1.37,
      targetDay: 360,
    });

    expect(result.models.find((item) => item.id === "historical_multiplier")?.status).toBe("excluded");
    expect(result.ensemble).toBeDefined();
  });

  it("warns about model disagreement, long extrapolation, and unavailable historical multiplier", () => {
    const result = estimateWithModelPackage({
      modelPackage,
      observations: [{ day: 30, value: 0.1 }],
      targetRoi: 1.37,
      targetDay: 360,
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/模型分歧较大/u),
      expect.stringMatching(/预测跨度过长/u),
      expect.stringMatching(/历史倍率模型不可用/u),
    ]));
  });

  it("keeps every real observation exact while preserving a cumulative curve", () => {
    const constantPackage: ModelPackageV4 = {
      ...modelPackage,
      id: "constant-package",
      models: [
        aggregate(model("logarithmic", "对数模型", Array.from({ length: 360 }, (_, index) => ({ day: index + 1, value: 1 })))),
        aggregate({ id: "historical_multiplier", label: "历史倍率", status: "insufficient_data", predictions: [], reason: "缺少真实 D360" }),
        aggregate({ id: "power", label: "幂函数模型", status: "invalid", predictions: [], reason: "测试失败" }),
        aggregate({ id: "saturation", label: "饱和模型", status: "invalid", predictions: [], reason: "测试失败" }),
      ],
      validModelIds: ["logarithmic"],
    };
    const result = estimateWithModelPackage({
      modelPackage: constantPackage,
      observations: [{ day: 10, value: 0.1 }, { day: 20, value: 0.2 }],
      targetRoi: 1.37,
      targetDay: 360,
    });
    const predictions = result.models[0]?.predictions ?? [];

    expect(predictions[9]?.value).toBe(0.1);
    expect(predictions[19]?.value).toBe(0.2);
    expect(predictions.every((point, index) => index === 0 || point.value >= (predictions[index - 1]?.value ?? 0))).toBe(true);
  });
});
