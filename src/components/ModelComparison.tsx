import type { AnalysisResult, ModelResult } from "../domain/types";

const STATUS_LABELS: Record<ModelResult["status"], { icon: string; text: string }> = {
  ok: { icon: "✓", text: "可用" },
  invalid: { icon: "✕", text: "拟合失败" },
  insufficient_data: { icon: "⚠", text: "样本不足" },
};

export default function ModelComparison(props: {
  result: AnalysisResult;
  previewModelId?: ModelResult["id"];
  onPreviewChange: (modelId: ModelResult["id"]) => void;
}): JSX.Element {
  const recommended = props.result.models.find((model) => model.id === props.result.selectedModelId && model.status === "ok");

  return (
    <section aria-labelledby="model-comparison-title" className="model-comparison">
      <h2 id="model-comparison-title">模型对比</h2>
      <p>业务结论始终基于自动推荐的{recommended?.label ?? "可用模型"}；切换只更改图表和表格预览。</p>
      <fieldset>
        <legend>选择预览模型</legend>
        <div className="model-comparison__grid">
          {props.result.models.map((model) => {
            const selectable = model.status === "ok" && model.predictions.length > 0;
            const recommendedModel = model.id === recommended?.id;
            return (
              <article key={model.id} className="model-card" data-status={model.status}>
                <div className="model-card__title">
                  <label>
                    <input
                      type="radio"
                      name={`model-preview-${props.result.subjectId}`}
                      aria-label={`预览${model.label}`}
                      checked={selectable && props.previewModelId === model.id}
                      disabled={!selectable}
                      onChange={() => props.onPreviewChange(model.id)}
                    />
                    {model.label}
                  </label>
                  {recommendedModel && <span>自动推荐</span>}
                </div>
                <p><span aria-hidden="true">{STATUS_LABELS[model.status].icon}</span> <span>{STATUS_LABELS[model.status].text}</span></p>
                <p>{model.score === undefined ? "得分不可用" : `得分 ${model.score.toFixed(3)}`}</p>
                <p>{model.backtestError === undefined ? "回测误差不可用" : `回测误差 ${(model.backtestError * 100).toFixed(1)}%`}</p>
                {model.reason && <p>{model.reason}</p>}
              </article>
            );
          })}
        </div>
      </fieldset>
    </section>
  );
}
