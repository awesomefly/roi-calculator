import { describe, expect, it } from "vitest";
import type { Cohort, Observation } from "../domain/types";
import { cumulativeMax, validateCohorts } from "./validate";

const cohort = (overrides: Partial<Cohort> = {}): Cohort => ({
  id: "cohort-a",
  name: "Cohort A",
  mode: "roi",
  observations: [
    { day: 1, value: 0.1 },
    { day: 7, value: 0.4 },
  ],
  ...overrides,
} as Cohort);

describe("validateCohorts", () => {
  it.each([
    ["duplicate", [{ day: 1, value: 0.1 }, { day: 1, value: 0.2 }]],
    ["non-positive", [{ day: 0, value: 0.1 }]],
    ["non-integer", [{ day: 1.5, value: 0.1 }]],
  ])("blocks %s observation days", (_description, observations) => {
    const result = validateCohorts([cohort({ observations })]);

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortId: "cohort-a", field: "observations.day", severity: "error" }),
      ]),
    );
  });

  it("rejects observation days beyond the D360 forecast horizon with a precise issue", () => {
    const result = validateCohorts([cohort({ observations: [{ day: 361, value: 0.5 }] })]);

    expect(result.errors).toContainEqual(expect.objectContaining({
      field: "observations.day",
      message: "Day 361 must be between 1 and 360.",
    }));
  });

  it.each([-0.1, Infinity, NaN])("blocks a negative or non-finite observation value: %p", (value) => {
    const result = validateCohorts([cohort({ observations: [{ day: 1, value }] })]);

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortId: "cohort-a", field: "observations.value", severity: "error" }),
      ]),
    );
  });

  it.each([undefined, 0, -1, NaN, Infinity])("blocks invalid row CAC in LTV mode: %p", (cac) => {
    const result = validateCohorts([cohort({
      mode: "ltv_cac",
      observations: [{ day: 1, value: 2, cac }, { day: 7, value: 8, cac: 20 }],
    } as Partial<Cohort>)]);

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortId: "cohort-a", field: "observations.cac", severity: "error" }),
      ]),
    );
  });

  it("blocks descending converted ROI even when cumulative LTV increases", () => {
    const result = validateCohorts([cohort({
      mode: "ltv_cac",
      observations: [{ day: 1, value: 6.5, cac: 10 }, { day: 7, value: 12.4, cac: 20 }],
    })]);

    expect(result.isValid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      field: "observations.roi",
      message: "Converted cumulative ROI decreases at day(s): 7.",
    }));
  });

  it("blocks duplicate cohort names", () => {
    const result = validateCohorts([cohort(), cohort({ id: "cohort-b", name: "Cohort A" })]);

    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortId: "cohort-b", field: "name", severity: "error" }),
      ]),
    );
  });

  it("requires a positive spend only when aggregation validation is requested", () => {
    const withoutAggregation = validateCohorts([cohort({ spend: 0 })]);
    const withAggregation = validateCohorts([cohort({ spend: 0 })], { requireSpend: true });

    expect(withoutAggregation.isValid).toBe(true);
    expect(withAggregation.isValid).toBe(false);
    expect(withAggregation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortId: "cohort-a", field: "spend", severity: "error" }),
      ]),
    );
  });

  it("blocks descending cumulative observations without changing their values", () => {
    const source = cohort({
      observations: [
        { day: 1, value: 0.4 },
        { day: 7, value: 0.2 },
      ],
    });
    const result = validateCohorts([source]);

    expect(result.isValid).toBe(false);
    expect(result.cohorts[0]?.observations).toEqual(source.observations);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cohortId: "cohort-a", field: "observations.value", severity: "error" }),
      ]),
    );
  });

  it("repairs descending cumulative observations only when explicitly requested and reports a warning", () => {
    const result = validateCohorts(
      [
        cohort({
          observations: [
            { day: 1, value: 0.4 },
            { day: 7, value: 0.2 },
            { day: 30, value: 0.5 },
          ],
        }),
      ],
      { repairMonotonic: true },
    );

    expect(result.isValid).toBe(true);
    expect(result.cohorts[0]?.observations).toEqual([
      { day: 1, value: 0.4 },
      { day: 7, value: 0.4 },
      { day: 30, value: 0.5 },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ cohortId: "cohort-a", field: "observations.value", severity: "warning" }),
    ]);
  });

  it("preserves observation order and values without repair while leaving the source untouched", () => {
    const source = cohort({ observations: [{ day: 7, value: 0.4 }, { day: 1, value: 0.1 }] });
    const original = structuredClone(source);

    const result = validateCohorts([source]);

    expect(result.cohorts[0]?.observations).toEqual([{ day: 7, value: 0.4 }, { day: 1, value: 0.1 }]);
    expect(source).toEqual(original);
  });
});

describe("cumulativeMax", () => {
  it("returns day-sorted observations capped at the preceding cumulative maximum", () => {
    const observations: Observation[] = [
      { day: 30, value: 0.5 },
      { day: 1, value: 0.4 },
      { day: 7, value: 0.2 },
    ];

    expect(cumulativeMax(observations)).toEqual([
      { day: 1, value: 0.4 },
      { day: 7, value: 0.4 },
      { day: 30, value: 0.5 },
    ]);
    expect(observations).toEqual([
      { day: 30, value: 0.5 },
      { day: 1, value: 0.4 },
      { day: 7, value: 0.2 },
    ]);
  });
});
