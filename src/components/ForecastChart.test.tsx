import { render, screen, waitFor } from "@testing-library/react";
import type { AnalysisResult, ModelResult } from "../domain/types";
import ForecastChart from "./ForecastChart";

class SizedResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    queueMicrotask(() => this.callback([{
      target,
      contentRect: { width: 280, height: 360 },
    } as ResizeObserverEntry], this));
  }

  unobserve(): void {}
  disconnect(): void {}
}

describe("forecast chart Y axis", () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("renders compact Y-axis ticks that fit a mobile-width chart", async () => {
    globalThis.ResizeObserver = SizedResizeObserver;
    const models: ModelResult[] = [{
      id: "power",
      label: "幂函数模型",
      status: "ok",
      predictions: [
        { day: 1, value: 0.1 },
        { day: 360, value: 2.052665778899 },
      ],
    }];
    const result: AnalysisResult = {
      subjectId: "mobile-axis",
      models,
      selectedModelId: "power",
      roi360: 2.052665778899,
      targetGap: 0.682665778899,
      targetGapRatio: 0.498296189,
      reachesTarget: true,
      targetDay: 240,
      confidence: "low",
      warnings: [],
    };

    const { container } = render(
      <ForecastChart
        observed={[{ day: 1, value: 0.1 }]}
        result={result}
        target={1.37}
        previewModelId="power"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick-value").length).toBeGreaterThan(0);
    });
    const labels = [...container.querySelectorAll(".recharts-yAxis .recharts-cartesian-axis-tick-value")]
      .map((tick) => tick.textContent ?? "");

    expect(labels).toContain("2.05");
    expect(labels).not.toContain("2.052665778899");
    expect(labels.every((label) => /^\d+(?:\.\d{1,2})?$/u.test(label))).toBe(true);
  });

  it("uses a compact formatter with sufficient mobile-safe axis spacing", async () => {
    const module = await import("./ForecastChart");
    const config = Reflect.get(module, "FORECAST_Y_AXIS_CONFIG") as {
      width?: number;
      tickMargin?: number;
      tickFormatter?: (value: number) => string;
    } | undefined;

    expect(config).toBeDefined();
    expect(config?.width).toBeGreaterThanOrEqual(44);
    expect(config?.width).toBeLessThanOrEqual(52);
    expect(config?.tickMargin).toBeGreaterThanOrEqual(4);
    expect([0, 0.45, 0.9, 1.35, 2.052665778899].map((value) => config?.tickFormatter?.(value))).toEqual([
      "0",
      "0.45",
      "0.9",
      "1.35",
      "2.05",
    ]);
  });

  it("shows aggregate contributor count and spend in the chart fallback table", () => {
    const result: AnalysisResult = {
      subjectId: "aggregate",
      models: [],
      reachesTarget: false,
      confidence: "low",
      warnings: [],
    };
    render(<ForecastChart
      observed={[{ day: 7, value: 0.4, contributorCount: 1, contributingSpend: 100 }]}
      result={result}
      target={1.37}
    />);

    expect(screen.getByText("贡献批次数")).toBeInTheDocument();
    expect(screen.getByText("贡献成本")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "100.000" })).toBeInTheDocument();
  });
});
