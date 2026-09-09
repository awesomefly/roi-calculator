import { describe, expect, it } from "vitest";
import type { Cohort, ModelResult, RoiObservation } from "../../domain/types";
import { fitAggregateHistoricalMultiplier, fitHistoricalMultiplier } from "./historicalMultiplier";

function roiCohort(
  id: string,
  observations: RoiObservation[],
  options: { spend?: number; name?: string } = {},
): Cohort {
  return {
    id,
    name: options.name ?? id,
    mode: "roi",
    spend: options.spend,
    observations,
  };
}

function mature(
  id: string,
  day60: number,
  roi360: number,
  spend?: number,
): Cohort {
  return roiCohort(
    id,
    [
      { day: 1, value: day60 / 5 },
      { day: 60, value: day60 },
      { day: 360, value: roi360 },
    ],
    { spend },
  );
}

function predictionAt(result: ModelResult, day: number): number {
  const prediction = result.predictions.find((point) => point.day === day);
  expect(prediction, `missing D${day} prediction`).toBeDefined();
  return prediction?.value ?? Number.NaN;
}

describe("fitHistoricalMultiplier", () => {
  const target = roiCohort("target", [
    { day: 1, value: 0.1 },
    { day: 30, value: 0.35 },
    { day: 60, value: 0.5 },
  ]);

  it("can forecast from one eligible mature cohort", () => {
    const result = fitHistoricalMultiplier(target, [
      mature("a", 0.5, 1.5, 10),
      roiCohort("not-mature", [{ day: 60, value: 0.7 }]),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 360)).toBeCloseTo(1.5, 12);
  });

  it("normalizes LTV/CAC and forecasts with exactly three eligible mature cohorts", () => {
    const ltvCohort: Cohort = {
      id: "ltv",
      name: "ltv",
      mode: "ltv_cac",
      spend: 10,
      observations: [
        { day: 1, value: 2, cac: 20 },
        { day: 60, value: 10, cac: 20 },
        { day: 360, value: 30, cac: 20 },
      ],
    };
    const result = fitHistoricalMultiplier(target, [
      mature("a", 0.4, 1.2, 10),
      mature("b", 0.6, 1.8, 10),
      ltvCohort,
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 60)).toBeCloseTo(0.5, 12);
    expect(predictionAt(result, 360)).toBeCloseTo(1.5, 12);
  });

  it("excludes the target ID before counting eligible cohorts", () => {
    const leakedTarget = mature("target", 0.001, 100, 1_000_000);
    const result = fitHistoricalMultiplier(target, [
      leakedTarget,
      mature("a", 0.5, 1.5, 10),
      mature("b", 0.6, 1.8, 10),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 360)).toBeCloseTo(1.5, 12);
  });

  it("uses the equal-weight median and ignores spend differences", () => {
    const result = fitHistoricalMultiplier(target, [
      mature("ratio-2", 0.5, 1, 1),
      mature("ratio-4", 0.5, 2, 1),
      mature("ratio-20", 0.5, 10, 100),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 360)).toBeCloseTo(2, 12);
  });

  it("prevents an equally weighted extreme ratio from dominating the forecast", () => {
    const result = fitHistoricalMultiplier(target, [
      mature("ordinary-a", 0.5, 1.5),
      mature("ordinary-b", 0.5, 1.5),
      mature("extreme", 0.000001, 1.5),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 360)).toBeCloseTo(1.5, 12);
  });

  it("ignores missing and zero denominators and falls back to deterministic equal weights", () => {
    const result = fitHistoricalMultiplier(target, [
      mature("usable", 0.5, 1.5),
      roiCohort("missing-d60", [
        { day: 30, value: 0.2 },
        { day: 360, value: 1.8 },
      ]),
      roiCohort("zero-d60", [
        { day: 60, value: 0 },
        { day: 360, value: 1.2 },
      ]),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 60)).toBeCloseTo(0.5, 12);
    expect(predictionAt(result, 360)).toBeCloseTo(1.5, 12);
  });

  it("returns finite non-negative non-decreasing daily output through D360", () => {
    const result = fitHistoricalMultiplier(target, [
      mature("a", 0.4, 1.2, 10),
      mature("b", 0.5, 1.5, 20),
      mature("c", 0.6, 1.8, 30),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(result.predictions).toHaveLength(360);
    expect(result.predictions[0]?.day).toBe(1);
    expect(result.predictions[359]?.day).toBe(360);
    expect(predictionAt(result, 60)).toBeCloseTo(0.5, 12);

    for (let index = 0; index < result.predictions.length; index += 1) {
      const point = result.predictions[index];
      expect(Number.isFinite(point?.value)).toBe(true);
      expect(point?.value).toBeGreaterThanOrEqual(0);
      if (index > 0) {
        expect(point?.value).toBeGreaterThanOrEqual(result.predictions[index - 1]?.value ?? 0);
      }
      if ((point?.day ?? 0) >= 60) {
        expect(point?.value).toBeGreaterThanOrEqual(0.5);
      }
    }
  });

  it("never backfills predictions before the target's earliest observed day", () => {
    const lateTarget = roiCohort("late-target", [
      { day: 7, value: 1.5 },
      { day: 30, value: 1.7 },
    ]);
    const result = fitHistoricalMultiplier(lateTarget, [
      mature("a", 0.4, 1.2, 10),
      mature("b", 0.5, 1.5, 20),
      mature("c", 0.6, 1.8, 30),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(result.predictions[0]).toMatchObject({ day: 7, value: 1.5 });
    expect(result.predictions.some(({ day }) => day < 7)).toBe(false);
  });

  it("returns an explicit Chinese invalid result for an unusable cumulative target curve", () => {
    const invalidTarget = roiCohort("invalid", [
      { day: 1, value: 0.5 },
      { day: 60, value: 0.4 },
    ]);
    const training = [
      mature("a", 0.4, 1.2),
      mature("b", 0.5, 1.5),
      mature("c", 0.6, 1.8),
    ];

    expect(() => fitHistoricalMultiplier(invalidTarget, training)).not.toThrow();
    const result = fitHistoricalMultiplier(invalidTarget, training);
    expect(result.status).toBe("invalid");
    expect(result.predictions).toEqual([]);
    expect(result.reason).toMatch(/[\u4e00-\u9fff]/u);
  });

  it("builds the aggregate curve from same-day median multipliers", () => {
    const result = fitAggregateHistoricalMultiplier([
      mature("ratio-2", 0.5, 1),
      mature("ratio-4", 0.5, 2),
      mature("ratio-20", 0.5, 10),
    ]);

    expect(result.status, result.reason).toBe("ok");
    expect(predictionAt(result, 60)).toBeCloseTo((1 + 2 + 10) / 3 / 4, 12);
    expect(predictionAt(result, 360)).toBeCloseTo((1 + 2 + 10) / 3, 12);
  });
});
