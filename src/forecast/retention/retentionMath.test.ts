import { describe, expect, it } from "vitest";
import { anchorMonotoneCurve, predictLinear, retentionAtDay, ridgeRegression, safeLogit } from "./retentionMath";

describe("retention math", () => {
  it("interpolates retention in log-day and logit space", () => {
    const observations = [
      { day: 1, value: 0.1, retention: 0.4 },
      { day: 9, value: 0.4, retention: 0.2 },
    ];
    const midpoint = retentionAtDay(observations, 3);
    expect(midpoint).toBeCloseTo(0.2899, 3);
    expect(retentionAtDay(observations, 1)).toBeCloseTo(0.4, 8);
    expect(retentionAtDay(observations, 9)).toBeCloseTo(0.2, 8);
  });

  it("anchors a raw curve exactly while preserving a complete monotone series", () => {
    const raw = Array.from({ length: 360 }, (_, index) => ({ day: index + 1, value: Math.sqrt(index + 1) }));
    const anchored = anchorMonotoneCurve(raw, [
      { day: 1, value: 0.1, retention: 0.4 },
      { day: 7, value: 0.3, retention: 0.25 },
      { day: 30, value: 0.6, retention: 0.12 },
    ]);
    expect(anchored).toHaveLength(360);
    expect(anchored[0]?.value).toBeCloseTo(0.1, 12);
    expect(anchored[6]?.value).toBeCloseTo(0.3, 12);
    expect(anchored[29]?.value).toBeCloseTo(0.6, 12);
    expect(anchored.every((point, index) => Number.isFinite(point.value) && point.value >= 0 && (index === 0 || point.value >= anchored[index - 1]!.value))).toBe(true);
  });

  it("solves a regularized linear relationship without producing non-finite coefficients", () => {
    const coefficients = ridgeRegression([[1, 0], [1, 1], [1, 2]], [1, 3, 5], 1e-8);
    expect(coefficients).toHaveLength(2);
    expect(predictLinear(coefficients!, [1, 3])).toBeCloseTo(7, 5);
    expect(Number.isFinite(safeLogit(0))).toBe(true);
    expect(Number.isFinite(safeLogit(1))).toBe(true);
  });
});
