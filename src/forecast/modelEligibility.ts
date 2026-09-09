import type { ModelResult } from "../domain/types";

export function participatesInEqualWeightEnsemble(model: ModelResult, retentionMode: boolean): boolean {
  if (model.status !== "ok") return false;
  return !retentionMode || model.parameters?.qualified === 1;
}

export function equalWeightModelIds(models: ModelResult[], retentionMode: boolean): ModelResult["id"][] {
  return models.filter((model) => participatesInEqualWeightEnsemble(model, retentionMode)).map((model) => model.id);
}
