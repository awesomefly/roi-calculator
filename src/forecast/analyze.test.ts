import { describe, expect, it } from "vitest";
import { DEMO_COHORTS } from "../domain/demoData";
import type { AnalysisResult, Cohort, ForecastPoint } from "../domain/types";
import { analyzeCohort, analyzeProject } from "./analyze";

function selectedPredictions(result: AnalysisResult): ForecastPoint[] {
  const selected = result.models.find((model) => model.id === result.selectedModelId);
  expect(selected).toMatchObject({ status: "ok" });
  return selected?.predictions ?? [];
}

function expectValidIntervalEnvelope(points: ForecastPoint[]): void {
  let previousLower = 0;
  let previousUpper = 0;
  for (const point of points) {
    expect(Number.isFinite(point.lower)).toBe(true);
    expect(Number.isFinite(point.upper)).toBe(true);
    expect(point.lower).toBeGreaterThanOrEqual(0);
    expect(point.lower).toBeLessThanOrEqual(point.value);
    expect(point.upper).toBeGreaterThanOrEqual(point.value);
    expect(point.lower).toBeGreaterThanOrEqual(previousLower);
    expect(point.upper).toBeGreaterThanOrEqual(previousUpper);
    previousLower = point.lower ?? 0;
    previousUpper = point.upper ?? 0;
  }
}

describe("analysis orchestration", () => {
  it("analyzes every demo cohort and its valid aggregate with automatic models, D360 target semantics, and intervals", () => {
    const target = 1.37;
    const project = analyzeProject(DEMO_COHORTS, target);

    expect(project.cohorts.map(({ subjectId }) => subjectId)).toEqual(
      DEMO_COHORTS.map(({ id }) => id),
    );
    expect(project.aggregate?.subjectId).toBe("aggregate");

    for (const result of [...project.cohorts, project.aggregate!]) {
      expect(result.models).toHaveLength(4);
      expect(result.selectedModelId).toBeDefined();
      expect(["high", "medium", "low"]).toContain(result.confidence);
      expect(result.warnings.every((warning) => warning.length > 0)).toBe(true);

      const predictions = selectedPredictions(result);
      const day360 = predictions.find((point) => point.day === 360);
      expect(day360).toBeDefined();
      expect(result.roi360).toBe(day360?.value);
      expect(result.reachesTarget).toBe((day360?.value ?? 0) >= target);
      expect(result.targetGap).toBeCloseTo((day360?.value ?? 0) - target, 12);
      expect(result.targetGapRatio).toBeCloseTo(
        ((day360?.value ?? 0) - target) / target,
        12,
      );
      if (result.reachesTarget) {
        expect(result.targetDay).toBeGreaterThan(0);
        expect(result.targetDay).toBeLessThanOrEqual(360);
      } else {
        expect(result.targetDay).toBeUndefined();
      }
      if (predictions.every((point) => point.lower !== undefined && point.upper !== undefined)) {
        expectValidIntervalEnvelope(predictions);
      } else {
        expect(result.warnings.join("")).toMatch(/区间.*不足|无法.*区间/u);
      }
    }
  });

  it("propagates positive reached and negative unreached target margins", () => {
    const reached = analyzeCohort(DEMO_COHORTS[0], DEMO_COHORTS, 1);
    const unreached = analyzeCohort(DEMO_COHORTS[0], DEMO_COHORTS, 2);

    expect(reached.reachesTarget).toBe(true);
    expect(reached.targetDay).toBe(110);
    expect(reached.targetGap).toBeCloseTo((reached.roi360 ?? 0) - 1, 12);
    expect(reached.targetGap).toBeGreaterThan(0);
    expect(reached.targetGapRatio).toBeCloseTo((reached.roi360 ?? 0) - 1, 12);

    expect(unreached.reachesTarget).toBe(false);
    expect(unreached.targetGap).toBeCloseTo((unreached.roi360 ?? 0) - 2, 12);
    expect(unreached.targetGap).toBeLessThan(0);
    expect(unreached.targetGapRatio).toBeCloseTo(((unreached.roi360 ?? 0) - 2) / 2, 12);
  });

  it("keeps invalid cohorts isolated from usable cohort results", () => {
    const invalid: Cohort = {
      id: "descending",
      name: "Descending",
      mode: "roi",
      spend: 1_000,
      observations: [
        { day: 1, value: 0.4 },
        { day: 7, value: 0.2 },
        { day: 30, value: 0.5 },
      ],
    };

    const project = analyzeProject([...DEMO_COHORTS, invalid], 1.37);
    const usable = project.cohorts.find(({ subjectId }) => subjectId === "mature-roi-q1");
    const failed = project.cohorts.find(({ subjectId }) => subjectId === "descending");

    expect(usable?.selectedModelId).toBeDefined();
    expect(usable?.models).toHaveLength(4);
    expect(usable?.models.find((model) => model.id === "historical_multiplier")?.status).toBe("ok");
    expect(failed).toMatchObject({ reachesTarget: false, confidence: "low" });
    expect(failed?.selectedModelId).toBeUndefined();
    expect(failed?.warnings.join("")).toMatch(/下降|无效/u);
  });

  it("returns useful warnings when every cohort and aggregate are unavailable", () => {
    const invalidCohorts: Cohort[] = [
      {
        id: "descending",
        name: "Descending",
        mode: "roi",
        spend: 100,
        observations: [
          { day: 1, value: 0.4 },
          { day: 7, value: 0.2 },
        ],
      },
      {
        id: "missing-cac",
        name: "Missing CAC",
        mode: "ltv_cac",
        spend: 100,
        observations: [
          { day: 1, value: 2 },
          { day: 7, value: 3 },
        ],
      } as Cohort,
    ];

    const project = analyzeProject(invalidCohorts, 1.37);

    expect(project.cohorts).toHaveLength(2);
    expect(project.cohorts.every((result) => result.selectedModelId === undefined)).toBe(true);
    expect(project.cohorts.every((result) => result.warnings.length > 0)).toBe(true);
    expect(project.aggregate).toMatchObject({
      subjectId: "aggregate",
      reachesTarget: false,
      confidence: "low",
    });
    expect(project.aggregate?.selectedModelId).toBeUndefined();
    expect(project.aggregate?.warnings.join("")).toMatch(/汇总|无效|CAC/u);
  });

  it("does not silently repair a decreasing exact-day aggregate caused by changing contributors", () => {
    const cohorts: Cohort[] = [
      {
        id: "early-high",
        name: "Early high",
        mode: "roi",
        spend: 100,
        observations: [
          { day: 1, value: 0.8 },
          { day: 30, value: 1 },
        ],
      },
      {
        id: "late-low",
        name: "Late low",
        mode: "roi",
        spend: 900,
        observations: [
          { day: 7, value: 0.2 },
          { day: 30, value: 0.3 },
        ],
      },
    ];

    const project = analyzeProject(cohorts, 1.37);

    expect(project.aggregate).toMatchObject({
      subjectId: "aggregate",
      models: [],
      reachesTarget: false,
      confidence: "low",
    });
    expect(project.aggregate?.selectedModelId).toBeUndefined();
    expect(project.aggregate?.warnings.join("")).toMatch(/下降|贡献|汇总/u);
  });

  it("omits bounds and warns instead of inventing precision when interval evidence is insufficient", () => {
    const sparse: Cohort = {
      id: "sparse",
      name: "Sparse",
      mode: "roi",
      spend: 1_000,
      observations: [
        { day: 1, value: 0.1 },
        { day: 7, value: 0.2 },
        { day: 30, value: 0.4 },
      ],
    };

    const result = analyzeCohort(sparse, [sparse], 1.37);
    expect(result.selectedModelId).toBeUndefined();
    expect(result.models.some((model) => model.status === "invalid" && model.reason?.includes("最新观测"))).toBe(true);
    expect(result.confidenceReasons).toEqual(expect.any(Array));
    expect(result.warnings.join("")).toMatch(/区间.*不足|无法.*区间/u);
  });

  it("handles a non-positive target without throwing and warns every returned result", () => {
    const project = analyzeProject(DEMO_COHORTS, 0);

    expect(project.cohorts).toHaveLength(4);
    for (const result of [...project.cohorts, project.aggregate!]) {
      expect(result.reachesTarget).toBe(false);
      expect(result.targetDay).toBeUndefined();
      expect(result.targetGap).toBeUndefined();
      expect(result.targetGapRatio).toBeUndefined();
      expect(result.warnings.join("")).toMatch(/目标.*大于 0/u);
    }
  });
});
