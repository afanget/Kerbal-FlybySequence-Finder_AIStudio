/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CelestialBody,
  InstanceNode,
  DirectionalLink,
  PorkchopPlotData,
  SequencePorkchopData,
  LambertTransferResult,
  FlyableSequenceResult,
  FlybyDetail
} from '../types';
import { getBodyStateAtUT, getOrbitalPeriod, vecMag, vecDot, vecSub, Vector3D } from './kepler';
import { solveLambert, LambertSolution } from './lambert';
import { matchUnpoweredFlyby, evaluateFlybyAtDate, FlybyFeasibility } from './flyby';

const MIN_SAMPLE_COUNT = 20;
export const SAMPLE_PER_PERIOD = 64;
const MAX_SAMPLE_COUNT = 50000;

export interface SolverProgress {
  step: number;
  message: string;
  instances: InstanceNode[];
  links: DirectionalLink[];
  porkchops: Record<string, PorkchopPlotData>;
  validSequences: FlyableSequenceResult[];
  isComplete: boolean;
}

/**
 * STEP 1: Determine minimum and maximum dates for instances missing user constraints
 * Forward pass: instance[i+1].minDate >= instance[i].minDate + link.minDuration
 * Backward pass: instance[i].maxDate <= instance[i+1].maxDate - link.minDuration
 */
export function propagateDateBounds(
  instances: InstanceNode[],
  links: DirectionalLink[]
): InstanceNode[] {
  const updatedInstances = instances.map(inst => ({
    ...inst,
    computedMinDate: inst.minDate,
    computedMaxDate: inst.maxDate,
  }));

  const DEFAULT_START_DATE = 0; // Y1 D1
  const DEFAULT_MAX_WINDOW = 3600 * 24 * 365 * 30; // 30 years window default

  // Propagation pass (forward and backward)
  let changed = true;
  let passCount = 0;
  while (changed && passCount < instances.length * 4) {
    changed = false;
    passCount++;

    for (const link of links) {
      const src = updatedInstances.find(i => i.id === link.sourceInstanceId);
      const tgt = updatedInstances.find(i => i.id === link.targetInstanceId);
      if (!src || !tgt) continue;

      const minDur = link.minFlightDuration ?? 0;
      const maxDur = link.maxFlightDuration ?? 1e10;

      // Forward pass: tgt min date
      if (src.computedMinDate !== undefined) {
        const minArrival = src.computedMinDate + minDur;
        if (tgt.computedMinDate === undefined || minArrival > tgt.computedMinDate) {
          tgt.computedMinDate = minArrival;
          changed = true;
        }
      }

      // Forward pass: tgt max date
      if (src.computedMaxDate !== undefined) {
        const maxArrival = src.computedMaxDate + maxDur;
        if (tgt.computedMaxDate === undefined || maxArrival < tgt.computedMaxDate) {
          tgt.computedMaxDate = maxArrival;
          changed = true;
        }
      }

      // Backward pass: src max date
      if (tgt.computedMaxDate !== undefined) {
        const maxDeparture = tgt.computedMaxDate - minDur;
        if (src.computedMaxDate === undefined || maxDeparture < src.computedMaxDate) {
          src.computedMaxDate = maxDeparture;
          changed = true;
        }
      }

      // Backward pass: src min date
      if (tgt.computedMinDate !== undefined) {
        const minDeparture = tgt.computedMinDate - maxDur;
        if (src.computedMinDate === undefined || minDeparture > src.computedMinDate) {
          src.computedMinDate = minDeparture;
          changed = true;
        }
      }
    }
  }

  // Apply fallback defaults for any remaining unconstrained bounds
  updatedInstances.forEach(inst => {
    if (inst.computedMinDate === undefined) {
      inst.computedMinDate = DEFAULT_START_DATE;
    }
    if (inst.computedMaxDate === undefined) {
      inst.computedMaxDate = inst.computedMinDate + DEFAULT_MAX_WINDOW;
    }
    if (inst.computedMaxDate <= inst.computedMinDate) {
      inst.computedMaxDate = inst.computedMinDate + DEFAULT_MAX_WINDOW;
    }
  });

  return updatedInstances;
}

/**
 * STEP 2: Determine list of candidate flyby dates for each link end
 * Length N >= max(3, ceil((max_date - min_date) / orbital_period * 16))
 */
export function generateLinkEndDates(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody
): DirectionalLink[] {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  return links.map(link => {
    const src = instances.find(i => i.id === link.sourceInstanceId);
    const tgt = instances.find(i => i.id === link.targetInstanceId);

    const srcBody = src ? bodyMap.get(src.bodyName) : undefined;
    const tgtBody = tgt ? bodyMap.get(tgt.bodyName) : undefined;

    let departureSampleCount: number;
    if (src?.validFlybyDates && src.validFlybyDates.length > 0) {
      departureSampleCount = src.validFlybyDates.length;
    } else {
      const srcMinDate = src?.minDate ?? src?.computedMinDate ?? 0;
      const srcMaxDate = src?.maxDate ?? src?.computedMaxDate ?? srcMinDate + 31536000;
      const srcPeriod = srcBody ? getOrbitalPeriod(srcBody, mainBody) : 31536000;
      const srcRawN = Math.ceil(((srcMaxDate - srcMinDate) / Math.max(1, srcPeriod)) * SAMPLE_PER_PERIOD);
      departureSampleCount = Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, srcRawN));
    }

    let arrivalSampleCount: number;
    if (tgt?.validFlybyDates && tgt.validFlybyDates.length > 0) {
      arrivalSampleCount = tgt.validFlybyDates.length;
    } else {
      const tgtMinDate = tgt?.minDate ?? tgt?.computedMinDate ?? 0;
      const tgtMaxDate = tgt?.maxDate ?? tgt?.computedMaxDate ?? tgtMinDate + 31536000;
      const tgtPeriod = tgtBody ? getOrbitalPeriod(tgtBody, mainBody) : 31536000;
      const tgtRawN = Math.ceil(((tgtMaxDate - tgtMinDate) / Math.max(1, tgtPeriod)) * SAMPLE_PER_PERIOD);
      arrivalSampleCount = Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, tgtRawN));
    }

    return {
      ...link,
      departureSampleCount,
      arrivalSampleCount
    };
  });
}

/**
 * STEP 3: Count possible transfers for each link respecting flight duration
 */
export function countPossibleTransfers(
  link: DirectionalLink,
  srcInstance: InstanceNode,
  tgtInstance: InstanceNode
): { totalPossible: number; srcDates: number[]; tgtDates: number[] } {
  let srcDates: number[];
  if (srcInstance.validFlybyDates && srcInstance.validFlybyDates.length > 0) {
    srcDates = srcInstance.validFlybyDates;
  } else {
    const srcMin = srcInstance.minDate ?? srcInstance.computedMinDate ?? 0;
    const srcMax = srcInstance.maxDate ?? srcInstance.computedMaxDate ?? srcMin + 31536000;
    const nDep = link.departureSampleCount || 10;
    srcDates = [];
    const stepDep = (srcMax - srcMin) / Math.max(1, nDep - 1);
    for (let i = 0; i < nDep; i++) {
      srcDates.push(srcMin + i * stepDep);
    }
  }

  let tgtDates: number[];
  if (tgtInstance.validFlybyDates && tgtInstance.validFlybyDates.length > 0) {
    tgtDates = tgtInstance.validFlybyDates;
  } else {
    const tgtMin = tgtInstance.minDate ?? tgtInstance.computedMinDate ?? 0;
    const tgtMax = tgtInstance.maxDate ?? tgtInstance.computedMaxDate ?? tgtMin + 31536000;
    const nArr = link.arrivalSampleCount || 10;
    tgtDates = [];
    const stepArr = (tgtMax - tgtMin) / Math.max(1, nArr - 1);
    for (let j = 0; j < nArr; j++) {
      tgtDates.push(tgtMin + j * stepArr);
    }
  }

  let totalPossible = 0;
  const minDur = link.minFlightDuration ?? 0;
  const maxDur = link.maxFlightDuration ?? 1e10;
  for (const dep of srcDates) {
    for (const arr of tgtDates) {
      const dt = arr - dep;
      if (dt >= minDur && dt <= maxDur) {
        totalPossible++;
      }
    }
  }

  return { totalPossible, srcDates, tgtDates };
}

/**
 * STEP 4: Determine intersection of flyby dates at intermediate instances
 */
export function intersectInstanceDates(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies?: CelestialBody[],
  mainBody?: CelestialBody
): InstanceNode[] {
  const bodyMap = new Map<string, CelestialBody>();
  if (bodies) {
    bodies.forEach(b => bodyMap.set(b.name, b));
  }

  return instances.map(inst => {
    if (inst.validFlybyDates && inst.validFlybyDates.length > 0) {
      return inst;
    }

    const incoming = links.filter(l => l.targetInstanceId === inst.id);
    const outgoing = links.filter(l => l.sourceInstanceId === inst.id);

    if (incoming.length === 0 && outgoing.length === 0) {
      return inst;
    }

    const minD = inst.minDate ?? inst.computedMinDate ?? 0;
    const maxD = inst.maxDate ?? inst.computedMaxDate ?? minD + 31536000;

    const body = bodyMap.get(inst.bodyName);
    const period = (body && mainBody) ? getOrbitalPeriod(body, mainBody) : 31536000;
    const range = Math.max(0, maxD - minD);
    const rawN = Math.ceil((range / Math.max(1, period)) * SAMPLE_PER_PERIOD);
    const samples = Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, rawN));

    const validFlybyDates: number[] = [];
    const step = range / Math.max(1, samples - 1);
    for (let i = 0; i < samples; i++) {
      validFlybyDates.push(minD + i * step);
    }

    return {
      ...inst,
      validFlybyDates
    };
  });
}

/**
 * STEP 5: Compute Porkchop Plot for a given link
 */
export async function computePorkchopPlot(
  link: DirectionalLink,
  srcInstance: InstanceNode,
  tgtInstance: InstanceNode,
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdatePorkchop?: (pcData: PorkchopPlotData, validCount: number) => void,
  shouldStop?: () => boolean
): Promise<PorkchopPlotData> {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const srcBody = bodyMap.get(srcInstance.bodyName) || mainBody;
  const tgtBody = bodyMap.get(tgtInstance.bodyName) || mainBody;

  const { srcDates, tgtDates } = countPossibleTransfers(link, srcInstance, tgtInstance);

  const nDep = srcDates.length;
  const nArr = tgtDates.length;

  const c3DepMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const c3ArrMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const dvMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const flightTimeMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(0));
  const validMatrix: boolean[][] = Array.from({ length: nDep }, () => Array(nArr).fill(false));
  const vTransDepMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({ x: 0, y: 0, z: 0 }));
  const vTransArrMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({ x: 0, y: 0, z: 0 }));

  const muCentral = mainBody.stdGravParam || 1e12;

  const pcData: PorkchopPlotData = {
    linkId: link.id,
    sourceBody: srcInstance.bodyName,
    targetBody: tgtInstance.bodyName,
    depDates: srcDates,
    arrDates: tgtDates,
    c3DepMatrix,
    c3ArrMatrix,
    dvMatrix,
    flightTimeMatrix,
    validMatrix,
    vTransDepMatrix,
    vTransArrMatrix
  };

  let validCount = 0;
  let lastYieldTime = performance.now();

  for (let i = 0; i < nDep; i++) {
    if (shouldStop?.()) break;

    const depDate = srcDates[i];
    const srcState = getBodyStateAtUT(srcBody, mainBody, depDate);

    for (let j = 0; j < nArr; j++) {
      const arrDate = tgtDates[j];
      const dt = arrDate - depDate;

      flightTimeMatrix[i][j] = dt;

      const minDur = link.minFlightDuration ?? 0;
      const maxDur = link.maxFlightDuration ?? 1e10;
      if (dt < minDur || dt > maxDur) {
        continue;
      }

      const tgtState = getBodyStateAtUT(tgtBody, mainBody, arrDate);

      const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

      // Solve Lambert transfer
      const sol = solveLambert(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius);

      if (sol.isValid) {
        vTransDepMatrix[i][j] = sol.v1;
        vTransArrMatrix[i][j] = sol.v2;

        const vInfDep = vecSub(sol.v1, srcState.vel);
        const vInfArr = vecSub(sol.v2, tgtState.vel);

        const vInfDepMag = vecMag(vInfDep);
        const vInfArrMag = vecMag(vInfArr);

        const c3Dep = (vInfDepMag * vInfDepMag) / 1000000; // km^2 / s^2
        const c3Arr = (vInfArrMag * vInfArrMag) / 1000000;

        c3DepMatrix[i][j] = c3Dep;
        c3ArrMatrix[i][j] = c3Arr;
        dvMatrix[i][j] = vInfDepMag + vInfArrMag;

        // Check C3 constraints
        const passC3 = (srcInstance.maxC3 === undefined || c3Dep <= srcInstance.maxC3) &&
                       (tgtInstance.maxC3 === undefined || c3Arr <= tgtInstance.maxC3);

        validMatrix[i][j] = passC3;
        if (passC3) validCount++;
      }
    }

    const now = performance.now();
    // Yield every ~35ms to keep main thread 100% smooth and prevent browser freeze warning
    if (now - lastYieldTime > 35 || i === nDep - 1) {
      lastYieldTime = now;
      onProgress?.(
        `Computing ${srcInstance.bodyName}-${tgtInstance.bodyName} porkchop plot (${i + 1}/${nDep} departure windows, ${validCount} valid transfers)...`
      );
      onPartialUpdatePorkchop?.({ ...pcData }, validCount);
      await yieldUI();
    }
  }

  return pcData;
}

/**
 * Computes a 3-instance sequence porkchop plot (A -> B -> C).
 * Departure date of body A on X axis, Arrival date of body C on Y axis.
 * For each (tDepA, tArrC), selects the flyby date at body B that minimizes powered flyby dV.
 */
export async function computeSequencePorkchopPlot(
  srcInst: InstanceNode,
  flybyInst: InstanceNode,
  tgtInst: InstanceNode,
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdate?: (seqPc: SequencePorkchopData) => void,
  shouldStop?: () => boolean
): Promise<SequencePorkchopData> {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const srcBody = bodyMap.get(srcInst.bodyName) || mainBody;
  const flybyBody = bodyMap.get(flybyInst.bodyName) || mainBody;
  const tgtBody = bodyMap.get(tgtInst.bodyName) || mainBody;

  const muCentral = mainBody.stdGravParam || 1e12;

  const minDepA = srcInst.minDate ?? srcInst.computedMinDate ?? 0;
  const maxDepA = srcInst.maxDate ?? srcInst.computedMaxDate ?? (minDepA + 31536000);

  const minArrC = tgtInst.minDate ?? tgtInst.computedMinDate ?? (minDepA + 86400 * 30);
  const maxArrC = tgtInst.maxDate ?? tgtInst.computedMaxDate ?? (minArrC + 31536000 * 2);

  const N_DEP = 30;
  const N_ARR = 30;

  const depDates: number[] = [];
  const stepDep = (maxDepA - minDepA) / Math.max(1, N_DEP - 1);
  for (let i = 0; i < N_DEP; i++) {
    depDates.push(minDepA + i * stepDep);
  }

  const arrDates: number[] = [];
  const stepArr = (maxArrC - minArrC) / Math.max(1, N_ARR - 1);
  for (let j = 0; j < N_ARR; j++) {
    arrDates.push(minArrC + j * stepArr);
  }

  const c3DepAMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3DepBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrCMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const poweredDvBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const flybyDateMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const flightTimeMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const validMatrix: boolean[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(false));

  const seqId = `seq-pc-${srcInst.id}-${flybyInst.id}-${tgtInst.id}`;
  const seqLabel = `${srcInst.bodyName} ➔ ${flybyInst.bodyName} ➔ ${tgtInst.bodyName}`;

  const seqData: SequencePorkchopData = {
    id: seqId,
    sequenceLabel: seqLabel,
    sourceInstanceId: srcInst.id,
    flybyInstanceId: flybyInst.id,
    targetInstanceId: tgtInst.id,
    sourceBody: srcInst.bodyName,
    flybyBody: flybyInst.bodyName,
    targetBody: tgtInst.bodyName,
    depDates,
    arrDates,
    c3DepAMatrix,
    c3ArrBMatrix,
    c3DepBMatrix,
    c3ArrCMatrix,
    poweredDvBMatrix,
    flybyDateMatrix,
    flightTimeMatrix,
    validMatrix,
  };

  let validCount = 0;
  let lastYieldTime = performance.now();

  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

  for (let i = 0; i < N_DEP; i++) {
    if (shouldStop?.()) break;
    const tDepA = depDates[i];
    const stA = getBodyStateAtUT(srcBody, mainBody, tDepA);

    for (let j = 0; j < N_ARR; j++) {
      const tArrC = arrDates[j];
      const totalDt = tArrC - tDepA;
      flightTimeMatrix[i][j] = totalDt;

      if (totalDt < 86400) continue;

      const stC = getBodyStateAtUT(tgtBody, mainBody, tArrC);

      const candidateDates: number[] = [];
      const FLYBY_SAMPLES = 25;
      const flybyStep = totalDt / (FLYBY_SAMPLES + 1);
      for (let k = 1; k <= FLYBY_SAMPLES; k++) {
        candidateDates.push(tDepA + k * flybyStep);
      }
      if (flybyInst.validFlybyDates) {
        for (const vf of flybyInst.validFlybyDates) {
          if (vf > tDepA + 3600 && vf < tArrC - 3600) {
            candidateDates.push(vf);
          }
        }
      }

      candidateDates.sort((a, b) => a - b);

      let minDv = Infinity;
      let bestChoice: {
        c3DepA: number;
        c3ArrB: number;
        c3DepB: number;
        c3ArrC: number;
        poweredDv: number;
        flybyDate: number;
      } | null = null;

      for (const tFlybyB of candidateDates) {
        const dt1 = tFlybyB - tDepA;
        const dt2 = tArrC - tFlybyB;
        if (dt1 <= 3600 || dt2 <= 3600) continue;

        const stB = getBodyStateAtUT(flybyBody, mainBody, tFlybyB);

        const sol1 = solveLambert(stA.pos, stB.pos, dt1, muCentral, true, minAllowedRadius);
        if (!sol1.isValid) continue;

        const sol2 = solveLambert(stB.pos, stC.pos, dt2, muCentral, true, minAllowedRadius);
        if (!sol2.isValid) continue;

        const vInfDepA = vecSub(sol1.v1, stA.vel);
        const vInfInB = vecSub(sol1.v2, stB.vel);
        const vInfOutB = vecSub(sol2.v1, stB.vel);
        const vInfArrC = vecSub(sol2.v2, stC.vel);

        const evalRes = evaluateFlybyAtDate(
          flybyBody,
          vInfInB,
          vInfOutB,
          tFlybyB,
          flybyInst.minFlybyRadius
        );

        if (evalRes.flybyMargin < -1e-3) continue;

        const c3DepA = (vecMag(vInfDepA) ** 2) / 1e6;
        const c3ArrB = (evalRes.vInfInMag ** 2) / 1e6;
        const c3DepB = (evalRes.vInfOutMag ** 2) / 1e6;
        const c3ArrC = (vecMag(vInfArrC) ** 2) / 1e6;

        if (srcInst.maxC3 !== undefined && c3DepA > srcInst.maxC3) continue;
        if (flybyInst.maxC3 !== undefined && (c3ArrB > flybyInst.maxC3 || c3DepB > flybyInst.maxC3)) continue;
        if (tgtInst.maxC3 !== undefined && c3ArrC > tgtInst.maxC3) continue;

        if (evalRes.poweredDv < minDv) {
          minDv = evalRes.poweredDv;
          bestChoice = {
            c3DepA,
            c3ArrB,
            c3DepB,
            c3ArrC,
            poweredDv: evalRes.poweredDv,
            flybyDate: tFlybyB,
          };
        }
      }

      if (bestChoice) {
        c3DepAMatrix[i][j] = bestChoice.c3DepA;
        c3ArrBMatrix[i][j] = bestChoice.c3ArrB;
        c3DepBMatrix[i][j] = bestChoice.c3DepB;
        c3ArrCMatrix[i][j] = bestChoice.c3ArrC;
        poweredDvBMatrix[i][j] = bestChoice.poweredDv;
        flybyDateMatrix[i][j] = bestChoice.flybyDate;
        validMatrix[i][j] = true;
        validCount++;
      }
    }

    const now = performance.now();
    if (now - lastYieldTime > 35 || i === N_DEP - 1) {
      lastYieldTime = now;
      onProgress?.(
        `Computing sequence porkchop plot for ${seqLabel} (${i + 1}/${N_DEP} departure windows)...`
      );
      onPartialUpdate?.(seqData);
      await yieldUI();
    }
  }

  return seqData;
}

export type ProgressCallback = (statusMessage: string) => void;
export type PartialUpdateCallback = (update: {
  instances?: InstanceNode[];
  links?: DirectionalLink[];
  porkchops?: Record<string, PorkchopPlotData>;
  sequencePorkchops?: Record<string, SequencePorkchopData>;
}) => void;

const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Full Execution Pipeline (Steps 1 through 8)
 */
export async function runSequenceSearch(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdate?: PartialUpdateCallback,
  shouldStop?: () => boolean
): Promise<{
  updatedInstances: InstanceNode[];
  updatedLinks: DirectionalLink[];
  porkchops: Record<string, PorkchopPlotData>;
  sequencePorkchops: Record<string, SequencePorkchopData>;
  sequences: FlyableSequenceResult[];
}> {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  let currInstances = [...instances];
  let currLinks = [...links];
  const porkchops: Record<string, PorkchopPlotData> = {};
  const sequencePorkchops: Record<string, SequencePorkchopData> = {};
  const sequences: FlyableSequenceResult[] = [];

  const earlyReturn = () => ({
    updatedInstances: currInstances,
    updatedLinks: currLinks,
    porkchops,
    sequencePorkchops,
    sequences: sequences.sort((a, b) => {
      const dvA = a.totalDv || 0;
      const dvB = b.totalDv || 0;
      if (Math.abs(dvA - dvB) > 1e-3) return dvA - dvB;
      if (Math.abs(a.depC3 - b.depC3) > 1e-3) return a.depC3 - b.depC3;
      return a.totalFlightTime - b.totalFlightTime;
    })
  });

  if (shouldStop?.()) return earlyReturn();

  // Step 1: Propagate date bounds
  onProgress?.('Propagating date bounds...');
  await yieldUI();
  if (shouldStop?.()) return earlyReturn();
  currInstances = propagateDateBounds(currInstances, currLinks);
  onPartialUpdate?.({ instances: currInstances, links: currLinks });

  // Step 2: Determine list of flyby dates at link ends
  onProgress?.('Generating link departure & arrival dates...');
  await yieldUI();
  if (shouldStop?.()) return earlyReturn();
  currLinks = generateLinkEndDates(currInstances, currLinks, bodies, mainBody);
  onPartialUpdate?.({ instances: currInstances, links: currLinks });

  // Step 3: Count possible transfers
  onProgress?.('Counting possible trajectory transfers...');
  await yieldUI();
  if (shouldStop?.()) return earlyReturn();
  currLinks = currLinks.map(link => {
    const src = currInstances.find(i => i.id === link.sourceInstanceId);
    const tgt = currInstances.find(i => i.id === link.targetInstanceId);
    if (!src || !tgt) return link;
    const { totalPossible } = countPossibleTransfers(link, src, tgt);
    return { ...link, possibleTransfersCount: totalPossible };
  });
  onPartialUpdate?.({ instances: currInstances, links: currLinks });

  // Step 4: Intersect dates at intermediate instances
  onProgress?.('Intersecting intermediate flyby dates...');
  await yieldUI();
  if (shouldStop?.()) return earlyReturn();
  currInstances = intersectInstanceDates(currInstances, currLinks, bodies, mainBody);
  onPartialUpdate?.({ instances: currInstances, links: currLinks });

  // Step 5 & 6: Compute porkchops and filter flybys using consecutive least-cost pairs
  const ensurePorkchopComputed = async (link: DirectionalLink): Promise<PorkchopPlotData | undefined> => {
    if (porkchops[link.id]) return porkchops[link.id];

    const src = currInstances.find(i => i.id === link.sourceInstanceId);
    const tgt = currInstances.find(i => i.id === link.targetInstanceId);
    if (!src || !tgt) return undefined;

    onProgress?.(`Computing ${src.bodyName}-${tgt.bodyName} porkchop plot...`);
    await yieldUI();
    if (shouldStop?.()) return undefined;

    const pcData = await computePorkchopPlot(
      link,
      src,
      tgt,
      bodies,
      mainBody,
      onProgress,
      (partialPc, validSoFar) => {
        porkchops[link.id] = partialPc;
        currLinks = currLinks.map(l => l.id === link.id ? {
          ...l,
          possibleTransfersCount: validSoFar,
          departureSampleCount: partialPc.depDates.length,
          arrivalSampleCount: partialPc.arrDates.length,
          porkchopData: partialPc
        } : l);
        onPartialUpdate?.({
          instances: currInstances,
          links: currLinks,
          porkchops: { ...porkchops }
        });
      },
      shouldStop
    );

    porkchops[link.id] = pcData;
    return pcData;
  };

  const startInstances = currInstances.filter(i => !currLinks.some(l => l.targetInstanceId === i.id));
  const allPaths: DirectionalLink[][] = [];
  for (const startInst of startInstances) {
    allPaths.push(...findPathsFrom(startInst.id, currLinks, []));
  }

  interface PairItem {
    id: string;
    link1: DirectionalLink;
    link2: DirectionalLink;
    srcInst: InstanceNode;
    flybyInst: InstanceNode;
    tgtInst: InstanceNode;
    evaluated: boolean;
  }

  const pairs: PairItem[] = [];
  const pairIdSet = new Set<string>();

  for (const path of allPaths) {
    for (let k = 0; k < path.length - 1; k++) {
      const link1 = path[k];
      const link2 = path[k + 1];
      const pairId = `${link1.id}__${link2.id}`;
      if (pairIdSet.has(pairId)) continue;
      pairIdSet.add(pairId);

      const srcInst = currInstances.find(i => i.id === link1.sourceInstanceId);
      const flybyInst = currInstances.find(i => i.id === link1.targetInstanceId);
      const tgtInst = currInstances.find(i => i.id === link2.targetInstanceId);

      if (srcInst && flybyInst && tgtInst) {
        pairs.push({
          id: pairId,
          link1,
          link2,
          srcInst,
          flybyInst,
          tgtInst,
          evaluated: false
        });
      }
    }
  }

  // Iteratively process consecutive pairs with the LEAST amount of transfer to compute
  while (pairs.some(p => !p.evaluated)) {
    if (shouldStop?.()) return earlyReturn();

    const getLinkCost = (link: DirectionalLink) => {
      const pc = porkchops[link.id];
      if (pc) {
        let valid = 0;
        for (let r = 0; r < pc.validMatrix.length; r++) {
          for (let c = 0; c < pc.validMatrix[r].length; c++) {
            if (pc.validMatrix[r][c]) valid++;
          }
        }
        return valid;
      }
      return link.possibleTransfersCount ?? ((link.departureSampleCount || 30) * (link.arrivalSampleCount || 30));
    };

    let bestPair: PairItem | null = null;
    let minCost = Infinity;

    for (const p of pairs) {
      if (p.evaluated) continue;
      const c1 = getLinkCost(p.link1);
      const c2 = getLinkCost(p.link2);
      const cost = c1 + c2;
      if (cost < minCost) {
        minCost = cost;
        bestPair = p;
      }
    }

    if (!bestPair) break;

    // Compute porkchops for bestPair.link1 and bestPair.link2
    const pc1 = await ensurePorkchopComputed(bestPair.link1);
    if (shouldStop?.()) return earlyReturn();
    const pc2 = await ensurePorkchopComputed(bestPair.link2);
    if (shouldStop?.()) return earlyReturn();

    if (pc1 && pc2) {
      onProgress?.(
        `Checking flybys at ${bestPair.flybyInst.bodyName} between ${bestPair.srcInst.bodyName} and ${bestPair.tgtInst.bodyName}...`
      );
      await yieldUI();

      const srcBody = bodyMap.get(bestPair.srcInst.bodyName) || mainBody;
      const flybyBody = bodyMap.get(bestPair.flybyInst.bodyName) || mainBody;
      const tgtBody = bodyMap.get(bestPair.tgtInst.bodyName) || mainBody;

      const newValid1 = pc1.validMatrix.map(row => [...row]);
      const newValid2 = pc2.validMatrix.map(row => [...row]);

      const validEntry1 = pc1.validMatrix.map(row => row.map(() => false));
      const validEntry2 = pc2.validMatrix.map(row => row.map(() => false));

      const srcPosCache = new Map<number, Vector3D>();
      const tgtPosCache = new Map<number, Vector3D>();

      for (const tDep of pc1.depDates) {
        srcPosCache.set(tDep, getBodyStateAtUT(srcBody, mainBody, tDep).pos);
      }
      for (const tArr of pc2.arrDates) {
        tgtPosCache.set(tArr, getBodyStateAtUT(tgtBody, mainBody, tArr).pos);
      }

      let flybyCount = 0;
      let lastYield = performance.now();

      for (let j = 0; j < pc1.arrDates.length; j++) {
        const t1 = pc1.arrDates[j];
        const j2 = j < pc1.arrDates.length - 1 ? j + 1 : (j > 0 ? j - 1 : j);
        const t2 = pc1.arrDates[j2];

        const stBody1 = getBodyStateAtUT(flybyBody, mainBody, t1);
        const stBody2 = getBodyStateAtUT(flybyBody, mainBody, t2);

        for (let m = 0; m < pc2.depDates.length; m++) {
          const tDep2 = pc2.depDates[m];
          if (Math.abs(tDep2 - t1) > 86400 * 5) continue; // Flyby dates must align within window

          const m2 = m < pc2.depDates.length - 1 ? m + 1 : (m > 0 ? m - 1 : m);

          for (let i = 0; i < pc1.depDates.length; i++) {
            if (!pc1.validMatrix[i][j]) continue;
            const vTransIn1 = pc1.vTransArrMatrix?.[i]?.[j];
            const vTransIn2 = pc1.vTransArrMatrix?.[i]?.[j2];
            if (!vTransIn1 || !vTransIn2) continue;

            const vInfIn1 = vecSub(vTransIn1, stBody1.vel);
            const vInfIn2 = vecSub(vTransIn2, stBody2.vel);

            for (let n = 0; n < pc2.arrDates.length; n++) {
              if (!pc2.validMatrix[m][n]) continue;
              const vTransOut1 = pc2.vTransDepMatrix?.[m]?.[n];
              const vTransOut2 = pc2.vTransDepMatrix?.[m2]?.[n];
              if (!vTransOut1 || !vTransOut2) continue;

              const vInfOut1 = vecSub(vTransOut1, stBody1.vel);
              const vInfOut2 = vecSub(vTransOut2, stBody2.vel);

              const feas = matchUnpoweredFlyby(
                flybyBody,
                vInfIn1,
                vInfIn2,
                vInfOut1,
                vInfOut2,
                t1,
                t2,
                bestPair.flybyInst.minFlybyRadius
              );

              if (feas.isValid) {
                if (bestPair.flybyInst.maxC3 !== undefined) {
                  const c3In = (feas.vInfInMag ** 2) / 1e6;
                  const c3Out = (feas.vInfOutMag ** 2) / 1e6;
                  if (c3In > bestPair.flybyInst.maxC3 || c3Out > bestPair.flybyInst.maxC3) continue;
                }
                validEntry1[i][j] = true;
                validEntry2[m][n] = true;
                flybyCount++;
              }
            }
          }
        }

        const now = performance.now();
        if (now - lastYield > 35) {
          lastYield = now;
          onProgress?.(
            `Evaluating ${bestPair.flybyInst.bodyName} flybys (${j + 1}/${pc1.arrDates.length} windows, ${flybyCount} valid unpowered flybys found)...`
          );
          await yieldUI();
          if (shouldStop?.()) return earlyReturn();
        }
      }

      // Count total valid transfers in pc1 and pc2
      let count1 = 0;
      for (let r = 0; r < pc1.validMatrix.length; r++) {
        for (let c = 0; c < pc1.validMatrix[r].length; c++) {
          if (pc1.validMatrix[r][c]) count1++;
        }
      }

      let count2 = 0;
      for (let r = 0; r < pc2.validMatrix.length; r++) {
        for (let c = 0; c < pc2.validMatrix[r].length; c++) {
          if (pc2.validMatrix[r][c]) count2++;
        }
      }

      currLinks = currLinks.map(l => {
        if (l.id === bestPair!.link1.id) return { ...l, possibleTransfersCount: count1, porkchopData: pc1 };
        if (l.id === bestPair!.link2.id) return { ...l, possibleTransfersCount: count2, porkchopData: pc2 };
        return l;
      });

      onPartialUpdate?.({
        instances: currInstances,
        links: currLinks,
        porkchops: { ...porkchops }
      });
    }

    bestPair.evaluated = true;
  }

  // Ensure any standalone links (not part of a pair) are also computed
  for (const link of currLinks) {
    if (shouldStop?.()) return earlyReturn();
    if (!porkchops[link.id]) {
      await ensurePorkchopComputed(link);
    }
  }

  // Step 7: Assemble multi-link flyable sequences from remaining valid transfers
  for (const startInst of startInstances) {
    if (shouldStop?.()) return earlyReturn();
    const paths = findPathsFrom(startInst.id, currLinks, []);

    for (const pathLinks of paths) {
      if (shouldStop?.()) return earlyReturn();
      if (pathLinks.length === 0) continue;

      const instIds = [pathLinks[0].sourceInstanceId, ...pathLinks.map(l => l.targetInstanceId)];
      const pathInsts = instIds.map(id => currInstances.find(i => i.id === id)!);

      const pathPorkchops = pathLinks.map(l => porkchops[l.id]).filter(Boolean);
      if (pathPorkchops.length !== pathLinks.length) continue;

      await findValidTrajectoriesForPath(
        pathInsts,
        pathLinks,
        pathPorkchops,
        bodies,
        mainBody,
        sequences,
        onProgress,
        shouldStop
      );
    }
  }

  // Step 8: Compute 3-instance sequence porkchop plots for all pairs
  if (pairs && pairs.length > 0) {
    for (const pair of pairs) {
      if (shouldStop?.()) return earlyReturn();
      const seqPc = await computeSequencePorkchopPlot(
        pair.srcInst,
        pair.flybyInst,
        pair.tgtInst,
        bodies,
        mainBody,
        onProgress,
        (partialSeq) => {
          sequencePorkchops[partialSeq.id] = partialSeq;
          onPartialUpdate?.({
            instances: currInstances,
            links: currLinks,
            porkchops: { ...porkchops },
            sequencePorkchops: { ...sequencePorkchops },
          });
        },
        shouldStop
      );
      sequencePorkchops[seqPc.id] = seqPc;
    }
  }

  return earlyReturn();
}

function findPathsFrom(startId: string, links: DirectionalLink[], currentPath: DirectionalLink[]): DirectionalLink[][] {
  const outgoing = links.filter(l => l.sourceInstanceId === startId);
  if (outgoing.length === 0) {
    return [currentPath];
  }

  const allPaths: DirectionalLink[][] = [];
  for (const link of outgoing) {
    // Avoid loops
    if (currentPath.some(p => p.sourceInstanceId === link.targetInstanceId || p.targetInstanceId === link.targetInstanceId)) {
      continue;
    }
    const subPaths = findPathsFrom(link.targetInstanceId, links, [...currentPath, link]);
    allPaths.push(...subPaths);
  }
  return allPaths;
}

async function findValidTrajectoriesForPath(
  pathInsts: InstanceNode[],
  pathLinks: DirectionalLink[],
  porkchops: PorkchopPlotData[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  outputSequences: FlyableSequenceResult[],
  onProgress?: ProgressCallback,
  shouldStop?: () => boolean
) {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));
  const muCentral = mainBody.stdGravParam || 1e12;
  const numLinks = pathLinks.length;

  interface PathStepState {
    ut: number;
    solFromPrev?: LambertSolution;
    flybyDetail?: FlybyDetail;
  }

  async function search(stepIndex: number, currentChain: PathStepState[]) {
    if (outputSequences.length >= 150) return;
    if (shouldStop?.()) return;

    if (stepIndex === 0) {
      // Step 0: Departure instance
      const pc0 = porkchops[0];
      const srcInst = pathInsts[0];
      const pathStr = pathInsts.map(i => i.bodyName).join(' ➔ ');

      for (let i = 0; i < pc0.depDates.length; i++) {
        if (outputSequences.length >= 150) break;
        if (shouldStop?.()) break;

        if (i % 8 === 0) {
          onProgress?.(`Searching sequence options : ${i + 1}/${pc0.depDates.length} departure windows - ${outputSequences.length} valid sequences found ...`);
          await yieldUI();
        }

        const tDep = pc0.depDates[i];
        if (srcInst.minDate !== undefined && tDep < srcInst.minDate) continue;
        if (srcInst.maxDate !== undefined && tDep > srcInst.maxDate) continue;

        await search(1, [{ ut: tDep }]);
      }
      return;
    }

    const linkIdx = stepIndex - 1; // Link index (0 to numLinks - 1)
    const pc = porkchops[linkIdx];
    const prevStep = currentChain[stepIndex - 1];
    const tPrev = prevStep.ut;

    const prevInst = pathInsts[stepIndex - 1];
    const currInst = pathInsts[stepIndex];

    const prevBody = bodyMap.get(prevInst.bodyName) || mainBody;
    const currBody = bodyMap.get(currInst.bodyName) || mainBody;

    const minDur = pathLinks[linkIdx].minFlightDuration ?? 0;
    const maxDur = pathLinks[linkIdx].maxFlightDuration ?? 1e10;

    const sPrev = getBodyStateAtUT(prevBody, mainBody, tPrev);

    const i = pc.depDates.indexOf(tPrev);
    if (i === -1) return;

    for (let j = 0; j < pc.arrDates.length; j++) {
      if (outputSequences.length >= 150) break;
      if (shouldStop?.()) break;

      if (!pc.validMatrix[i][j]) continue;

      const tCurr = pc.arrDates[j];
      const dt = tCurr - tPrev;

      if (dt < minDur || dt > maxDur) continue;
      if (currInst.minDate !== undefined && tCurr < currInst.minDate) continue;
      if (currInst.maxDate !== undefined && tCurr > currInst.maxDate) continue;

      const v1 = pc.vTransDepMatrix?.[i]?.[j];
      const v2 = pc.vTransArrMatrix?.[i]?.[j];
      if (!v1 || !v2 || (v1.x === 0 && v1.y === 0 && v1.z === 0)) continue;

      const sol: LambertSolution = {
        v1,
        v2,
        isValid: true,
        semiMajorAxis: 0
      };

      // Check flyby at prevInst if stepIndex > 1
      let currentFlybyDetail: FlybyDetail | undefined = undefined;
      let effectiveSolFromPrev = sol;

      if (stepIndex > 1) {
        const prevStep = currentChain[stepIndex - 1];
        const stPrev1 = getBodyStateAtUT(prevBody, mainBody, tPrev);

        const vInfIn1 = vecSub(prevStep.solFromPrev!.v2, stPrev1.vel);
        const vInfOut1 = vecSub(sol.v1, stPrev1.vel);

        // Get adjacent grid point from porkchops if available for linear regression slope, or fallback to tPrev
        const pcPrev = porkchops[linkIdx - 1];
        const pcCurr = porkchops[linkIdx];
        const jPrev = pcPrev.arrDates.indexOf(tPrev);
        const iCurr = pcCurr.depDates.indexOf(tPrev);

        let t1 = tPrev;
        let t2 = tPrev;
        let vInfIn2 = vInfIn1;
        let vInfOut2 = vInfOut1;

        if (jPrev !== -1 && jPrev < pcPrev.arrDates.length - 1 && iCurr !== -1 && iCurr < pcCurr.depDates.length - 1) {
          const t2Candidate = Math.min(pcPrev.arrDates[jPrev + 1], pcCurr.depDates[iCurr + 1]);
          const dt = t2Candidate - tPrev;
          if (dt > 0) {
            t2 = t2Candidate;
            const stPrev2 = getBodyStateAtUT(prevBody, mainBody, t2);
            const iPrevDep = pcPrev.depDates.indexOf(currentChain[stepIndex - 2].ut);
            const vTransIn2 = pcPrev.vTransArrMatrix?.[iPrevDep]?.[jPrev + 1];
            const vTransOut2 = pcCurr.vTransDepMatrix?.[iCurr + 1]?.[j];
            if (vTransIn2) vInfIn2 = vecSub(vTransIn2, stPrev2.vel);
            if (vTransOut2) vInfOut2 = vecSub(vTransOut2, stPrev2.vel);
          }
        }

        const flybyFeas = matchUnpoweredFlyby(
          prevBody,
          vInfIn1,
          vInfIn2,
          vInfOut1,
          vInfOut2,
          t1,
          t2,
          prevInst.minFlybyRadius
        );

        if (!flybyFeas.isValid || flybyFeas.matchedFlybyDate === undefined) continue;

        if (prevInst.maxC3 !== undefined) {
          const c3In = (flybyFeas.vInfInMag ** 2) / 1e6;
          const c3Out = (flybyFeas.vInfOutMag ** 2) / 1e6;
          if (c3In > prevInst.maxC3 || c3Out > prevInst.maxC3) continue;
        }

        const matchedFlybyUT = flybyFeas.matchedFlybyDate;

        currentFlybyDetail = {
          bodyName: prevBody.name,
          instanceId: prevInst.id,
          flybyDate: matchedFlybyUT,
          flybyDateSampling: Math.abs(t2 - t1) || 86400,
          periapsisAlt: flybyFeas.periapsisAlt,
          flybyMargin: flybyFeas.flybyMargin,
          deflectionAngle: flybyFeas.deflectionAngle,
          maxDeflectionAngle: flybyFeas.maxDeflectionAngle,
          stochasticDv: flybyFeas.stochasticDv,
          vInfInMag: flybyFeas.vInfInMag,
          vInfOutMag: flybyFeas.vInfOutMag
        };
      }

      const nextStepState: PathStepState = {
        ut: tCurr,
        solFromPrev: effectiveSolFromPrev,
        flybyDetail: currentFlybyDetail
      };

      const newChain = [...currentChain, nextStepState];

      if (stepIndex === numLinks) {
        // Reached end of path! Assemble complete sequence
        const depState = getBodyStateAtUT(bodyMap.get(pathInsts[0].bodyName) || mainBody, mainBody, currentChain[0].ut);
        const arrState = getBodyStateAtUT(currBody, mainBody, tCurr);

        const solFirst = newChain[1].solFromPrev!;
        const solLast = newChain[numLinks].solFromPrev!;

        const vInfDep = vecSub(solFirst.v1, depState.vel);
        const vInfArr = vecSub(solLast.v2, arrState.vel);

        const depC3 = (vecMag(vInfDep) ** 2) / 1e6;
        const arrC3 = (vecMag(vInfArr) ** 2) / 1e6;

        if (pathInsts[0].maxC3 !== undefined && depC3 > pathInsts[0].maxC3) continue;
        if (currInst.maxC3 !== undefined && arrC3 > currInst.maxC3) continue;

        const transfers = [];
        const flybys: FlybyDetail[] = [];
        let totalStochasticDv = 0;

        for (let k = 1; k <= numLinks; k++) {
          const stepK = newChain[k];
          const prevK = newChain[k - 1];

          if (stepK.flybyDetail) {
            flybys.push(stepK.flybyDetail);
            totalStochasticDv += stepK.flybyDetail.stochasticDv;
          }

          const bSrc = bodyMap.get(pathInsts[k - 1].bodyName) || mainBody;
          const bTgt = bodyMap.get(pathInsts[k].bodyName) || mainBody;

          const stSrc = getBodyStateAtUT(bSrc, mainBody, prevK.ut);
          const stTgt = getBodyStateAtUT(bTgt, mainBody, stepK.ut);

          const solK = stepK.solFromPrev!;
          const vDep = vecSub(solK.v1, stSrc.vel);
          const vArr = vecSub(solK.v2, stTgt.vel);

          transfers.push({
            depDate: prevK.ut,
            arrDate: stepK.ut,
            flightTime: stepK.ut - prevK.ut,
            vInfDep: [vDep.x, vDep.y, vDep.z],
            vInfArr: [vArr.x, vArr.y, vArr.z],
            c3Dep: (vecMag(vDep) ** 2) / 1e6,
            c3Arr: (vecMag(vArr) ** 2) / 1e6,
            depAngle: 0,
            arrAngle: 0,
            transferOrbitSemiMajorAxis: solK.semiMajorAxis,
            vTransDep: [solK.v1.x, solK.v1.y, solK.v1.z],
            vTransArr: [solK.v2.x, solK.v2.y, solK.v2.z],
            isValid: true
          });
        }

        const totalDv = totalStochasticDv;

        const seqResult: FlyableSequenceResult = {
          id: `seq-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          instanceIds: pathInsts.map(inst => inst.id),
          bodyNames: pathInsts.map(inst => inst.bodyName),
          depDate: currentChain[0].ut,
          arrDate: tCurr,
          depC3,
          arrC3,
          totalFlightTime: tCurr - currentChain[0].ut,
          totalStochasticDv,
          totalDv,
          flybys,
          transfers
        };

        outputSequences.push(seqResult);
      } else {
        // Continue to next link
        await search(stepIndex + 1, newChain);
      }
    }
  }

  await search(0, []);
}
