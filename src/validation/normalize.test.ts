import { describe, expect, it } from "vitest";
import type { Cohort } from "../domain/types";
import { cohortToRoi, parseMetric } from "./normalize";

describe("parseMetric", () => {
  it.each([
    ["42%", 0.42],
    ["1.37", 1.37],
    [42, 42],
    ["  42%  ", 0.42],
  ])("parses %p as %p", (value, expected) => {
    expect(parseMetric(value)).toBe(expected);
  });

  it.each(["", "   ", "not a number", "42%%", "Infinity", "NaN", Infinity, NaN])(
    "returns null for invalid metric %p",
    (value) => {
      expect(parseMetric(value)).toBeNull();
    },
  );
});

describe("cohortToRoi", () => {
  const roiCohort: Cohort = {
    id: "roi",
    name: "ROI cohort",
    mode: "roi",
    observations: [
      { day: 30, value: 0.5 },
      { day: 7, value: 0.2 },
    ],
  };

  it("passes ROI observations through in day order without mutating the source", () => {
    const original = [...roiCohort.observations];

    expect(cohortToRoi(roiCohort)).toEqual([
      { day: 7, value: 0.2 },
      { day: 30, value: 0.5 },
    ]);
    expect(roiCohort.observations).toEqual(original);
  });

  it("divides each LTV observation by its own positive CAC and sorts by day", () => {
    const cohort: Cohort = {
      id: "ltv",
      name: "LTV cohort",
      mode: "ltv_cac",
      observations: [
        { day: 30, value: 18, cac: 20 },
        { day: 7, value: 8, cac: 16 },
      ],
    };

    expect(cohortToRoi(cohort)).toEqual([
      { day: 7, value: 0.5 },
      { day: 30, value: 0.9 },
    ]);
  });

  it.each([undefined, 0, -1, NaN, Infinity])("returns an empty result for invalid CAC %p", (cac) => {
    expect(
      cohortToRoi({ ...roiCohort, mode: "ltv_cac", observations: [{ day: 7, value: 8, cac }] } as Cohort),
    ).toEqual([]);
  });
});
