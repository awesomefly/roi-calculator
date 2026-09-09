import { describe, expect, it } from "vitest";
import type { RoiRetentionCohort } from "../../domain/types";
import { predictRetentionCurve, trainRetentionModel, type RetentionParametricModelId } from "./retentionModels";

const IDS: RetentionParametricModelId[] = ["retention_multiplier", "retention_logarithmic", "retention_power", "retention_saturation"];

function trainingCohorts(): RoiRetentionCohort[] {
  return Array.from({ length: 12 }, (_, index) => {
    const retention = 0.12 + index * 0.02;
    return {
      id: `train-${index}`, name: `Train ${index}`, mode: "roi_retention",
      observations: [
        { day: 1, value: 0.08 + index * 0.001, retention },
        { day: 7, value: 0.25 + index * 0.002, retention: retention * 0.65 },
        { day: 30, value: 0.48 + index * 0.004, retention: retention * 0.35 },
        { day: 360, value: 0.9 + retention * 3.2, retention: retention * 0.08 },
      ],
    };
  });
}

function query(id: string, retention: number): RoiRetentionCohort {
  return {
    id, name: id, mode: "roi_retention",
    observations: [
      { day: 1, value: 0.1, retention },
      { day: 7, value: 0.28, retention: retention * 0.65 },
    ],
  };
}

describe("retention-conditioned parametric models", () => {
  it.each(IDS)("%s creates a safe anchored curve that responds positively to retention", (id) => {
    const trained = trainRetentionModel(id, trainingCohorts());
    expect(trained).toBeDefined();
    const low = predictRetentionCurve(trained!, query("low", 0.15));
    const high = predictRetentionCurve(trained!, query("high", 0.31));
    expect(low).toHaveLength(360);
    expect(low[0]?.value).toBeCloseTo(0.1, 12);
    expect(low[6]?.value).toBeCloseTo(0.28, 12);
    expect(low.every((point, index) => Number.isFinite(point.value) && point.value >= 0 && (index === 0 || point.value >= low[index - 1]!.value))).toBe(true);
    expect(high[359]!.value).toBeGreaterThan(low[359]!.value);
  });

  it("fits distinct model families instead of fixed shape aliases", () => {
    const curves = IDS.map((id) => predictRetentionCurve(trainRetentionModel(id, trainingCohorts())!, query(id, 0.24)));
    const d120 = new Set(curves.map((curve) => curve[119]!.value.toFixed(6)));
    expect(d120.size).toBeGreaterThan(2);
  });
});
