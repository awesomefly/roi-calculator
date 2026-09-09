import { describe, expect, it } from "vitest";
import type { Cohort } from "../domain/types";
import { aggregateCohorts } from "./aggregate";

describe("aggregateCohorts", () => {
  it("cost-weights ROI values independently at every observed day", () => {
    const result = aggregateCohorts([
      {
        id: "low-spend",
        name: "Low spend",
        mode: "roi",
        spend: 100,
        observations: [
          { day: 7, value: 0.4 },
          { day: 30, value: 0.8 },
        ],
      },
      {
        id: "high-spend",
        name: "High spend",
        mode: "roi",
        spend: 300,
        observations: [
          { day: 7, value: 0.8 },
          { day: 30, value: 1.2 },
        ],
      },
    ]);

    expect(result.observations).toEqual([
      { day: 7, value: 0.7, contributorCount: 2, contributingSpend: 400 },
      { day: 30, value: 1.1, contributorCount: 2, contributingSpend: 400 },
    ]);
  });

  it("excludes a missing value and its spend from that day's denominator", () => {
    const result = aggregateCohorts([
      {
        id: "early",
        name: "Early",
        mode: "roi",
        spend: 100,
        observations: [
          { day: 7, value: 0.4 },
          { day: 30, value: 0.8 },
        ],
      },
      {
        id: "late",
        name: "Late",
        mode: "roi",
        spend: 900,
        observations: [{ day: 30, value: 1.2 }],
      },
    ]);

    expect(result.observations).toEqual([
      { day: 7, value: 0.4, contributorCount: 1, contributingSpend: 100 },
      { day: 30, value: 1.16, contributorCount: 2, contributingSpend: 1000 },
    ]);
  });

  it("converts LTV/CAC values before weighting", () => {
    const result = aggregateCohorts([
      {
        id: "ltv",
        name: "LTV",
        mode: "ltv_cac",
        spend: 100,
        observations: [{ day: 7, value: 10, cac: 20 }],
      },
      {
        id: "roi",
        name: "ROI",
        mode: "roi",
        spend: 300,
        observations: [{ day: 7, value: 1 }],
      },
    ]);

    expect(result.observations).toEqual([{ day: 7, value: 0.875, contributorCount: 2, contributingSpend: 400 }]);
  });

  it("uses each LTV observation's CAC independently", () => {
    const result = aggregateCohorts([{
      id: "ltv",
      name: "LTV",
      mode: "ltv_cac",
      spend: 100,
      observations: [
        { day: 1, value: 2, cac: 20 },
        { day: 7, value: 6, cac: 24 },
      ],
    }]);

    expect(result.observations.map(({ day, value }) => ({ day, value }))).toEqual([
      { day: 1, value: 0.1 },
      { day: 7, value: 0.25 },
    ]);
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails explicitly for invalid spend %p",
    (spend) => {
      const cohort: Cohort = {
        id: "invalid-spend",
        name: "Invalid spend",
        mode: "roi",
        spend,
        observations: [{ day: 7, value: 0.5 }],
      };

      expect(() => aggregateCohorts([cohort])).toThrow(/spend/i);
    },
  );

  it("returns a stable synthetic ROI cohort in ascending day order without mutating inputs", () => {
    const cohorts: Cohort[] = [
      {
        id: "source",
        name: "Source",
        mode: "roi",
        spend: 100,
        observations: [
          { day: 30, value: 0.8 },
          { day: 7, value: 0.4 },
        ],
      },
    ];
    const before = structuredClone(cohorts);

    expect(aggregateCohorts(cohorts)).toEqual({
      id: "aggregate",
      name: "全部批次汇总",
      mode: "roi",
      observations: [
        { day: 7, value: 0.4, contributorCount: 1, contributingSpend: 100 },
        { day: 30, value: 0.8, contributorCount: 1, contributingSpend: 100 },
      ],
    });
    expect(cohorts).toEqual(before);
  });
});
