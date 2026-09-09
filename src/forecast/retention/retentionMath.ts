import type { ForecastPoint, RoiObservation } from "../../domain/types";

const LOGIT_EPSILON = 1e-4;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function safeLogit(retention: number): number {
  const safe = clamp(retention, LOGIT_EPSILON, 1 - LOGIT_EPSILON);
  return Math.log(safe / (1 - safe));
}

export function inverseLogit(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

export function validRetentionObservations(observations: RoiObservation[]): Array<RoiObservation & { retention: number }> {
  return observations.filter((point): point is RoiObservation & { retention: number } => (
    point.retention !== undefined && Number.isFinite(point.retention) && point.retention >= 0 && point.retention <= 1
  )).sort((left, right) => left.day - right.day);
}

export function retentionAtDay(observations: RoiObservation[], day: number): number {
  const points = validRetentionObservations(observations);
  if (!points.length) return 0.5;
  if (points.length === 1) return points[0]!.retention;
  const exact = points.find((point) => point.day === day);
  if (exact) return exact.retention;
  if (day <= points[0]!.day) return points[0]!.retention;
  if (day >= points[points.length - 1]!.day) return points[points.length - 1]!.retention;
  const x = Math.log(Math.max(1, day));
  let left = points[0]!;
  let right = points[1]!;
  if (day > points[0]!.day) {
    const rightIndex = points.findIndex((point) => point.day > day);
    left = points[Math.max(0, rightIndex - 1)]!;
    right = points[rightIndex]!;
  }
  const leftX = Math.log(Math.max(1, left.day));
  const rightX = Math.log(Math.max(1, right.day));
  const progress = rightX === leftX ? 0 : (x - leftX) / (rightX - leftX);
  const logit = safeLogit(left.retention) + progress * (safeLogit(right.retention) - safeLogit(left.retention));
  return clamp(inverseLogit(logit), 0, 1);
}

function solve(matrix: number[][], vector: number[]): number[] | undefined {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index] ?? 0]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-12) return undefined;
    for (let entry = column; entry <= size; entry += 1) augmented[column]![entry] = augmented[column]![entry]! / divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let entry = column; entry <= size; entry += 1) augmented[row]![entry] = augmented[row]![entry]! - factor * augmented[column]![entry]!;
    }
  }
  const result = augmented.map((row) => row[size]!);
  return result.every(Number.isFinite) ? result : undefined;
}

export function ridgeRegression(features: number[][], targets: number[], lambda = 1e-4): number[] | undefined {
  if (!features.length || features.length !== targets.length) return undefined;
  const width = features[0]?.length ?? 0;
  if (!width || features.some((row) => row.length !== width || row.some((value) => !Number.isFinite(value))) || targets.some((value) => !Number.isFinite(value))) return undefined;
  const matrix = Array.from({ length: width }, () => Array.from({ length: width }, () => 0));
  const vector = Array.from({ length: width }, () => 0);
  for (let row = 0; row < features.length; row += 1) for (let left = 0; left < width; left += 1) {
    vector[left] = vector[left]! + features[row]![left]! * targets[row]!;
    for (let right = 0; right < width; right += 1) matrix[left]![right] = matrix[left]![right]! + features[row]![left]! * features[row]![right]!;
  }
  for (let index = 0; index < width; index += 1) matrix[index]![index] = matrix[index]![index]! + (index === 0 ? lambda * 0.01 : lambda);
  return solve(matrix, vector);
}

export function predictLinear(coefficients: number[], features: number[]): number {
  return coefficients.reduce((sum, coefficient, index) => sum + coefficient * (features[index] ?? 0), 0);
}

function rawValue(raw: ForecastPoint[], day: number): number {
  return raw[day - 1]?.value ?? raw[raw.length - 1]?.value ?? 0;
}

export function anchorMonotoneCurve(raw: ForecastPoint[], observations: RoiObservation[]): ForecastPoint[] {
  if (!raw.length) return [];
  const anchors = observations.filter((point) => Number.isInteger(point.day) && point.day >= 1 && point.day <= 360 && Number.isFinite(point.value) && point.value >= 0)
    .sort((left, right) => left.day - right.day);
  if (!anchors.length) {
    let floor = 0;
    return Array.from({ length: 360 }, (_, index) => {
      floor = Math.max(floor, Number.isFinite(rawValue(raw, index + 1)) ? rawValue(raw, index + 1) : floor);
      return { day: index + 1, value: floor };
    });
  }
  const result: ForecastPoint[] = [];
  for (let day = 1; day <= 360; day += 1) {
    const exact = anchors.find((point) => point.day === day);
    if (exact) { result.push({ day, value: exact.value }); continue; }
    const rightIndex = anchors.findIndex((point) => point.day > day);
    const left = rightIndex < 0 ? anchors[anchors.length - 1]! : rightIndex > 0 ? anchors[rightIndex - 1]! : { day: 0, value: 0 };
    const right = rightIndex >= 0 ? anchors[rightIndex]! : undefined;
    if (!right) {
      const rawLeft = rawValue(raw, left.day);
      const rawTerminal = rawValue(raw, 360);
      const denominator = rawTerminal - rawLeft;
      const progress = denominator > 1e-12 ? clamp((rawValue(raw, day) - rawLeft) / denominator, 0, 1) : (day - left.day) / (360 - left.day);
      result.push({ day, value: left.value + Math.max(0, rawTerminal - left.value) * progress });
      continue;
    }
    const rawLeft = left.day === 0 ? 0 : rawValue(raw, left.day);
    const rawRight = rawValue(raw, right.day);
    const denominator = rawRight - rawLeft;
    const timeProgress = (day - left.day) / (right.day - left.day);
    const rawProgress = denominator > 1e-12 ? (rawValue(raw, day) - rawLeft) / denominator : timeProgress;
    const progress = clamp(Number.isFinite(rawProgress) ? rawProgress : timeProgress, 0, 1);
    result.push({ day, value: left.value + (right.value - left.value) * progress });
  }
  let floor = 0;
  return result.map((point) => {
    floor = Math.max(floor, Number.isFinite(point.value) ? point.value : floor);
    return { day: point.day, value: floor };
  });
}
