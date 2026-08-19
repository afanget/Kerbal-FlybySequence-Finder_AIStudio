/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PorkchopPlotData, SequencePorkchopData, DirectionalLink, CelestialBody } from '../types';
import { vecSub, vecMag, getGravitationalParameter, getBodyStateAtUT, Vector3D } from '../physics/kepler';
import { evaluateFlybyAtDate, getMinFlybyAlt, evaluateSequenceTransferFromDirectPorkchops } from '../physics/flyby';

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
  bodies?: CelestialBody[],
  mainBody?: CelestialBody
): FlybyDebugPlotData | null {
  const bodyNames = seqPorkchop.bodyNames && seqPorkchop.bodyNames.length >= 3
    ? seqPorkchop.bodyNames
    : [seqPorkchop.sourceBody, seqPorkchop.flybyBody || 'Flyby', seqPorkchop.targetBody];

  const bodyA = bodyNames[0] || seqPorkchop.sourceBody;
  const bodyB = bodyNames[1] || seqPorkchop.flybyBody || '';
  const bodyC = bodyNames[bodyNames.length - 1] || seqPorkchop.targetBody;

  const maxDepIndex = Math.max(0, seqPorkchop.depDates.length - 1);
  const maxArrIndex = Math.max(0, seqPorkchop.arrDates.length - 1);

  const clampedDepIndex = Math.max(0, Math.min(maxDepIndex, clickDepIndex));
  const clampedArrIndex = Math.max(0, Math.min(maxArrIndex, clickArrIndex));

  const depDateA = seqPorkchop.depDates[clampedDepIndex];
  const arrDateC = seqPorkchop.arrDates[clampedArrIndex];

  if (depDateA === undefined || arrDateC === undefined) {
    return null;
  }

  // Find direct porkchops for Link 1 (A -> B) and Link 2 (B -> C)
  const allPcs = Object.values(porkchops);

  const pc1 = allPcs.find(p => p.sourceBody === bodyA && p.targetBody === bodyB);
  const pc2 = allPcs.find(p => p.sourceBody === bodyB && p.targetBody === bodyC);

  if (!pc1 || !pc2) {
    return null;
  }

  const i1 = findClosestIndex(pc1.depDates, depDateA);
  const l2 = findClosestIndex(pc2.arrDates, arrDateC);

  // Chosen flyby date from sequence porkchop matrix if available
  const chosenFlybyDateB = seqPorkchop.flybyDateMatrix?.[clampedDepIndex]?.[clampedArrIndex] || undefined;

  // Collect flyby dates range (union of pc1.arrDates and pc2.depDates)
  const flybyDatesSet = new Set<number>([...pc1.arrDates, ...pc2.depDates]);
  const sortedFlybyDates = Array.from(flybyDatesSet).sort((a, b) => a - b);

  // Physical body properties for flyby deflection calculations
  const flybyBodyObj = bodies?.find(b => b.name === bodyB);
  const centralBodyObj = mainBody || bodies?.find(b => b.name === 'Sun' || b.name === 'Kerbol') || bodies?.[0];

  const muFlyby = flybyBodyObj ? getGravitationalParameter(flybyBodyObj) : 3.5316e12; // Kerbin default if undefined
  const flybyRadius = flybyBodyObj?.radius || 600000;
  const minFlybyAlt = flybyBodyObj ? getMinFlybyAlt(flybyBodyObj) : 10000;
  const rpMin = flybyRadius + minFlybyAlt;

  let minC3 = Infinity;
  let maxC3 = -Infinity;
  let minFeasibleC3 = Infinity;
  let maxFeasibleC3 = -Infinity;

  let minDeflectionDeg = Infinity;
  let maxDeflectionDeg = -Infinity;

  const points: FlybyDebugPoint[] = sortedFlybyDates.map(flybyDate => {
    const j1 = findClosestIndex(pc1.arrDates, flybyDate);
    const k2 = findClosestIndex(pc2.depDates, flybyDate);

    let c3ArrB: number | null = null;
    let isValidArr = false;
    let vTransArr: Vector3D | undefined = undefined;

    if (pc1.c3ArrMatrix?.[i1]?.[j1] !== undefined) {
      const val = pc1.c3ArrMatrix[i1][j1];
      if (Number.isFinite(val) && !Number.isNaN(val)) {
        c3ArrB = val;
        const valid1 = pc1.constraintValidMatrix || pc1.physicalValidMatrix;
        isValidArr = valid1 ? !!valid1[i1]?.[j1] : true;
        minC3 = Math.min(minC3, c3ArrB);
        maxC3 = Math.max(maxC3, c3ArrB);

        if (isValidArr || c3ArrB < 250) {
          minFeasibleC3 = Math.min(minFeasibleC3, c3ArrB);
          maxFeasibleC3 = Math.max(maxFeasibleC3, c3ArrB);
        }
      }
    }
    if (pc1.vTransArrMatrix?.[i1]?.[j1]) {
      vTransArr = pc1.vTransArrMatrix[i1][j1];
    }

    let c3DepB: number | null = null;
    let isValidDep = false;
    let vTransDep: Vector3D | undefined = undefined;

    if (pc2.c3DepMatrix?.[k2]?.[l2] !== undefined) {
      const val = pc2.c3DepMatrix[k2][l2];
      if (Number.isFinite(val) && !Number.isNaN(val)) {
        c3DepB = val;
        const valid2 = pc2.constraintValidMatrix || pc2.physicalValidMatrix;
        isValidDep = valid2 ? !!valid2[k2]?.[l2] : true;
        minC3 = Math.min(minC3, c3DepB);
        maxC3 = Math.max(maxC3, c3DepB);

        if (isValidDep || c3DepB < 250) {
          minFeasibleC3 = Math.min(minFeasibleC3, c3DepB);
          maxFeasibleC3 = Math.max(maxFeasibleC3, c3DepB);
        }
      }
    }
    if (pc2.vTransDepMatrix?.[k2]?.[l2]) {
      vTransDep = pc2.vTransDepMatrix[k2][l2];
    }

    // Compute deflection angles and required flyby delta-V via evaluateFlybyAtDate
    let deflectionAngleDeg: number | null = null;
    let maxDeflectionAngleDeg: number | null = null;
    let flybyDvMps: number | null = null;

    if (flybyBodyObj && centralBodyObj) {
      const stB = getBodyStateAtUT(flybyBodyObj, centralBodyObj, flybyDate);
      const vBody = stB.vel;

      const hasVArr = vTransArr && (vTransArr.x !== 0 || vTransArr.y !== 0 || vTransArr.z !== 0);
      const hasVDep = vTransDep && (vTransDep.x !== 0 || vTransDep.y !== 0 || vTransDep.z !== 0);

      if (hasVArr && hasVDep && vTransArr && vTransDep) {
        const vInfInVec = vecSub(vTransArr, vBody);
        const vInfOutVec = vecSub(vTransDep, vBody);

        if (vecMag(vInfInVec) > 1e-3 && vecMag(vInfOutVec) > 1e-3) {
          const evalRes = evaluateFlybyAtDate(flybyBodyObj, vInfInVec, vInfOutVec, flybyDate);
          deflectionAngleDeg = evalRes.deflectionAngleDeg;
          maxDeflectionAngleDeg = evalRes.maxDeflectionAngleDeg;
          flybyDvMps = evalRes.poweredDv;
        }
      }
    }

    if (deflectionAngleDeg !== null && Number.isFinite(deflectionAngleDeg)) {
      minDeflectionDeg = Math.min(minDeflectionDeg, deflectionAngleDeg);
      maxDeflectionDeg = Math.max(maxDeflectionDeg, deflectionAngleDeg);
    }
    if (maxDeflectionAngleDeg !== null && Number.isFinite(maxDeflectionAngleDeg)) {
      minDeflectionDeg = Math.min(minDeflectionDeg, maxDeflectionAngleDeg);
      maxDeflectionDeg = Math.max(maxDeflectionDeg, maxDeflectionAngleDeg);
    }

    return {
      flybyDate,
      c3ArrB,
      c3DepB,
      isValidArr,
      isValidDep,
      deflectionAngleDeg,
      maxDeflectionAngleDeg,
      flybyDvMps,
    };
  });

  if (!Number.isFinite(minC3)) minC3 = 0;
  if (!Number.isFinite(maxC3)) maxC3 = 100;

  if (!Number.isFinite(minFeasibleC3)) minFeasibleC3 = minC3;
  if (!Number.isFinite(maxFeasibleC3)) maxFeasibleC3 = Math.min(maxC3, minFeasibleC3 + 100);

  if (!Number.isFinite(minDeflectionDeg)) minDeflectionDeg = 0;
  if (!Number.isFinite(maxDeflectionDeg)) maxDeflectionDeg = 180;

  // Find minimum Delta-v point along the debug plot curve
  let bestPointOnCurve: FlybyDebugPoint | null = null;
  let minDvOnCurve = Infinity;
  for (const pt of points) {
    if (pt.flybyDvMps !== null && Number.isFinite(pt.flybyDvMps) && pt.flybyDvMps < minDvOnCurve) {
      minDvOnCurve = pt.flybyDvMps;
      bestPointOnCurve = pt;
    }
  }

  // If pathInsts are available, compute/verify the continuous optimal flyby date via evaluateSequenceTransferFromDirectPorkchops
  const pathInsts = seqPorkchop.pathInsts || seqPorkchop.pathInstances;
  const seqTransferEval = (pathInsts && pathInsts.length >= 3 && bodies && mainBody)
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
    ?? chosenFlybyDateB
    ?? seqPorkchop.flybyDates?.[0]?.dateMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedFlybyDv = seqTransferEval?.flybyDvs?.[0]
    ?? seqPorkchop.poweredDvBMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? seqPorkchop.totalPoweredDvMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedTotalDv = seqTransferEval?.totalDv
    ?? seqPorkchop.totalPoweredDvMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? storedFlybyDv;

  const storedC3DepA = seqTransferEval?.c3DepA
    ?? seqPorkchop.c3DepAMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedC3ArrC = seqTransferEval?.c3ArrFinal
    ?? seqPorkchop.c3ArrFinalMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? seqPorkchop.c3ArrCMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const storedIsValid = seqTransferEval !== null
    ? (seqTransferEval.totalDv < 1e6)
    : seqPorkchop.constraintValidMatrix?.[clampedDepIndex]?.[clampedArrIndex];

  const optimalFlybyDate = storedFlybyDate && Number.isFinite(storedFlybyDate)
    ? storedFlybyDate
    : (bestPointOnCurve?.flybyDate ?? (depDateA + arrDateC) / 2);

  const j1Opt = findClosestIndex(pc1.arrDates, optimalFlybyDate);
  const k2Opt = findClosestIndex(pc2.depDates, optimalFlybyDate);

  const c3DepA = (storedC3DepA !== undefined && Number.isFinite(storedC3DepA))
    ? storedC3DepA
    : (pc1.c3DepMatrix?.[i1]?.[j1Opt] ?? 0);

  const c3ArrC = (storedC3ArrC !== undefined && Number.isFinite(storedC3ArrC))
    ? storedC3ArrC
    : (pc2.c3ArrMatrix?.[k2Opt]?.[l2] ?? 0);

  const c3ArrB = seqTransferEval?.c3ArrB
    ?? seqPorkchop.c3ArrBMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? pc1.c3ArrMatrix?.[i1]?.[j1Opt];

  const c3DepB = seqTransferEval?.c3DepB
    ?? seqPorkchop.c3DepBMatrix?.[clampedDepIndex]?.[clampedArrIndex]
    ?? pc2.c3DepMatrix?.[k2Opt]?.[l2];

  const flybyDvMps = (storedFlybyDv !== undefined && Number.isFinite(storedFlybyDv))
    ? storedFlybyDv
    : (bestPointOnCurve?.flybyDvMps ?? (minDvOnCurve < 1e6 ? minDvOnCurve : 0));

  const totalDv = (storedTotalDv !== undefined && Number.isFinite(storedTotalDv))
    ? storedTotalDv
    : flybyDvMps;

  const isValid = storedIsValid !== undefined
    ? storedIsValid
    : (totalDv < 1e6 && points.some(p => p.isValidArr && p.isValidDep));

  const hasFeasible = isValid && totalDv < 1e6;

  const optimalSample: FlybyOptimalSample = {
    flybyDate: optimalFlybyDate,
    c3DepA,
    c3ArrB,
    c3DepB,
    c3ArrC,
    deflectionAngleDeg: bestPointOnCurve?.deflectionAngleDeg ?? undefined,
    maxDeflectionAngleDeg: bestPointOnCurve?.maxDeflectionAngleDeg ?? undefined,
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
