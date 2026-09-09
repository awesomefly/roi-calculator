import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cohortDraftsFrom, createEmptyCohortDraft, type CohortDraft } from "./components/CohortEditor";
import FitWorkspace, { cohortsFromDrafts } from "./components/FitWorkspace";
import Header, { type SaveStatus } from "./components/Header";
import { browserDownload, type DownloadFile } from "./components/InputPanel";
import ProjectDocumentActions from "./components/ProjectDocumentActions";
import RoiEstimator from "./components/RoiEstimator";
import AssessmentStandards from "./components/AssessmentStandards";
import type { AppPage } from "./components/Header";
import { DEMO_COHORTS, RETENTION_DEMO_COHORTS } from "./domain/demoData";
import { createProjectDocument, parseProjectDocument, readLocalDocument } from "./io/projectDocument";
import { deleteModelPackageRecord, loadModelPackageRecords, replaceModelPackagesV4, saveModelPackageV4, type IncompatibleModelPackage, type ModelPackageV4 } from "./io/savedCurves";
import { loadProject, saveProject, type StorageAdapter } from "./io/storage";

interface AppProps { storage?: StorageAdapter; downloadFile?: DownloadFile; confirmClear?: (message: string) => boolean; capturePng?: unknown }
interface InitialState { drafts: CohortDraft[]; status: SaveStatus; isDemo: boolean; recoveryRaw?: string }

function demoDrafts(): CohortDraft[] { return cohortDraftsFrom(DEMO_COHORTS.filter((cohort) => cohort.mode === "roi").slice(0, 3)); }
function retentionDemoDrafts(): CohortDraft[] { return cohortDraftsFrom(RETENTION_DEMO_COHORTS); }

function initialState(storage: StorageAdapter | undefined): InitialState {
  const loaded = loadProject(storage);
  if (loaded.status === "ok") return { drafts: loaded.project.uiDrafts as CohortDraft[], status: "", isDemo: loaded.project.demo === true };
  if (loaded.status === "version_mismatch") return { drafts: [createEmptyCohortDraft()], status: "本地数据版本不兼容", isDemo: false, recoveryRaw: loaded.raw };
  if (loaded.status === "corrupted") return { drafts: demoDrafts(), status: "", isDemo: true, recoveryRaw: loaded.raw };
  if (loaded.status === "unavailable") return { drafts: demoDrafts(), status: "本地读取失败", isDemo: true };
  return { drafts: demoDrafts(), status: "", isDemo: true };
}

export default function App({ storage, downloadFile = browserDownload, confirmClear = (message) => window.confirm(message) }: AppProps = {}): JSX.Element {
  const initial = useMemo(() => initialState(storage), [storage]);
  const initialPackages = useMemo(() => loadModelPackageRecords(storage), [storage]);
  const [activePage, setActivePage] = useState<AppPage>("fit");
  const [drafts, setDrafts] = useState(initial.drafts);
  const [notice, setNotice] = useState({ text: initial.status as string, revision: 0 });
  const [isDemo, setIsDemo] = useState(initial.isDemo);
  const [recoveryRaw, setRecoveryRaw] = useState(initial.recoveryRaw);
  const [packages, setPackages] = useState<ModelPackageV4[]>(initialPackages.compatible);
  const [incompatiblePackages, setIncompatiblePackages] = useState<IncompatibleModelPackage[]>(initialPackages.incompatible);
  const mounted = useRef(false);
  const skipNextAutoSave = useRef(false);
  const prepared = useMemo(() => cohortsFromDrafts(drafts), [drafts]);
  const showNotice = useCallback((text: string) => setNotice((current) => ({ text, revision: current.revision + 1 })), []);

  useEffect(() => {
    if (!notice.text) return undefined;
    const timer = window.setTimeout(() => setNotice((current) => current.revision === notice.revision ? { text: "", revision: current.revision } : current), 10_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (skipNextAutoSave.current) { skipNextAutoSave.current = false; return; }
    const successStatus: SaveStatus = isDemo ? "演示数据已加载" : "已保存到本地缓存";
    showNotice(isDemo ? successStatus : "未保存");
    if (recoveryRaw) return;
    const timer = window.setTimeout(() => {
      try {
        const stored = saveProject({ ...(prepared.cohorts ? { cohorts: prepared.cohorts } : {}), demo: isDemo, uiDrafts: drafts }, storage);
        showNotice(stored ? successStatus : "本地保存失败");
      } catch { showNotice("本地保存失败"); }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [drafts, isDemo, prepared.cohorts, recoveryRaw, showNotice, storage]);

  const refreshPackages = () => { const records = loadModelPackageRecords(storage); setPackages(records.compatible); setIncompatiblePackages(records.incompatible); };
  const savePackage = (item: ModelPackageV4) => { const saved = saveModelPackageV4(item, storage); if (saved) refreshPackages(); return saved; };
  const deletePackage = (id: string) => { if (deleteModelPackageRecord(id, storage)) refreshPackages(); };
  const exportDocument = () => {
    if (!prepared.cohorts) { showNotice("数据导出失败：请先修正全部历史批次数据。"); return; }
    const project = { version: 4 as const, cohorts: prepared.cohorts, demo: isDemo, uiDrafts: drafts };
    downloadFile(new Blob([createProjectDocument(project, packages)], { type: "application/json;charset=utf-8" }), "roi-forecast-data.roi.json");
    showNotice("数据已导出到本地下载目录。");
  };
  const openDocument = async (file: File) => {
    let raw: string;
    try { raw = await readLocalDocument(file); } catch { showNotice("本地数据读取失败，当前数据未更改。"); return; }
    const parsed = parseProjectDocument(raw);
    if (parsed.status !== "ok") { showNotice(parsed.status === "version_mismatch" ? "本地数据版本不兼容，当前数据未更改。" : "本地数据无效，当前数据未更改。"); return; }
    try {
      if (!replaceModelPackagesV4(parsed.document.modelPackages, storage)) throw new Error("packages unavailable");
      if (!saveProject({ cohorts: parsed.document.project.cohorts, demo: parsed.document.project.demo, uiDrafts: parsed.document.project.uiDrafts }, storage)) throw new Error("project unavailable");
    } catch { showNotice("本地数据无法完整写入浏览器缓存，当前数据未更改。"); return; }
    skipNextAutoSave.current = true;
    setDrafts(parsed.document.project.uiDrafts as CohortDraft[]); setPackages(parsed.document.modelPackages); setIncompatiblePackages([]);
    setIsDemo(parsed.document.project.demo === true); setRecoveryRaw(undefined); showNotice(`已从本地导入“${file.name}”。`);
  };

  return <main aria-label="ROI 预估工作台">
    <Header activePage={activePage} onNavigate={setActivePage} />
    {activePage === "fit" ? <>
      <div className="workspace-title"><div><h1>预估曲线拟合</h1></div><div className="workspace-actions" role="group" aria-label="本地数据操作"><span role="status" aria-live="polite" aria-label="本地保存状态">{notice.text}</span><button type="button" onClick={() => { setDrafts(demoDrafts()); setIsDemo(true); showNotice("演示数据已加载"); setRecoveryRaw(undefined); }}>载入演示数据</button><button type="button" onClick={() => { setDrafts(retentionDemoDrafts()); setIsDemo(true); showNotice("演示数据已加载"); setRecoveryRaw(undefined); }}>载入 ROI + 留存率演示数据</button><ProjectDocumentActions onExport={exportDocument} onOpen={openDocument} /></div></div>
      {recoveryRaw && <section role="alert" aria-labelledby="storage-recovery-title" className="storage-recovery"><h2 id="storage-recovery-title">本地暂存数据无法读取</h2><p>原始本地数据未被覆盖，可先下载备份后重新录入。</p><button type="button" onClick={() => downloadFile(new Blob([recoveryRaw], { type: "application/json" }), "roi-forecast-recovery.json")}>下载原始本地数据</button></section>}
      <FitWorkspace drafts={drafts} packages={packages} incompatiblePackages={incompatiblePackages} onDraftsChange={(next) => { setDrafts(next); setIsDemo(false); }} onSavePackage={savePackage} onDeletePackage={deletePackage} downloadFile={downloadFile} confirmReplace={confirmClear} />
    </> : activePage === "estimate" ? <RoiEstimator packages={packages} onNavigateToFit={() => setActivePage("fit")} /> : <AssessmentStandards packages={packages} onNavigateToFit={() => setActivePage("fit")} />}
    <footer className="privacy-footer">本地计算，数据不上传</footer>
  </main>;
}
