import { describe, expect, it } from "vitest";
import type { Cohort } from "../domain/types";
import {
  clearProject,
  loadProject,
  PROJECT_STORAGE_KEY,
  saveProject,
  type StorageAdapter,
  type StoredCohortDraftV3,
} from "./storage";

function createStorage(initial: Record<string, string> = {}): StorageAdapter & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

const cohort: Cohort = {
  id: "a",
  name: "A",
  mode: "roi",
  spend: 100,
  observations: [{ day: 1, value: 0.1 }, { day: 7, value: 0.2 }],
};

const uiDraft: StoredCohortDraftV3 = {
  id: "a",
  name: "A",
  mode: "roi",
  spend: "100",
  retention: { nextDay: "", day7: "" },
  observations: {
    roi: [{ id: "roi-1", day: "1", value: "10%", cac: "" }],
    roi_retention: [{ id: "roi-retention-1", day: "1", value: "10%", cac: "" }],
    ltv_cac: [{ id: "ltv-1", day: "", value: "", cac: "" }],
  },
};

describe("versioned fit-project storage", () => {
  it("persists ROI + retention cohorts and their editable retention fields", () => {
    const storage = createStorage();
    const retentionCohort: Cohort = {
      id: "retention-a", name: "留存投放 A", mode: "roi_retention",
      retention: { nextDay: 0.28, day7: 0.16 },
      observations: [{ day: 1, value: 0.1 }, { day: 7, value: 0.3 }],
    };
    const retentionDraft: StoredCohortDraftV3 = {
      ...uiDraft,
      id: "retention-a", name: "留存投放 A", mode: "roi_retention",
      retention: { nextDay: "28%", day7: "0.16" },
      observations: { ...uiDraft.observations, roi_retention: [{ ...uiDraft.observations.roi[0]!, id: "roi-retention-1" }] },
    };

    saveProject({ cohorts: [retentionCohort], uiDrafts: [retentionDraft] }, storage);

    expect(loadProject(storage)).toMatchObject({ status: "ok", project: {
      cohorts: [{ observations: [{ day: 1, value: 0.1, retention: 0.28 }, { day: 7, value: 0.3, retention: 0.16 }] }],
      uiDrafts: [{ observations: { roi_retention: [{ retention: "28%" }] } }],
    } });
  });

  it("saves multiple V4 fit cohorts and drafts without an ROI target", () => {
    const storage = createStorage();
    saveProject({ cohorts: [cohort, { ...cohort, id: "b", name: "B" }], uiDrafts: [uiDraft, { ...uiDraft, id: "b", name: "B" }], demo: true }, storage);

    const raw = JSON.parse(storage.values.get(PROJECT_STORAGE_KEY) ?? "");
    expect(raw).toEqual({ version: 4, cohorts: [cohort, { ...cohort, id: "b", name: "B" }], uiDrafts: [uiDraft, { ...uiDraft, id: "b", name: "B" }], demo: true });
    expect(raw).not.toHaveProperty("target");
    expect(loadProject(storage)).toEqual({ status: "ok", project: raw });
  });

  it("persists an invalid in-progress draft without inventing a valid cohort", () => {
    const storage = createStorage();
    saveProject({ uiDrafts: [{ ...uiDraft, name: "" }] }, storage);

    expect(loadProject(storage)).toEqual({
      status: "ok",
      project: { version: 4, uiDrafts: [{ ...uiDraft, name: "" }] },
    });
  });

  it("migrates a V3 single cohort cache into one-element V4 arrays", () => {
    const raw = JSON.stringify({ version: 3, cohort, uiDraft, demo: true });

    expect(loadProject(createStorage({ [PROJECT_STORAGE_KEY]: raw }))).toEqual({
      status: "ok",
      migratedFromVersion: 3,
      project: { version: 4, cohorts: [cohort], uiDrafts: [uiDraft], demo: true },
    });
  });

  it.each([1, 2])("rejects legacy V%s projects without migration", (version) => {
    const raw = JSON.stringify({ version, cohort, uiDraft });
    expect(loadProject(createStorage({ [PROJECT_STORAGE_KEY]: raw }))).toEqual({ status: "version_mismatch", version, raw });
  });

  it("keeps malformed and unsupported data recoverable", () => {
    const corrupted = createStorage({ [PROJECT_STORAGE_KEY]: "{bad json" });
    expect(loadProject(corrupted)).toEqual({ status: "corrupted", raw: "{bad json" });
    expect(corrupted.values.get(PROJECT_STORAGE_KEY)).toBe("{bad json");

    const raw = JSON.stringify({ version: 5 });
    const future = createStorage({ [PROJECT_STORAGE_KEY]: raw });
    expect(loadProject(future)).toEqual({ status: "version_mismatch", version: 5, raw });
  });

  it("rejects duplicate observation IDs inside the stored draft", () => {
    const invalid = {
      version: 4,
      cohorts: [cohort],
      uiDrafts: [{
        ...uiDraft,
        observations: {
          roi: [
            { id: "same", day: "1", value: "0.1", cac: "" },
            { id: "same", day: "7", value: "0.2", cac: "" },
          ],
          ltv_cac: [],
        },
      }],
    };
    const raw = JSON.stringify(invalid);
    expect(loadProject(createStorage({ [PROJECT_STORAGE_KEY]: raw }))).toEqual({ status: "corrupted", raw });
  });

  it("reports blocked reads and only clears when explicitly invoked", () => {
    const unavailable: StorageAdapter = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(loadProject(unavailable)).toEqual({ status: "unavailable" });

    const storage = createStorage({ [PROJECT_STORAGE_KEY]: JSON.stringify({ version: 3, cohort, uiDraft }) });
    expect(clearProject(storage)).toBe(true);
    expect(storage.values.has(PROJECT_STORAGE_KEY)).toBe(false);
  });
});
