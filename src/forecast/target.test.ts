import { describe, expect, it } from "vitest";
import { findTargetDay, summarizeTarget } from "./target";

describe("findTargetDay", () => {
  it("uses the product-like 1.37 target rather than ROI 1.0", () => {
    const points = [
      { day: 7, value: 0.8 },
      { day: 30, value: 1.0 },
      { day: 60, value: 1.37 },
    ];

    expect(findTargetDay(points, 1.37)).toBe(60);
  });

  it("returns the first observed day when the target was already reached", () => {
    expect(
      findTargetDay(
        [
          { day: 7, value: 1.5 },
          { day: 30, value: 1.7 },
        ],
        1.37,
      ),
    ).toBe(7);
  });

  it("returns an exact target hit on its observation day", () => {
    expect(
      findTargetDay(
        [
          { day: 7, value: 0.5 },
          { day: 30, value: 1.37 },
        ],
        1.37,
      ),
    ).toBe(30);
  });

  it("linearly interpolates a crossing and rounds up to the next whole day", () => {
    expect(
      findTargetDay(
        [
          { day: 7, value: 1.0 },
          { day: 17, value: 1.5 },
        ],
        1.37,
      ),
    ).toBe(15);
  });

  it("does not report a target day when the target is not reached by D360", () => {
    expect(
      findTargetDay(
        [
          { day: 7, value: 0.1 },
          { day: 360, value: 1.36 },
        ],
        1.37,
      ),
    ).toBeUndefined();
  });

  it("ignores values beyond D360", () => {
    expect(
      findTargetDay(
        [
          { day: 360, value: 1.36 },
          { day: 361, value: 2 },
        ],
        1.37,
      ),
    ).toBeUndefined();
  });

  it("handles invalid targets and invalid points safely", () => {
    expect(findTargetDay([{ day: 7, value: 1.5 }], 0)).toBeUndefined();
    expect(findTargetDay([{ day: 7.5, value: 1.5 }], 1.37)).toBeUndefined();
    expect(findTargetDay([{ day: 7, value: Number.NaN }], 1.37)).toBeUndefined();
  });
});

describe("summarizeTarget", () => {
  it("uses the observed crossing before an earlier fitted crossing", () => {
    const summary = summarizeTarget(
      [
        { day: 1, value: 1 },
        { day: 5, value: 1.4 },
        { day: 360, value: 2 },
      ],
      1.37,
      [
        { day: 7, value: 1.5 },
        { day: 30, value: 1.7 },
      ],
    );

    expect(summary).toMatchObject({ reachesTarget: true, targetDay: 7 });
  });

  it("returns no conclusion for a contradictory forecast below the latest cumulative observation", () => {
    expect(summarizeTarget(
      [{ day: 360, value: 1.2 }],
      1.37,
      [{ day: 7, value: 1.5 }],
    )).toEqual({ reachesTarget: false });
  });

  it("returns a negative signed target gap when ROI360 is below target without looking past D360", () => {
    const summary = summarizeTarget(
      [
        { day: 7, value: 0.1 },
        { day: 360, value: 1.2 },
        { day: 361, value: 9 },
      ],
      1.37,
    );

    expect(summary).toMatchObject({ roi360: 1.2, reachesTarget: false });
    expect(summary.targetGap).toBeCloseTo(-0.17, 12);
    expect(summary.targetGapRatio).toBeCloseTo(-0.17 / 1.37, 12);
  });

  it("returns a positive signed target gap for a reached target and its interpolated day", () => {
    const summary = summarizeTarget(
      [
        { day: 7, value: 1 },
        { day: 17, value: 1.5 },
        { day: 360, value: 2 },
      ],
      1.37,
    );

    expect(summary).toMatchObject({ roi360: 2, reachesTarget: true, targetDay: 15 });
    expect(summary.targetGap).toBeCloseTo(0.63, 12);
    expect(summary.targetGapRatio).toBeCloseTo(0.63 / 1.37, 12);
  });

  it("returns a safe unmet summary for invalid data", () => {
    expect(summarizeTarget([{ day: 360, value: 2 }], Number.NaN)).toEqual({
      reachesTarget: false,
    });
  });
});
