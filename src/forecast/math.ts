export interface LinearRegressionResult {
  intercept: number;
  slope: number;
}

export interface BoundedSearchResult {
  x: number;
  value: number;
}

export interface BoundedSearchOptions {
  gridSize?: number;
  iterations?: number;
  tolerance?: number;
}

const isFiniteArray = (values: number[]): boolean => values.every(Number.isFinite);

/** Fits y = intercept + slope * x, returning null for unusable or singular input. */
export function linearLeastSquares(xs: number[], ys: number[]): LinearRegressionResult | null {
  if (xs.length !== ys.length || xs.length < 2 || !isFiniteArray(xs) || !isFiniteArray(ys)) return null;

  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  if (!Number.isFinite(meanX) || !Number.isFinite(meanY)) return null;

  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const centeredX = (xs[index] ?? 0) - meanX;
    covariance += centeredX * ((ys[index] ?? 0) - meanY);
    variance += centeredX * centeredX;
  }

  const varianceScale = Math.max(1, ...xs.map((value) => Math.abs(value))) ** 2 * xs.length;
  if (!Number.isFinite(variance) || variance <= Number.EPSILON * varianceScale) return null;

  const slope = covariance / variance;
  const intercept = meanY - slope * meanX;
  return Number.isFinite(slope) && Number.isFinite(intercept) ? { intercept, slope } : null;
}

/** Uses linear interpolation between adjacent order statistics (R-7 quantiles). */
export function quantile(values: number[], probability: number): number | null {
  if (
    values.length === 0 ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1 ||
    !isFiniteArray(values)
  ) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  if (lowerIndex === upperIndex) return lower;

  const upperWeight = position - lowerIndex;
  const interpolated =
    Math.sign(lower) === Math.sign(upper)
      ? lower + (upper - lower) * upperWeight
      : lower * (1 - upperWeight) + upper * upperWeight;
  return Number.isFinite(interpolated) ? interpolated : null;
}

export function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

/** Returns the first ordered value whose cumulative positive weight reaches half the total. */
export function weightedMedian(values: number[], weights: number[]): number | null {
  if (
    values.length === 0 ||
    values.length !== weights.length ||
    !isFiniteArray(values) ||
    !isFiniteArray(weights) ||
    weights.some((weight) => weight < 0)
  ) {
    return null;
  }

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return null;

  const ordered = values
    .map((value, index) => ({ value, weight: weights[index] ?? 0 }))
    .sort((left, right) => left.value - right.value);
  let cumulativeWeight = 0;
  for (const entry of ordered) {
    cumulativeWeight += entry.weight;
    if (cumulativeWeight >= totalWeight / 2) return entry.value;
  }
  return null;
}

/**
 * Minimizes a scalar objective over finite bounds. A coarse scan first locates a
 * finite basin, then golden-section refinement avoids relying on derivatives.
 */
export function boundedOneDimensionalSearch(
  objective: (value: number) => number,
  lowerBound: number,
  upperBound: number,
  options: BoundedSearchOptions = {},
): BoundedSearchResult | null {
  if (!Number.isFinite(lowerBound) || !Number.isFinite(upperBound) || lowerBound >= upperBound) return null;

  const gridSize = options.gridSize ?? 128;
  const iterations = options.iterations ?? 100;
  const tolerance = options.tolerance ?? 1e-10;
  if (!Number.isInteger(gridSize) || gridSize < 2 || !Number.isInteger(iterations) || iterations < 1) return null;
  if (!Number.isFinite(tolerance) || tolerance <= 0) return null;

  const evaluate = (value: number): number => {
    try {
      const result = objective(value);
      return Number.isFinite(result) ? result : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const step = (upperBound - lowerBound) / gridSize;
  let bestIndex = -1;
  let best: BoundedSearchResult | null = null;
  for (let index = 0; index <= gridSize; index += 1) {
    const x = lowerBound + index * step;
    const value = evaluate(x);
    if (!best || value < best.value) {
      best = Number.isFinite(value) ? { x, value } : best;
      if (Number.isFinite(value)) bestIndex = index;
    }
  }
  if (!best || bestIndex < 0) return null;

  let left = lowerBound + Math.max(0, bestIndex - 1) * step;
  let right = lowerBound + Math.min(gridSize, bestIndex + 1) * step;
  const inversePhi = (Math.sqrt(5) - 1) / 2;
  let leftInterior = right - inversePhi * (right - left);
  let rightInterior = left + inversePhi * (right - left);
  let leftValue = evaluate(leftInterior);
  let rightValue = evaluate(rightInterior);

  for (let iteration = 0; iteration < iterations && right - left > tolerance; iteration += 1) {
    if (leftValue <= rightValue) {
      right = rightInterior;
      rightInterior = leftInterior;
      rightValue = leftValue;
      leftInterior = right - inversePhi * (right - left);
      leftValue = evaluate(leftInterior);
    } else {
      left = leftInterior;
      leftInterior = rightInterior;
      leftValue = rightValue;
      rightInterior = left + inversePhi * (right - left);
      rightValue = evaluate(rightInterior);
    }
  }

  for (const candidate of [
    { x: leftInterior, value: leftValue },
    { x: rightInterior, value: rightValue },
    { x: (left + right) / 2, value: evaluate((left + right) / 2) },
  ]) {
    if (Number.isFinite(candidate.value) && candidate.value < best.value) best = candidate;
  }

  return best;
}
