export interface TargetSummary {
  roi360?: number;
  targetGap?: number;
  targetGapRatio?: number;
  reachesTarget: boolean;
  targetDay?: number;
}

export interface TargetPoint {
  day: number;
  value: number;
}

const MAX_FORECAST_DAY = 360;

function validHorizon(maxDay: number): number | undefined {
  if (!Number.isInteger(maxDay) || maxDay <= 0) return undefined;
  return Math.min(maxDay, MAX_FORECAST_DAY);
}

/**
 * Copies points at or before the requested horizon. Points after the horizon
 * are deliberately ignored before their value is considered.
 */
function safePoints(points: TargetPoint[], maxDay: number): TargetPoint[] | undefined {
  const result: TargetPoint[] = [];
  const seenDays = new Set<number>();

  for (const point of points) {
    if (!point || typeof point.day !== "number") return undefined;
    if (point.day > maxDay) continue;
    if (
      !Number.isInteger(point.day) ||
      point.day <= 0 ||
      !Number.isFinite(point.value) ||
      seenDays.has(point.day)
    ) {
      return undefined;
    }
    seenDays.add(point.day);
    result.push({ day: point.day, value: point.value });
  }

  return result.sort((left, right) => left.day - right.day);
}

function targetDayFromPoints(points: TargetPoint[], target: number): number | undefined {
  let previous: TargetPoint | undefined;
  for (const point of points) {
    if (point.value < target) {
      previous = point;
      continue;
    }
    if (!previous) return point.day;
    if (point.value === target) return point.day;

    const proportion = (target - previous.value) / (point.value - previous.value);
    const crossing = previous.day + proportion * (point.day - previous.day);
    return Number.isFinite(crossing) ? Math.ceil(crossing) : undefined;
  }
  return undefined;
}

/** Finds the first whole day on which the linearly interpolated curve reaches a target. */
export function findTargetDay(
  points: TargetPoint[],
  target: number,
  maxDay = MAX_FORECAST_DAY,
): number | undefined {
  if (!Number.isFinite(target) || target <= 0) return undefined;
  const horizon = validHorizon(maxDay);
  if (horizon === undefined || !Array.isArray(points)) return undefined;

  const usablePoints = safePoints(points, horizon);
  return usablePoints ? targetDayFromPoints(usablePoints, target) : undefined;
}

/** Summarizes the D360 outcome, using only forecast points at or before D360. */
export function summarizeTarget(
  points: TargetPoint[],
  target: number,
  observations: TargetPoint[] = [],
): TargetSummary {
  if (!Number.isFinite(target) || target <= 0 || !Array.isArray(points)) {
    return { reachesTarget: false };
  }

  const usablePoints = safePoints(points, MAX_FORECAST_DAY);
  if (!usablePoints) return { reachesTarget: false };

  const roi360 = usablePoints.find((point) => point.day === MAX_FORECAST_DAY)?.value;
  if (roi360 === undefined) return { reachesTarget: false };

  const targetGap = roi360 - target;
  const usableObservations = safePoints(observations, MAX_FORECAST_DAY);
  const latestObserved = usableObservations?.[usableObservations.length - 1];
  if (latestObserved && roi360 < latestObserved.value) return { reachesTarget: false };
  const observedTargetDay = usableObservations ? targetDayFromPoints(usableObservations, target) : undefined;
  const reachesTarget = observedTargetDay !== undefined || roi360 >= target;
  const targetDay = reachesTarget
    ? observedTargetDay ?? targetDayFromPoints(usablePoints, target)
    : undefined;
  return {
    roi360,
    targetGap,
    targetGapRatio: targetGap / target,
    reachesTarget,
    ...(targetDay === undefined ? {} : { targetDay }),
  };
}
