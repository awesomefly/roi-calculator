import { describe, expect, it } from "vitest";
import type { Cohort, ModelResult } from "../domain/types";
import { aggregateDailyPredictions, fitMultiCohortPackageSource } from "./multiCohortFit";

function model(status: ModelResult["status"], scale = 1): ModelResult {
  return {
    id: "logarithmic",
    label: "对数模型",
    status,
    predictions: status === "ok"
      ? Array.from({ length: 360 }, (_, index) => ({ day: index + 1, value: (index + 1) * scale }))
      : [],
  };
}

const cohortA: Cohort = {
  id: "a", name: "A", mode: "roi",
  observations: [{ day: 1, value: 0.1 }, { day: 7, value: 0.25 }, { day: 30, value: 0.5 }, { day: 60, value: 0.7 }, { day: 360, value: 1.5 }],
};
const cohortB: Cohort = {
  id: "b", name: "B", mode: "ltv_cac",
  observations: [{ day: 1, value: 3, cac: 20 }, { day: 7, value: 6, cac: 20 }, { day: 30, value: 11, cac: 20 }, { day: 60, value: 15, cac: 20 }, { day: 360, value: 34, cac: 20 }],
};

describe("multi-cohort fitting", () => {
  it("routes ROI + retention cohorts exclusively to five retention models", () => {
    const result = fitMultiCohortPackageSource([{
      id: "r", name: "R", mode: "roi_retention",
      observations: [{ day: 1, value: 0.1, retention: 0.28 }, { day: 7, value: 0.3, retention: 0.16 }, { day: 360, value: 1.5, retention: 0.03 }],
    }]);
    expect(result.models.map((item) => item.id)).toEqual([
      "retention_multiplier", "retention_logarithmic", "retention_power", "retention_saturation", "retention_monotone_spline",
    ]);
    expect(result.retentionFit?.level).toBe("experimental");
  });
  it("pointwise averages only successful cohort curves", () => {
    const aggregate = aggregateDailyPredictions([model("ok", 1), model("invalid"), model("ok", 2)]);

    expect(aggregate).toHaveLength(360);
    expect(aggregate[29]).toEqual({ day: 30, value: 45 });
  });

  it("fits every cohort independently and creates one aggregate curve per successful model", () => {
    const result = fitMultiCohortPackageSource([cohortA, cohortB]);

    expect(result.sources).toHaveLength(2);
    expect(result.models).toHaveLength(4);
    expect(result.models.every((item) => item.cohortFits.length === 2)).toBe(true);
    expect(result.models.filter((item) => item.status === "ok").every((item) => item.predictions.length === 360)).toBe(true);
    expect(result.evaluationMode).toBe("multi_cohort_temporal_backtest");
  });

  it("does not attach backtest errors to a single historical cohort", () => {
    const result = fitMultiCohortPackageSource([cohortA]);

    expect(result.evaluationMode).toBe("single_cohort_no_backtest");
    expect(result.models.every((item) => item.backtestError === undefined)).toBe(true);
  });
});
