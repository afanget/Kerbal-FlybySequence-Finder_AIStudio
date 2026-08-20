/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PorkchopPlotData, SequencePorkchopData, DirectionalLink, CelestialBody, OrbitalBody } from '../types';
import { generateDirectPorkchopFlybySamples, evaluateSequenceTransferFromDirectPorkchops, MAX_ALLOWED_FLYBY_DV_MPS } from '../physics/flyby';
import { getMinFlybyRadius } from '../data/solarSystems';

export const DEFAULT_MIN_C3 = 0;
export const DEFAULT_MAX_C3 = 100;
export const DEFAULT_MAX_FEASIBLE_C3_SPAN = 100;
export const DEFAULT_MIN_DEFLECTION_DEG = 0;
export const DEFAULT_MAX_DEFLECTION_DEG = 180;
export const C3_HIGH_FEASIBLE_CUTOFF = 250;

export interface FlybyDebugPoint {
  flybyDate: number;
  c3ArrB: number | null; // Arrival C3 at Flyby Body (Link 1) in km^2/s^2
  c3DepB: number | null; // Departure C3 at Flyby Body (Link 2) in km^2/s^2
  isValidArr: boolean;
  isValidDep: boolean;
  deflectionAngleDeg: number | null; // Actual deflection angle in degrees
  maxDeflectionAngleDeg: number | null; // Maximum deflection angle for min(c3Arr, c3Dep) in degrees
  flybyDvMps: number | null; // Required flyby delta-V (m/s)
}

export interface FlybyOptimalSample {
  flybyDate: number;
  c3DepA: number;
  c3ArrB?: number;
  c3DepB?: number;
  c3ArrC: number;
  deflectionAngleDeg?: number;
  maxDeflectionAngleDeg?: number;
  flybyDvMps: number;
  totalDv: number;
  isValid: boolean;
}

export interface FlybyDebugPlotData {
  bodyA: string;
  bodyB: string;
  bodyC: string;
  clickDepIndex: number;
  clickArrIndex: number;
  maxDepIndex: number;
  maxArrIndex: number;
  depDateA: number;
  arrDateC: number;
  chosenFlybyDateB?: number;
  optimalFlybyDate: number;
  hasFeasible: boolean;
  optimalSample: FlybyOptimalSample;
  points: FlybyDebugPoint[];
  minC3: number;
  maxC3: number;
  minFeasibleC3: number;
  maxFeasibleC3: number;
  minDeflectionDeg: number;
  maxDeflectionDeg: number;
  muFlyby: number;
  rpMin: number;
}

/**
 * Finds index of nearest value in sorted array
 */
export function findClosestIndex(arr: number[], target: number): number {
  if (!arr || arr.length === 0) return 0;
  let low = 0;
  let high = arr.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  if (low >= arr.length) return arr.length - 1;
  if (high < 0) return 0;
  return Math.abs(arr[low] - target) < Math.abs(arr[high] - target) ? low : high;
}

/**
 * Extracts C3 and deflection angles at flyby body vs flyby date from direct porkchops for a clicked sample (t_dep_A, t_arr_C)
 */
export function extractFlybyDebugData(
  seqPorkchop: SequencePorkchopData,
  porkchops: Record<string, PorkchopPlotData>,
  links: DirectionalLink[],
  clickDepIndex: number,
  clickArrIndex: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody
): FlybyDebugPlotData | null {
  const pathInsts = [
    seqPorkchop.sourceBody,
    ...seqPorkchop.flybys.map(f => f.instance),
    seqPorkchop.targetBody,
  ];
  const bodyNames = pathInsts.map(i => i.bodyName);

  const bodyA = bodyNames[0];
  const bodyB = bodyNames[1];
  const bodyC = bodyNames[bodyNames.length - 1];

  const maxDepIndex = Math.max(0, seqPorkchop.depDates.length - 1);
  const maxArrIndex = Math.max(0, seqPorkchop.arrDates.length - 1);

  const clampedDepIndex = Math.max(0, Math.min(maxDepIndex, clickDepIndex));
  const clampedArrIndex = Math.max(0, Math.min(maxArrIndex, clickArrIndex));

  const depDateA = seqPorkchop.depDates[clampedDepIndex];
  const arrDateC = seqPorkchop.arrDates[clampedArrIndex];

  if (depDateA === undefined || arrDateC === undefined) {
    return null;
  }

  const flybyBodyObj = bodies.find(b => b.name === bodyB);
  if (!flybyBodyObj) return null;

  const muFlyby = flybyBodyObj.stdGravParam;
  const rpMin = getMinFlybyRadius(flybyBodyObj, undefined);

  // Generate discrete samples using the shared flyby generator
  const samples = generateDirectPorkchopFlybySamples(
    pathInsts,
    depDateA,
    arrDateC,
    bodies,
    mainBody,
    porkchops,
    links
  );

  let minC3 = Infinity;
  let maxC3 = -Infinity;
  let minFeasibleC3 = Infinity;
  let maxFeasibleC3 = -Infinity;
  let minDeflectionDeg = Infinity;
  let maxDeflectionDeg = -Infinity;

  const points: FlybyDebugPoint[] = (samples || []).map(s => {
    const c3ArrB = Number.isFinite(s.c3ArrB) ? s.c3ArrB : null;
    const c3DepB = Number.isFinite(s.c3DepB) ? s.c3DepB : null;
    const isValidArr = s.isPhysicallyValid !== false && c3ArrB !== null;
    const isValidDep = s.isPhysicallyValid !== false && c3DepB !== null;

    if (c3ArrB !== null) {
      minC3 = Math.min(minC3, c3ArrB);
      maxC3 = Math.max(maxC3, c3ArrB);
      if (isValidArr || c3ArrB < C3_HIGH_FEASIBLE_CUTOFF) {
        minFeasibleC3 = Math.min(minFeasibleC3, c3ArrB);
        maxFeasibleC3 = Math.max(maxFeasibleC3, c3ArrB);
      }
    }
    if (c3DepB !== null) {
      minC3 = Math.min(minC3, c3DepB);
      maxC3 = Math.max(maxC3, c3DepB);
      if (isValidDep || c3DepB < C3_HIGH_FEASIBLE_CUTOFF) {
        minFeasibleC3 = Math.min(minFeasibleC3, c3DepB);
        maxFeasibleC3 = Math.max(maxFeasibleC3, c3DepB);
      }
    }

    const deflectionAngleDeg = Number.isFinite(s.deflectionAngleDeg) ? s.deflectionAngleDeg : null;
    const maxDeflectionAngleDeg = Number.isFinite(s.maxDeflectionAngleDeg) ? s.maxDeflectionAngleDeg : null;
    const flybyDvMps = Number.isFinite(s.dv) ? s.dv : null;

    if (deflectionAngleDeg !== null) {
      minDeflectionDeg = Math.min(minDeflectionDeg, deflectionAngleDeg);
      maxDeflectionDeg = Math.max(maxDeflectionDeg, deflectionAngleDeg);
    }
    if (maxDeflectionAngleDeg !== null) {
      minDeflectionDeg = Math.min(minDeflectionDeg, maxDeflectionAngleDeg);
      maxDeflectionDeg = Math.max(maxDeflectionDeg, maxDeflectionAngleDeg);
    }

    return {
      flybyDate: s.tFlyby,
      c3ArrB,
      c3DepB,
      isValidArr,
      isValidDep,
      deflectionAngleDeg,
      maxDeflectionAngleDeg,
      flybyDvMps,
    };
  });

  if (!Number.isFinite(minC3)) minC3 = DEFAULT_MIN_C3;
  if (!Number.isFinite(maxC3)) maxC3 = DEFAULT_MAX_C3;
  if (!Number.isFinite(minFeasibleC3)) minFeasibleC3 = minC3;
  if (!Number.isFinite(maxFeasibleC3)) maxFeasibleC3 = Math.min(maxC3, minFeasibleC3 + DEFAULT_MAX_FEASIBLE_C3_SPAN);
  if (!Number.isFinite(minDeflectionDeg)) minDeflectionDeg = DEFAULT_MIN_DEFLECTION_DEG;
  if (!Number.isFinite(maxDeflectionDeg)) maxDeflectionDeg = DEFAULT_MAX_DEFLECTION_DEG;

  // Compute the continuous optimal flyby date via shared evaluateSequenceTransferFromDirectPorkchops
  const seqTransferEval = (pathInsts.length >= 3 && bodies && mainBody)
    ? evaluateSequenceTransferFromDirectPorkchops(
        pathInsts,
        depDateA,
        arrDateC,
        bodies,
        mainBody,
        porkchops,
        links
      )
    : null;

  const storedFlybyDate = seqTransferEval?.flybyDates?.[0]
    ?? seqPorkchop.flybys[0]?.dateMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedFlybyDv = seqTransferEval?.flybyDvs?.[0]
    ?? seqPorkchop.flybys[0]?.poweredDvMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? seqPorkchop.totalPoweredDvMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedTotalDv = seqTransferEval?.totalDv
    ?? seqPorkchop.totalPoweredDvMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? storedFlybyDv;

  const storedC3DepA = seqTransferEval?.c3DepA
    ?? seqPorkchop.c3DepMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedC3ArrC = seqTransferEval?.c3ArrFinal
    ?? seqPorkchop.c3ArrMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedIsValid = seqTransferEval !== null
    ? (seqTransferEval.isPhysicallyValid && seqTransferEval.totalDv < MAX_ALLOWED_FLYBY_DV_MPS)
    : seqPorkchop.constraintValidMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const optimalFlybyDate = storedFlybyDate && Number.isFinite(storedFlybyDate)
    ? storedFlybyDate
    : (depDateA + arrDateC) / 2;

  const c3DepA = storedC3DepA ?? 0;
  const c3ArrC = storedC3ArrC ?? 0;
  const c3ArrB = seqTransferEval?.c3ArrB ?? seqPorkchop.flybys[0]?.c3ArrMatrix?.[clampedDepIndex]?.[clampedArrIndex];
  const c3DepB = seqTransferEval?.c3DepB ?? seqPorkchop.flybys[0]?.c3DepMatrix?.[clampedDepIndex]?.[clampedArrIndex];
  const flybyDvMps = storedFlybyDv ?? 0;
  const totalDv = storedTotalDv ?? flybyDvMps;
  const hasFeasible = storedIsValid ?? (totalDv < MAX_ALLOWED_FLYBY_DV_MPS);

  const optimalSample: FlybyOptimalSample = {
    flybyDate: optimalFlybyDate,
    c3DepA,
    c3ArrB,
    c3DepB,
    c3ArrC,
    flybyDvMps,
    totalDv,
    isValid: hasFeasible,
  };

  return {
    bodyA,
    bodyB,
    bodyC,
    clickDepIndex: clampedDepIndex,
    clickArrIndex: clampedArrIndex,
    maxDepIndex,
    maxArrIndex,
    depDateA,
    arrDateC,
    chosenFlybyDateB: storedFlybyDate ?? optimalFlybyDate,
    optimalFlybyDate,
    hasFeasible,
    optimalSample,
    points,
    minC3,
    maxC3,
    minFeasibleC3,
    maxFeasibleC3,
    minDeflectionDeg,
    maxDeflectionDeg,
    muFlyby,
    rpMin,
  };
}
