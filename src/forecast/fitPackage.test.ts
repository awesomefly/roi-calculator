import { describe, expect, it } from "vitest";
import type { Cohort } from "../domain/types";
import { fitModelPackageSource } from "./fitPackage";

const mature: Cohort = {
  id: "history-1",
  name: "成熟历史批次",
  mode: "roi",
  observations: [
    { day: 1, value: 0.2 },
    { day: 7, value: 0.589 },
    { day: 30, value: 0.88 },
    { day: 90, value: 1.1 },
    { day: 180, value: 1.239 },
    { day: 360, value: 1.377 },
  ],
};

describe("single-cohort model-package fitting", () => {
  it("fits ROI + retention cohorts as ROI while preserving retention metadata", () => {
    const fit = fitModelPackageSource({
      ...mature,
      mode: "roi_retention",
      retention: { nextDay: 0.28, day7: 0.16 },
    });

    expect(fit.source).toMatchObject({
      mode: "roi_retention",
      retention: { nextDay: 0.28, day7: 0.16 },
    });
    expect(fit.observations).toEqual(mature.observations);
    expect(fit.models.filter((model) => model.status === "ok").length).toBeGreaterThan(0);
  });

  it("runs all four models without selecting or backtesting one", () => {
    const fit = fitModelPackageSource(mature);

    expect(fit.models.map((model) => model.id)).toEqual([
      "historical_multiplier",
      "logarithmic",
      "power",
      "saturation",
    ]);
    expect(fit.models.every((model) => model.backtestError === undefined)).toBe(true);
    expect(fit.models.filter((model) => model.status === "ok").length).toBeGreaterThan(0);
    expect(fit.evaluationMode).toBe("single_cohort_no_backtest");
    expect(fit.models.filter((model) => model.status === "ok").every((model) => (
      model.predictions[0]?.day === 1 && model.predictions[359]?.day === 360
    ))).toBe(true);
  });

  it("keeps historical multiplier unavailable without observed D360 while preserving other fits", () => {
    const fit = fitModelPackageSource({
      ...mature,
      observations: mature.observations.filter((point) => point.day < 360),
    });

    expect(fit.models.find((model) => model.id === "historical_multiplier")).toMatchObject({
      status: "insufficient_data",
      predictions: [],
    });
    expect(fit.models.some((model) => model.id !== "historical_multiplier" && model.status === "ok")).toBe(true);
  });

  it("stores transparent parameters and in-sample fit error for successful parametric models", () => {
    const fit = fitModelPackageSource(mature);
    const logarithmic = fit.models.find((model) => model.id === "logarithmic");

    expect(logarithmic?.parameters).toMatchObject({
      intercept: expect.any(Number),
      slope: expect.any(Number),
    });
    expect(logarithmic?.fitError).toEqual(expect.any(Number));
  });

  it("stores fitted values and D360 stage multipliers for every real observation day", () => {
    const fit = fitModelPackageSource(mature);
    const historical = fit.models.find((model) => model.id === "historical_multiplier");

    expect(historical?.observationFits).toHaveLength(mature.observations.length);
    expect(historical?.observationFits?.find((point) => point.day === 30)).toMatchObject({
      observed: 0.88,
      fitted: 0.88,
      stageMultiplier: expect.closeTo(1.377 / 0.88, 8),
    });
    expect(fit.models.filter((model) => model.status === "ok").every((model) => (
      model.observationFits?.map((point) => point.day).join(",") === "1,7,30,90,180,360"
    ))).toBe(true);
  });
});
