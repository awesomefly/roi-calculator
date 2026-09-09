import { describe, expect, it } from "vitest";
import type { ForecastPoint } from "../domain/types";
import { fitMultiCohortPackageSource } from "../forecast/multiCohortFit";
import {
  deleteSavedCurve,
  loadModelPackages,
  loadModelPackageRecords,
  loadSavedCurves,
  saveCurve,
  saveModelPackage,
  saveModelPackageV4,
  type ModelPackageV3,
  type ModelPackageV4,
  type SavedCurve,
} from "./savedCurves";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function curve(id = "curve-1", name = "基准曲线"): SavedCurve {
  const predictions: ForecastPoint[] = [{ day: 1, value: 0.1 }, { day: 360, value: 1.5 }];
  return {
    id, name, createdAt: "2026-08-25T00:00:00.000Z", modelId: "power", modelLabel: "幂函数模型",
    confidence: "high", confidenceReasons: [], sourceName: "A", trainingPoints: 5, predictions,
  };
}

function modelPackage(id = "package-1", name = "渠道基准"): ModelPackageV3 {
  return {
    version: 3,
    id,
    name,
    createdAt: "2026-08-25T00:00:00.000Z",
    sourceSnapshot: { id: "history", name: "历史批次", mode: "roi", observations: [{ day: 30, value: 0.5 }] },
    roiObservations: [{ day: 30, value: 0.5 }],
    models: [{
      id: "logarithmic",
      label: "对数模型",
      status: "ok",
      parameters: { intercept: 0.1, slope: 0.2 },
      fitError: 0.03,
      predictions: Array.from({ length: 360 }, (_, index) => ({ day: index + 1, value: 0.1 + index / 500 })),
    },
    { id: "historical_multiplier", label: "历史倍率", status: "insufficient_data", predictions: [], reason: "缺少 D360" },
    { id: "power", label: "幂函数模型", status: "invalid", predictions: [], reason: "测试失败" },
    { id: "saturation", label: "饱和模型", status: "invalid", predictions: [], reason: "测试失败" }],
    validModelIds: ["logarithmic"],
    evaluationMode: "single_cohort_no_backtest",
    ensembleRule: "equal_valid_models",
  };
}

describe("saved curves storage", () => {
  it("saves, loads, overwrites by id, and deletes curves", () => {
    const target = storage();
    saveCurve(curve(), target);
    saveCurve(curve("curve-1", "更新曲线"), target);
    saveCurve(curve("curve-2", "第二曲线"), target);

    expect(loadSavedCurves(target).map((item) => item.name)).toEqual(["更新曲线", "第二曲线"]);
    deleteSavedCurve("curve-1", target);
    expect(loadSavedCurves(target).map((item) => item.id)).toEqual(["curve-2"]);
  });

  it("returns an empty list for malformed storage without overwriting it", () => {
    const target = storage();
    target.setItem("roi-forecast-tool.saved-curves", "not-json");
    expect(loadSavedCurves(target)).toEqual([]);
    expect(target.getItem("roi-forecast-tool.saved-curves")).toBe("not-json");
  });

  it("keeps same-name model packages as separate versions", () => {
    const target = storage();
    saveModelPackage(modelPackage("package-1"), target);
    saveModelPackage(modelPackage("package-2"), target);

    expect(loadModelPackages(target).map((item) => item.id)).toEqual(["package-1", "package-2"]);
  });

  it("does not migrate a legacy selected curve to a model package", () => {
    const target = storage();
    saveCurve(curve(), target);

    expect(loadModelPackages(target)).toEqual([]);
  });

  it("rejects a V2 model package from storage", () => {
    const target = storage();
    target.setItem("roi-forecast-tool.model-packages", JSON.stringify([{ ...modelPackage(), version: 2 }]));
    expect(loadModelPackages(target)).toEqual([]);
  });

  it("stores complete V4 packages and reports V3 packages as incompatible", () => {
    const target = storage();
    const cohorts = [
      { id: "a", name: "A", mode: "roi" as const, observations: [{ day: 1, value: 0.1 }, { day: 360, value: 1.5 }] },
      { id: "b", name: "B", mode: "roi" as const, observations: [{ day: 1, value: 0.2 }, { day: 360, value: 1.7 }] },
    ];
    const fit = fitMultiCohortPackageSource(cohorts);
    const current: ModelPackageV4 = {
      version: 4, id: "v4", name: "新版", createdAt: "2026-08-26T00:00:00.000Z",
      sourceSnapshots: fit.sources, roiObservationsByCohort: fit.observationsByCohort, models: fit.models,
      validModelIds: fit.models.filter((item) => item.status === "ok").map((item) => item.id), evaluationMode: fit.evaluationMode,
      ensembleRule: "equal_valid_models", cohortWeightRule: "equal_valid_cohorts",
    };
    target.setItem("roi-forecast-tool.model-packages", JSON.stringify([modelPackage()]));

    expect(saveModelPackageV4(current, target)).toBe(true);
    expect(loadModelPackageRecords(target).compatible.map((item) => item.name)).toEqual(["新版"]);
    expect(loadModelPackageRecords(target).incompatible).toEqual([{ id: "package-1", name: "渠道基准", createdAt: "2026-08-25T00:00:00.000Z", reason: "格式不兼容" }]);
  });
});
