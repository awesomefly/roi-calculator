/// <reference types="vite/client" />

import { fireEvent, render, screen, within } from "@testing-library/react";
import ts from "typescript";
import App from "./App";
import { PROJECT_STORAGE_KEY, type StorageAdapter } from "./io/storage";

const componentSources = import.meta.glob(["./App.tsx", "./components/*.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function clickableNonControls(source: string): Array<{ line: number; tag: "div" | "span" }> {
  const sourceFile = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Array<{ line: number; tag: "div" | "span" }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      const clickable = node.attributes.properties.some((attribute) => (
        ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "onClick"
      ));
      if ((tag === "div" || tag === "span") && clickable) {
        findings.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          tag,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return findings;
}

function projectStorage(): StorageAdapter {
  const observations = [
    { day: 1, value: 0.1 },
    { day: 7, value: 0.2 },
    { day: 15, value: 0.3 },
    { day: 30, value: 0.4 },
    { day: 60, value: 0.6 },
    { day: 90, value: 0.8 },
    { day: 120, value: 1 },
    { day: 180, value: 1.2 },
    { day: 360, value: 1.6 },
  ];
  const project = {
    version: 3,
    cohort: {
      id: "accessible-cohort",
      name: "无障碍验证批次",
      mode: "roi",
      spend: 100,
      observations,
    },
    uiDraft: {
      id: "accessible-cohort",
      name: "无障碍验证批次",
      mode: "roi",
      spend: "100",
      observations: {
        roi: observations.map((observation, index) => ({
          id: `observation-${index + 1}`,
          day: String(observation.day),
          value: String(observation.value),
          cac: "",
        })),
        ltv_cac: [{ id: "observation-10", day: "", value: "", cac: "" }],
      },
    },
  };
  const values = new Map([[PROJECT_STORAGE_KEY, JSON.stringify(project)]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("workbench accessibility structure", () => {
  it("exposes one named main landmark, one H1, labeled sections, and live statuses", () => {
    const { container } = render(<App storage={projectStorage()} />);

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main", { name: "ROI 预估工作台" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "预估曲线拟合" })).toBeInTheDocument();

    const sections = [...container.querySelectorAll("section")];
    expect(sections.length).toBeGreaterThan(0);
    sections.forEach((section) => expect(section).toHaveAccessibleName());

    expect(screen.getByRole("status", { name: "本地保存状态" })).toHaveAttribute("aria-live", "polite");
  });

  it("gives every form field and import or export action an accessible name", () => {
    const { container } = render(<App storage={projectStorage()} />);

    const fields = [...container.querySelectorAll("input:not([hidden]), select, textarea")];
    expect(fields.length).toBeGreaterThan(0);
    fields.forEach((field) => expect(field).toHaveAccessibleName());

    expect(screen.getByRole("button", { name: "导入 CSV" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出数据到本地" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从本地导入数据" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导出结果 CSV" })).not.toBeInTheDocument();
  });

  it("uses semantic table headers and native buttons for clickable actions", () => {
    render(<App storage={projectStorage()} />);

    screen.getAllByRole("table").forEach((table) => {
      expect(within(table).getAllByRole("columnheader").length).toBeGreaterThan(0);
    });

    const findings = Object.entries(componentSources).flatMap(([file, source]) => (
      clickableNonControls(source).map((finding) => ({ file, ...finding }))
    ));
    expect(findings).toEqual([]);
    screen.getAllByRole("button").forEach((button) => expect(button.tagName).toBe("BUTTON"));
  });

  it("detects an injected clickable div or span fixture", () => {
    const badFixture = `
      <div className="card" onClick={() => openCard()}>Open</div>
      <span onClick={handleMore}>More</span>
    `;

    expect(clickableNonControls(badFixture)).toEqual([
      { line: 2, tag: "div" },
      { line: 3, tag: "span" },
    ]);
  });

  it("lets the responsive chart shrink to the mobile canvas without a hard minimum width", () => {
    const { container } = render(<App storage={projectStorage()} />);

    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    const responsiveContainer = container.querySelector(".recharts-responsive-container");
    expect(responsiveContainer).toBeInTheDocument();
    expect(responsiveContainer).toHaveStyle({ width: "100%", height: "360px" });
    expect(responsiveContainer).not.toHaveStyle({ minWidth: "320px" });
    expect(screen.getByTestId("model-curves-chart")).toHaveClass("model-curves-chart__canvas");
  });

  it("preserves a named modal dialog for CSV import", () => {
    render(<App storage={projectStorage()} />);

    fireEvent.click(screen.getByRole("button", { name: "导入 CSV" }));
    expect(screen.getByRole("dialog", { name: "导入 CSV" })).toHaveAttribute("aria-modal", "true");
  });

  it("names the recovery alert section when local data cannot be read", () => {
    const storage: StorageAdapter = {
      getItem: (key) => key === PROJECT_STORAGE_KEY ? "{bad json" : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    render(<App storage={storage} />);

    expect(screen.getByRole("alert", { name: "本地暂存数据无法读取" })).toBeInTheDocument();
  });
});
