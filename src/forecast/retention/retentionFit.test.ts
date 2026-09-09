import { describe, expect, it } from "vitest";
import type { RoiRetentionCohort } from "../../domain/types";
import { fitRetentionModelGroup } from "./retentionFit";

function cohorts(count: number, days = [1, 7, 30, 360]): RoiRetentionCohort[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`, name: `C${index}`, mode: "roi_retention",
    observations: days.map((day, dayIndex) => ({
      day,
      value: day === 360 ? 1.4 + index * 0.01 : 0.08 + dayIndex * 0.18 + index * 0.002,
      retention: Math.max(0.02, 0.34 - dayIndex * 0.07 + index * 0.001),
    })),
  }));
}

describe("retention model group", () => {
  it("returns only five safe retention models and exact anchors", () => {
    const result = fitRetentionModelGroup(cohorts(2));
    expect(result.models.map((model) => model.id)).toEqual([
      "retention_multiplier", "retention_logarithmic", "retention_power", "retention_saturation", "retention_monotone_spline",
    ]);
    expect(result.models.find((model) => model.id === "retention_monotone_spline")?.label).toBe("单调样条模型");
    for (const model of result.models) {
      expect(model.predictions).toHaveLength(360);
      expect(model.predictions[0]?.value).toBeCloseTo(0.081, 8);
      expect(model.predictions.every((point, i, all) => Number.isFinite(point.value) && point.value >= 0 && (i === 0 || point.value >= all[i - 1]!.value))).toBe(true);
    }
    expect(result.level).toBe("experimental");
    expect(result.includeSplineInEnsemble).toBe(false);
  });

  it("applies documented sample gates", () => {
    expect(fitRetentionModelGroup(cohorts(3, [1, 7, 360])).level).toBe("low_confidence");
    expect(fitRetentionModelGroup(cohorts(5)).level).toBe("candidate");
    const large = fitRetentionModelGroup(cohorts(30));
    expect(large.stats).toMatchObject({ matureCohorts: 30, validSamples: 120, retentionDays: 4 });
    expect(large.splineEligible).toBeTypeOf("boolean");
    expect(large.includeSplineInEnsemble).toBe(large.splineEligible);
  });

  it("conditions every model on the cohort retention profile and backtests D360 without using its anchor", () => {
    const mature = Array.from({ length: 12 }, (_, index): RoiRetentionCohort => {
      const retention = 0.14 + index * 0.018;
      return {
        id: `m${index}`, name: `M${index}`, mode: "roi_retention",
        observations: [
          { day: 1, value: 0.09, retention },
          { day: 7, value: 0.27, retention: retention * 0.62 },
          { day: 30, value: 0.5, retention: retention * 0.34 },
          { day: 360, value: 0.85 + retention * 3.4, retention: retention * 0.08 },
        ],
      };
    });
    const current = (id: string, retention: number): RoiRetentionCohort => ({
      id, name: id, mode: "roi_retention",
      observations: [
        { day: 1, value: 0.1, retention },
        { day: 7, value: 0.29, retention: retention * 0.62 },
      ],
    });
    const result = fitRetentionModelGroup([...mature, current("low", 0.16), current("high", 0.31)]);
    for (const model of result.models) {
      const low = model.cohortFits.find((fit) => fit.cohortId === "low")!;
      const high = model.cohortFits.find((fit) => fit.cohortId === "high")!;
      expect(high.predictions[359]!.value, model.id).toBeGreaterThan(low.predictions[359]!.value);
      expect(model.parameters).not.toHaveProperty("shape");
      expect(model.cohortBacktests.every((backtest) => backtest.residuals.every((residual) => residual.day === 360))).toBe(true);
    }
  });
});
