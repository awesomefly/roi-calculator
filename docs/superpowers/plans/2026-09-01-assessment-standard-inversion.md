# Assessment Standard Inversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third “考核标准反推” workspace that derives ROI1/ROI7 standards from a saved ROI curve package and, for retention packages, jointly derives next-day and D7 retention standards.

**Architecture:** A pure `assessmentStandards` module owns package qualification, ROI curve-ratio inversion, mature-sample extraction, uncertainty, monotone grid search, and result types. A focused React page consumes that API; `App` and `Header` only route the page. Existing fitting, persistence, and ROI estimation remain unchanged.

**Tech Stack:** TypeScript 5.7, React 18, Vitest, Testing Library, Vite 5, existing CSS tokens.

**Spec:** `docs/superpowers/specs/2026-09-01-assessment-standard-inversion-design.md`

## Global Constraints

- Default target is D360 cumulative ROI 1.37; target day accepts integer D7–D360.
- An effective model is exactly an ID in `ModelPackageV4.validModelIds` whose model has `status === "ok"`.
- ROI packages return ROI1 and cumulative ROI7 only, with the approved retention-unavailable copy.
- ROI + retention packages use the same package for ROI baselines and joint calibration.
- LTV + CAC packages cannot start inversion.
- Never extrapolate outside complete mature-sample ranges or use a model prediction as the true target-day label.
- Fewer than 3 complete samples returns no standards; 3–4 returns trial standards; 5 or more returns formal standards.
- Do not alter fitting, model-package storage, or ROI-estimation behavior.

---

### Task 1: ROI Standard Inversion Core

**Files:**
- Create: `src/forecast/assessmentStandards.ts`
- Create: `src/forecast/assessmentStandards.test.ts`

**Interfaces:**
- Consumes: `ModelPackageV4` from `src/io/savedCurves.ts`.
- Produces:

```ts
export type AssessmentPackageMode = "roi" | "roi_retention" | "ltv_cac";
export type AssessmentConfidence = "low" | "medium" | "high";

export interface StandardValue {
  recommended: number;
  lower: number;
  upper: number;
  conservativeAdjustment: number;
}

export interface BoundaryPoint {
  roi: number;
  retention: number;
  conservativeTargetRoi: number;
}

export interface AssessmentStandardsResult {
  status: "ok" | "trial" | "unavailable" | "unsupported";
  mode: AssessmentPackageMode;
  confidence: AssessmentConfidence;
  roi1?: StandardValue;
  roi7?: StandardValue;
  nextDayRetention?: StandardValue;
  day7Retention?: StandardValue;
  d1Boundary: BoundaryPoint[];
  d7Boundary: BoundaryPoint[];
  conservativeTargetRoi?: number;
  validModelCount: number;
  matureSampleCount: number;
  warnings: string[];
}

export function invertAssessmentStandards(input: {
  modelPackage: ModelPackageV4;
  targetRoi: number;
  targetDay: number;
}): AssessmentStandardsResult;
```

- [ ] **Step 1: Write failing ROI-only tests**

Create two valid ROI-model fixtures with known D1, D7, and D360 predictions. Assert the exact curve-ratio calculation, effective-model count, missing retention standards, and approved warning. Also cover invalid target, zero effective models, missing target-day prediction, and LTV mode.

```ts
const result = invertAssessmentStandards({ modelPackage, targetRoi: 1.37, targetDay: 360 });
expect(result.status).toBe("ok");
expect(result.mode).toBe("roi");
expect(result.validModelCount).toBe(2);
expect(result.roi1?.recommended).toBeCloseTo(expectedConservativeRoi1, 6);
expect(result.roi7?.recommended).toBeCloseTo(expectedConservativeRoi7, 6);
expect(result.nextDayRetention).toBeUndefined();
expect(result.warnings).toContain("当前模型包不包含留存率数据，只能反推 ROI 标准。如需反推留存率，请选择 ROI + 留存率模型包。");
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm exec vitest run src/forecast/assessmentStandards.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement mode validation and ROI inversion**

Add these private helpers:

```ts
function packageMode(modelPackage: ModelPackageV4): AssessmentPackageMode;
function validModels(modelPackage: ModelPackageV4): ModelPackageV4["models"];
function targetValue(model: ModelResult, day: number): number | undefined;
function boundedError(model: ModelResult): number | undefined;
function roiStandardForModel(model: ModelResult, day: 1 | 7, targetDay: number, targetRoi: number): number | undefined;
function summarizeRoiStandards(values: Array<{ value: number; error?: number }>): StandardValue | undefined;
```

Calculate `targetRoi * prediction[day - 1].value / prediction[targetDay - 1].value` per effective model. The raw mean is the baseline, raw min/max form the range, and `model.parameters?.d360BacktestError ?? model.backtestError` is clamped to `[0, 0.5]`. The recommendation is the mean of `value / (1 - error)` when error exists, otherwise raw value. `conservativeAdjustment` is recommendation minus raw mean.

- [ ] **Step 4: Run tests and verify pass**

Run: `pnpm exec vitest run src/forecast/assessmentStandards.test.ts`

Expected: ROI-only cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/forecast/assessmentStandards.ts src/forecast/assessmentStandards.test.ts
git commit -m "feat: add ROI assessment standard inversion"
```

### Task 2: Retention Joint Calibration

**Files:**
- Modify: `src/forecast/assessmentStandards.ts`
- Modify: `src/forecast/assessmentStandards.test.ts`

**Interfaces:**
- Consumes: Task 1 `roi1` and `roi7` plus true source observations.
- Produces: retention standards, D1/D7 boundaries, confidence, mature sample count, and conservative target ROI.

- [ ] **Step 1: Write failing qualification tests**

Build retention fixtures with exact D1, D7, target-day ROI and D1/D7 retention. Assert 2 samples yield `unavailable/low`, 3 yield `trial/medium`, and 5 yield `ok/high`. Add a cohort with target-day model prediction but no true target-day observation and assert exclusion.

```ts
expect(result2).toMatchObject({ status: "unavailable", confidence: "low", matureSampleCount: 2 });
expect(result3).toMatchObject({ status: "trial", confidence: "medium", matureSampleCount: 3 });
expect(result5).toMatchObject({ status: "ok", confidence: "high", matureSampleCount: 5 });
```

- [ ] **Step 2: Write failing monotonicity and boundary tests**

Use deterministic synthetic data where stronger early ROI/retention implies stronger D360. Assert four standards remain inside history, boundaries are non-empty and ordered, and the selected conservative target ROI reaches 1.37. An unreachable target must return no four standards and warning “目标超出历史数据与模型支持范围，无法可靠反推考核标准。”

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm exec vitest run src/forecast/assessmentStandards.test.ts`

Expected: retention cases FAIL.

- [ ] **Step 4: Implement exact mature-sample extraction**

```ts
interface MatureSample {
  roi1: number;
  roi7: number;
  nextDayRetention: number;
  day7Retention: number;
  targetRoi: number;
}

function matureSamples(modelPackage: ModelPackageV4, targetDay: number): MatureSample[];
```

Require exact source observations at D1, D7, and target day; retention at D1/D7; finite non-negative ROI; retention in `[0,1]`; and `roi1 <= roi7 <= targetRoi`.

- [ ] **Step 5: Implement deterministic prediction utilities**

```ts
function linearGrid(min: number, max: number, count?: number): number[];
function robustScale(values: number[]): number;
function weightedPrediction(samples: MatureSample[], features: number[], selectors: Array<(sample: MatureSample) => number>): number | undefined;
function leaveOneOutBuffer(samples: MatureSample[], selectors: Array<(sample: MatureSample) => number>): number;
```

Use 21 grid values including endpoints. `robustScale = max(P75-P25, (max-min)/4, 0.01)`. Weight a sample by `exp(-0.5 * squaredStandardizedDistance)` and fall back to the nearest sample if total weight is below `1e-12`. The leave-one-out buffer is the 80th percentile absolute relative error clamped to `[0,0.5]`; conservative prediction is `prediction * (1-buffer)`.

- [ ] **Step 6: Implement monotone searches and selection**

D1 grids ROI1 × next-day retention. D7 fixes selected D1 values and grids ROI7 × D7 retention. Iterate each surface from low to high and replace every cell with the maximum of itself and immediate lower-axis neighbors to create a positive monotone envelope.

For each ROI grid value, the boundary keeps the lowest retention that reaches the target. Select a feasible cell minimizing:

```ts
2 * normalizedDistance(candidateRoi, initialRoiStandard)
+ normalizedDistance(candidateRetention, medianRetentionOfTargetAchievers)
```

If no historical sample reaches target, use all-sample median retention. Never select outside grid endpoints.

- [ ] **Step 7: Run tests and verify pass**

Run: `pnpm exec vitest run src/forecast/assessmentStandards.test.ts`

Expected: all engine cases PASS.

- [ ] **Step 8: Commit**

```bash
git add src/forecast/assessmentStandards.ts src/forecast/assessmentStandards.test.ts
git commit -m "feat: derive retention assessment standards"
```

### Task 3: Assessment Standards Page

**Files:**
- Create: `src/components/AssessmentStandards.tsx`
- Create: `src/components/AssessmentStandards.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `packages`, `onNavigateToFit`, and `invertAssessmentStandards`.
- Produces: default `AssessmentStandards` React component.

- [ ] **Step 1: Write failing empty/input/unsupported tests**

Assert empty packages show “请先在“预估曲线拟合”中保存模型包。”. With a package, assert labels “选择模型包”“目标累计 ROI”“目标周期（天）” and defaults 1.37/360. LTV mode shows “当前模型包为 LTV + CAC，暂不支持考核标准反推。” and disables the action.

- [ ] **Step 2: Write failing result tests**

Mock the engine. ROI results show ROI1/ROI7 and two “无法反推” cards. Retention results show all four values, confidence, conservative target ROI, sample/model counts, warnings, and accessible D1/D7 boundary tables. Changing package or target after a run shows “反推结果已过期，请重新反推”.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm exec vitest run src/components/AssessmentStandards.test.tsx`

Expected: FAIL because component is absent.

- [ ] **Step 4: Implement inputs and stale state**

Use string state for target ROI/day, selected ID state, and a JSON signature of all three. Infer mode from `selected.sourceSnapshots[0]?.mode`. Validate ROI `>0` and integer day D7–D360. Disable invalid or LTV runs.

- [ ] **Step 5: Implement results**

Render cards in order ROI1、ROI7累计 ROI、次留率、7留率. ROI uses 3 decimals; retention uses one-decimal percentages. Show range and conservative adjustment. ROI-only retention cards use the approved copy. Boundary tables use columns “ROI标准”“最低留存率”“目标日ROI保守下界”.

- [ ] **Step 6: Add responsive styles**

Add `.assessment-standards`, `.assessment-controls`, `.assessment-standard-grid`, `.assessment-standard-card`, `.assessment-boundaries`, and `.assessment-status` using existing tokens. Use 4/2/1 columns above 900px, at 600–900px, and below 600px.

- [ ] **Step 7: Run tests and verify pass**

Run: `pnpm exec vitest run src/components/AssessmentStandards.test.tsx`

Expected: page tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/AssessmentStandards.tsx src/components/AssessmentStandards.test.tsx src/styles.css
git commit -m "feat: add assessment standard inversion page"
```

### Task 4: Navigation Integration and Full Verification

**Files:**
- Modify: `src/components/Header.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/NavigationAndSavedCurves.test.tsx`

**Interfaces:**
- Consumes: Task 3 default component.
- Produces: `AppPage = "fit" | "estimate" | "standards"` and third navigation button.

- [ ] **Step 1: Write failing navigation test**

```ts
expect(within(screen.getByRole("navigation", { name: "主导航" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
  "预估曲线拟合", "ROI 预估", "考核标准反推",
]);
fireEvent.click(screen.getByRole("button", { name: "考核标准反推" }));
expect(screen.getByRole("heading", { name: "考核标准反推", level: 1 })).toBeInTheDocument();
```

- [ ] **Step 2: Run test and verify failure**

Run: `pnpm exec vitest run src/components/NavigationAndSavedCurves.test.tsx`

Expected: third route assertion FAILS.

- [ ] **Step 3: Add route and navigation**

Export `AppPage` from `Header.tsx`, add the third button, type App state with it, import `AssessmentStandards`, and render it with current packages plus the fit-navigation callback.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run src/forecast/assessmentStandards.test.ts src/components/AssessmentStandards.test.tsx src/components/NavigationAndSavedCurves.test.tsx`

Expected: all focused tests PASS.

- [ ] **Step 5: Run full verification**

```bash
pnpm exec vitest run
pnpm run build
git diff --check
```

Expected: zero test failures, TypeScript/Vite exit 0, and no whitespace errors. The existing Vite large-chunk warning is non-blocking.

- [ ] **Step 6: Commit**

```bash
git add src/components/Header.tsx src/App.tsx src/components/NavigationAndSavedCurves.test.tsx
git commit -m "feat: integrate assessment standard inversion"
```
