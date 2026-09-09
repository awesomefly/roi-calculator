import { useState } from "react";
import type { AnalysisResult, ForecastPoint, ModelResult } from "../domain/types";

const KEY_DAYS = new Set([1, 7, 15, 30, 60, 90, 120, 180, 360]);

function value(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(3);
}

export default function ForecastTable(props: {
  result: AnalysisResult;
  previewModelId?: ModelResult["id"];
}): JSX.Element {
  const [view, setView] = useState<"key" | "daily">("key");
  const preview = props.result.models.find((model) => model.id === props.previewModelId && model.status === "ok");
  const rows: ForecastPoint[] = preview
    ? preview.predictions.filter((point) => view === "daily" || KEY_DAYS.has(point.day))
    : [];

  return (
    <section aria-labelledby="forecast-table-title" className="forecast-table">
      <div className="forecast-table__heading">
        <h2 id="forecast-table-title">预测明细</h2>
        <div role="group" aria-label="预测表视图">
          <button type="button" aria-pressed={view === "key"} onClick={() => setView("key")}>关键日</button>
          <button type="button" aria-pressed={view === "daily"} onClick={() => setView("daily")}>逐日</button>
        </div>
      </div>
      {preview ? (
        <div className="table-scroll">
          <table aria-label={`${preview.label}预测明细`}>
            <thead><tr><th scope="col">日期</th><th scope="col">预测 ROI</th><th scope="col">下限</th><th scope="col">上限</th></tr></thead>
            <tbody>{rows.map((point) => (
              <tr key={point.day}><td>D{point.day}</td><td>{value(point.value)}</td><td>{value(point.lower)}</td><td>{value(point.upper)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p>当前没有可预览的模型预测数据。</p>}
    </section>
  );
}
