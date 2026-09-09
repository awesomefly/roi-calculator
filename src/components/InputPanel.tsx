import { useRef, useState } from "react";
import type { Cohort } from "../domain/types";
import { createCsvBlob, createLtvTemplate, createRoiTemplate } from "../io/csv";
import CohortEditor, { type CohortDraft, type DraftErrors } from "./CohortEditor";
import ImportDialog from "./ImportDialog";

export type DownloadFile = (blob: Blob, filename: string) => void;

export function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

interface InputPanelProps {
  target: string;
  targetError?: string;
  drafts: CohortDraft[];
  errors: DraftErrors;
  canRepairMonotonic: boolean;
  downloadFile: DownloadFile;
  onTargetChange: (value: string) => void;
  onDraftChange: (draft: CohortDraft) => void;
  onAddCohort: () => void;
  onRemoveCohort: (id: string) => void;
  onImport: (cohorts: Cohort[]) => void;
  onRepairMonotonic: () => void;
}

export default function InputPanel(props: InputPanelProps): JSX.Element {
  const [importOpen, setImportOpen] = useState(false);
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const closeImport = () => {
    setImportOpen(false);
    importTriggerRef.current?.focus();
  };
  return (
    <section aria-labelledby="input-panel-title" className="input-panel">
      <h2 id="input-panel-title">输入数据</h2>
      <label>目标 ROI<input inputMode="decimal" value={props.target} onChange={(event) => props.onTargetChange(event.currentTarget.value)} aria-describedby={props.targetError ? "target-roi-error" : undefined} /></label>
      {props.targetError && <p id="target-roi-error" role="alert">{props.targetError}</p>}
      <div className="input-panel__tools">
        <button ref={importTriggerRef} type="button" onClick={() => setImportOpen(true)}>导入 CSV</button>
        <button type="button" onClick={() => props.downloadFile(createCsvBlob(createRoiTemplate()), "roi-import-template.csv")}>下载 ROI 模板</button>
        <button type="button" onClick={() => props.downloadFile(createCsvBlob(createLtvTemplate()), "ltv-cac-import-template.csv")}>下载 LTV + CAC 模板</button>
      </div>
      <div className="input-panel__cohorts">
        {props.drafts.map((draft, index) => <CohortEditor key={draft.id} draft={draft} sequence={index + 1} errors={props.errors} canRemove={props.drafts.length > 1} onChange={props.onDraftChange} onRemove={() => props.onRemoveCohort(draft.id)} />)}
      </div>
      <div className="input-panel__actions">
        <button type="button" onClick={props.onAddCohort}>添加批次</button>
        {props.canRepairMonotonic && <button type="button" onClick={props.onRepairMonotonic}>按累计最大值修正</button>}
      </div>
      {importOpen && <ImportDialog onImport={props.onImport} onClose={closeImport} />}
    </section>
  );
}
