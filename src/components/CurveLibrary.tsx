import type { AnalysisResult, Observation } from "../domain/types";
import type { SavedCurve } from "../io/savedCurves";

interface CurveLibraryProps {
  name: string;
  curves: SavedCurve[];
  selectedResult?: AnalysisResult;
  selectedSourceName?: string;
  selectedObservations?: Observation[];
  message?: string;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
}

export default function CurveLibrary(props: CurveLibraryProps): JSX.Element {
  const canSave = props.selectedResult?.selectedModelId !== undefined;
  return (
    <section className="curve-library" aria-labelledby="curve-library-title">
      <div>
        <h2 id="curve-library-title">保存拟合曲线</h2>
        <p>将当前自动推荐模型的 D1–D360 预测曲线保存到本地，供“ROI 预估”复用。</p>
      </div>
      <div className="curve-library__form">
        <label>拟合曲线名称<input value={props.name} onChange={(event) => props.onNameChange(event.currentTarget.value)} /></label>
        <button type="button" onClick={props.onSave} disabled={!canSave || !props.name.trim()}>保存拟合曲线</button>
      </div>
      {props.message && <p role="status" aria-live="polite">{props.message}</p>}
      {props.curves.length > 0 && (
        <ul className="curve-library__list">
          {props.curves.map((curve) => (
            <li key={curve.id}>
              <div><strong>{curve.name}</strong><span>{curve.modelLabel} · {curve.trainingPoints} 个训练点 · {curve.sourceName}</span></div>
              <button type="button" onClick={() => props.onDelete(curve.id)} aria-label={`删除拟合曲线 ${curve.name}`}>删除</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
