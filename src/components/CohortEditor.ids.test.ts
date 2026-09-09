import { expect, it } from "vitest";
import { createEmptyCohortDraft } from "./CohortEditor";

it("allocates a cohort ID that cannot collide with IDs restored after reload", () => {
  const draft = createEmptyCohortDraft(2, new Set(["cohort-1"]));

  expect(draft.id).toBe("cohort-2");
  const allObservationIds = [
    ...draft.observations.roi.map(({ id }) => id),
    ...draft.observations.roi_retention.map(({ id }) => id),
    ...draft.observations.ltv_cac.map(({ id }) => id),
  ];
  expect(new Set(allObservationIds).size).toBe(allObservationIds.length);
});
