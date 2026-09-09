import { render, screen } from "@testing-library/react";
import ModelCurvesChart from "./ModelCurvesChart";

const predictions = Array.from({ length: 360 }, (_, index) => ({ day: index + 1, value: (index + 1) / 360 }));

describe("model curve colors", () => {
  it("gives an aggregate model and each cohort curve a different visible color", () => {
    render(<ModelCurvesChart
      title="多模型拟合曲线"
      observed={[]}
      observedGroups={[
        { id: "a", label: "批次 A", observations: [{ day: 1, value: 0.1 }] },
        { id: "b", label: "批次 B", observations: [{ day: 1, value: 0.2 }] },
        { id: "c", label: "批次 C", observations: [{ day: 1, value: 0.3 }] },
      ]}
      series={[
        { id: "historical_multiplier", label: "历史倍率批次综合曲线", predictions },
        { id: "historical_multiplier-a", label: "批次 A 拟合曲线", predictions },
        { id: "historical_multiplier-b", label: "批次 B 拟合曲线", predictions },
        { id: "historical_multiplier-c", label: "批次 C 拟合曲线", predictions },
      ]}
    />);

    const colors = [
      screen.getByTestId("curve-color-historical_multiplier"),
      screen.getByTestId("curve-color-historical_multiplier-a"),
      screen.getByTestId("curve-color-historical_multiplier-b"),
      screen.getByTestId("curve-color-historical_multiplier-c"),
    ].map((item) => item.getAttribute("data-color"));

    expect(new Set(colors).size).toBe(4);
    expect(screen.getByTestId("curve-color-historical_multiplier-a")).toHaveAttribute("data-color", "#2563eb");
    expect(screen.getByTestId("curve-color-historical_multiplier-b")).toHaveAttribute("data-color", "#16a34a");
    expect(screen.getByTestId("curve-color-historical_multiplier-c")).toHaveAttribute("data-color", "#9333ea");
  });
});
