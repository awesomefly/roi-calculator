import type { AnalysisResult } from "../domain/types";

function metric(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "不可用" : value.toFixed(3);
}

function signedMetric(value: number | undefined): string {
  const formatted = metric(value);
  return value !== undefined && Number.isFinite(value) && value > 0 ? `+${formatted}` : formatted;
}

function percentage(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "不可用";
  const percent = value * 100;
  const rounded = Math.sign(percent) * Math.round((Math.abs(percent) + Number.EPSILON) * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

const CONFIDENCE_LABELS: Record<AnalysisResult["confidence"], string> = {
  high: "高置信度",
  medium: "中置信度",
  low: "低置信度",
};

export default function SummaryCards({ result, target }: { result: AnalysisResult; target: number }): JSX.Element {
  const recommended = result.models.find((model) => model.id === result.selectedModelId && model.status === "ok");
  const hasConclusion = result.roi360 !== undefined && recommended !== undefined;

  return (
    <section aria-labelledby="summary-title" className="summary-cards">
      <div className="summary-cards__heading">
        <h2 id="summary-title">结论概览</h2>
        <p>目标 ROI {target.toFixed(3)}</p>
      </div>
      <dl className="summary-cards__grid">
        <div><dt>预测 ROI360</dt><dd>{metric(result.roi360)}</dd></div>
        <div><dt>目标差距</dt><dd>{signedMetric(result.targetGap)}</dd></div>
        <div><dt>相对差距</dt><dd>{percentage(result.targetGapRatio)}</dd></div>
        <div>
          <dt>目标结论</dt>
          <dd>{hasConclusion
            ? <><span aria-hidden="true">{result.reachesTarget ? "✓" : "✕"}</span> <span>{result.reachesTarget ? "预计达标" : "预计未达标"}</span></>
            : <><span aria-hidden="true">—</span> <span>暂无结论</span></>}</dd>
        </div>
        <div>
          <dt>预计达标时间</dt>
          <dd>{hasConclusion && result.reachesTarget && result.targetDay !== undefined
            ? `预计第 ${result.targetDay} 天达到目标`
            : hasConclusion
              ? "预计 360 天内无法达到目标"
              : "待有效模型生成后计算"}</dd>
        </div>
        <div><dt>自动推荐模型</dt><dd>{recommended?.label ?? "无可用推荐"}</dd></div>
        <div><dt>置信度</dt><dd>{CONFIDENCE_LABELS[result.confidence]}</dd></div>
        <div><dt>置信度依据</dt><dd>{result.confidenceReasons?.length
          ? <ul>{result.confidenceReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          : "暂无可用依据"}</dd></div>
      </dl>
    </section>
  );
}
