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
import { solveLambert, solveLambertBest, solveLambertAllRevolutions, LambertSolution } from './lambert';
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
  sequencePorkchops?: Record<string, SequencePorkchopData>;
  validSequences: FlyableSequenceResult[];
  isComplete: boolean;
}

export interface SolverResult {
  updatedInstances: InstanceNode[];
  updatedLinks: DirectionalLink[];
  porkchops: Record<string, PorkchopPlotData>;
  sequencePorkchops?: Record<string, SequencePorkchopData>;
  sequences: FlyableSequenceResult[];
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
 * Calculates pump angle intersection theta for two bodies in Tisserand (r_p, E) space
 */
function getTisserandIntersectionTheta(
  bodyA: CelestialBody,
  vInfA: number,
  bodyB: CelestialBody,
  vInfB: number,
  mu_main: number
): { thetaA: number; thetaB: number } | null {
  const aA = bodyA.semiMajorAxis;
  const aB = bodyB.semiMajorAxis;

  if (Math.abs(aA - aB) < 1e-3) {
    if (Math.abs(vInfA - vInfB) < 1e-3) {
      return { thetaA: 0, thetaB: 0 };
    }
    return null;
  }

  const v_pA = Math.sqrt(mu_main / aA);
  const v_pB = Math.sqrt(mu_main / aB);

  const A1 = v_pA * vInfA;
  const B1 = -v_pB * vInfB;
  const C1 = (mu_main / (2 * aA)) - (mu_main / (2 * aB)) + 0.5 * vInfB * vInfB - 0.5 * vInfA * vInfA;

  const A2 = aA * vInfA;
  const B2 = -aB * vInfB;
  const C2 = Math.sqrt(mu_main * aB) - Math.sqrt(mu_main * aA);

  const D = A1 * B2 - A2 * B1;
  if (Math.abs(D) < 1e-9) return null;

  const xA = (C1 * B2 - C2 * B1) / D;
  const xB = (A1 * C2 - A2 * C1) / D;

  if (xA < -1 - 1e-5 || xA > 1 + 1e-5) return null;
  if (xB < -1 - 1e-5 || xB > 1 + 1e-5) return null;

  const clampedXA = Math.max(-1, Math.min(1, xA));
  const clampedXB = Math.max(-1, Math.min(1, xB));

  const thetaA = Math.acos(clampedXA);
  const thetaB = Math.acos(clampedXB);

  const thetaAMax = vInfA >= v_pA ? Math.acos(-v_pA / vInfA) : Math.PI;
  const thetaBMax = vInfB >= v_pB ? Math.acos(-v_pB / vInfB) : Math.PI;

  if (thetaA > thetaAMax + 1e-4) return null;
  if (thetaB > thetaBMax + 1e-4) return null;

  return { thetaA, thetaB };
}

/**
 * Computes Tisserand v_inf envelopes (in m/s) for each instance using iterative 3-body deflection/crossing propagation.
 */
export function computeTisserandEnvelopes(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody
): Record<string, { minMs: number; maxMs: number }> {
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const mu_main = mainBody.stdGravParam || 1.32712440018e20;

  const bodyPrepMap: Record<string, {
    body: CelestialBody;
    r_p_min: number;
    vInf5DegMs: number;
  }> = {};

  const activeInstanceEnvelopes: Record<string, { minMs: number; maxMs: number }> = {};

  bodies.forEach(body => {
    if (body.name === mainBody.name) return;
    const mu_b = body.stdGravParam;
    const R_b = body.radius;

    const bodyInstances = instances.filter(i => i.bodyName === body.name);
    let minAlt = Infinity;
    bodyInstances.forEach(inst => {
      if (inst.minFlybyRadius !== undefined && inst.minFlybyRadius < minAlt) {
        minAlt = inst.minFlybyRadius;
      }
    });
    if (minAlt === Infinity) {
      minAlt = body.atmosphereHeight;
    }
    const r_p_min = R_b + minAlt;

    const targetDeltaRad = (5 * Math.PI) / 180;
    const sinHalfDelta = Math.sin(targetDeltaRad / 2);
    const vInf5DegMs = Math.sqrt(((1 / sinHalfDelta) - 1) * mu_b / r_p_min);

    bodyPrepMap[body.name] = {
      body,
      r_p_min,
      vInf5DegMs,
    };
  });

  instances.forEach(inst => {
    const prep = bodyPrepMap[inst.bodyName];
    if (!prep) return;
    let maxMs = prep.vInf5DegMs;
    const hasIncoming = links.some(l => l.targetInstanceId === inst.id);
    const hasOutgoing = links.some(l => l.sourceInstanceId === inst.id);
    const isPureFlyby = hasIncoming && hasOutgoing && !inst.isSourceOverride;
    if (!isPureFlyby && inst.maxC3 !== undefined && inst.maxC3 > 0) {
      maxMs = Math.min(maxMs, Math.sqrt(inst.maxC3) * 1000);
    }
    maxMs = Math.max(1000, maxMs);
    activeInstanceEnvelopes[inst.id] = { minMs: 0, maxMs };
  });

  const testInstanceVInfMsValid = (inst: InstanceNode, vInfMs: number): boolean => {
    const body = bodyMap.get(inst.bodyName);
    const prep = bodyPrepMap[inst.bodyName];
    if (!body || !prep) return true;

    const inLinks = links.filter(l => l.targetInstanceId === inst.id);
    const outLinks = links.filter(l => l.sourceInstanceId === inst.id);

    if (inLinks.length > 0 && outLinks.length > 0) {
      const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (prep.r_p_min * vInfMs * vInfMs) / body.stdGravParam)));
      const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);

      let satisfiesPair = false;
      for (const inLink of inLinks) {
        const srcInst = instMap.get(inLink.sourceInstanceId);
        if (!srcInst) continue;
        const b1 = bodyMap.get(srcInst.bodyName);
        const env1 = activeInstanceEnvelopes[srcInst.id];
        if (!b1 || !env1 || (env1.minMs === 0 && env1.maxMs === 0)) continue;

        for (const outLink of outLinks) {
          const tgtInst = instMap.get(outLink.targetInstanceId);
          if (!tgtInst) continue;
          const b2 = bodyMap.get(tgtInst.bodyName);
          const env2 = activeInstanceEnvelopes[tgtInst.id];
          if (!b2 || !env2 || (env2.minMs === 0 && env2.maxMs === 0)) continue;

          const numSamples: number = 30;
          const theta1List: number[] = [];
          const theta2List: number[] = [];

          for (let i = 0; i < numSamples; i++) {
            const frac = numSamples === 1 ? 0 : i / (numSamples - 1);
            const v1 = env1.minMs + frac * (env1.maxMs - env1.minMs);
            const res1 = getTisserandIntersectionTheta(body, vInfMs, b1, v1, mu_main);
            if (res1) theta1List.push(res1.thetaA);
          }

          for (let i = 0; i < numSamples; i++) {
            const frac = numSamples === 1 ? 0 : i / (numSamples - 1);
            const v2 = env2.minMs + frac * (env2.maxMs - env2.minMs);
            const res2 = getTisserandIntersectionTheta(body, vInfMs, b2, v2, mu_main);
            if (res2) theta2List.push(res2.thetaA);
          }

          if (theta1List.length === 0 || theta2List.length === 0) continue;

          const minT1 = Math.min(...theta1List);
          const maxT1 = Math.max(...theta1List);
          const minT2 = Math.min(...theta2List);
          const maxT2 = Math.max(...theta2List);

          const minDeflectionRad = Math.max(0, minT2 - maxT1, minT1 - maxT2);

          if (minDeflectionRad <= deltaMaxRad + 1e-4) {
            satisfiesPair = true;
            break;
          }
        }
        if (satisfiesPair) break;
      }
      return satisfiesPair;
    } else if (inLinks.length > 0) {
      let satisfiesNeigh = false;
      for (const inLink of inLinks) {
        const srcInst = instMap.get(inLink.sourceInstanceId);
        if (!srcInst) continue;
        const nb = bodyMap.get(srcInst.bodyName);
        const envNb = activeInstanceEnvelopes[srcInst.id];
        if (!nb || !envNb || (envNb.minMs === 0 && envNb.maxMs === 0)) continue;

        const numSamplesIn: number = 30;
        for (let i = 0; i < numSamplesIn; i++) {
          const frac = numSamplesIn === 1 ? 0 : i / (numSamplesIn - 1);
          const vNb = envNb.minMs + frac * (envNb.maxMs - envNb.minMs);
          if (getTisserandIntersectionTheta(body, vInfMs, nb, vNb, mu_main) !== null) {
            satisfiesNeigh = true;
            break;
          }
        }
        if (satisfiesNeigh) break;
      }
      return satisfiesNeigh;
    } else if (outLinks.length > 0) {
      let satisfiesNeigh = false;
      for (const outLink of outLinks) {
        const tgtInst = instMap.get(outLink.targetInstanceId);
        if (!tgtInst) continue;
        const nb = bodyMap.get(tgtInst.bodyName);
        const envNb = activeInstanceEnvelopes[tgtInst.id];
        if (!nb || !envNb || (envNb.minMs === 0 && envNb.maxMs === 0)) continue;

        const numSamplesOut: number = 30;
        for (let i = 0; i < numSamplesOut; i++) {
          const frac = numSamplesOut === 1 ? 0 : i / (numSamplesOut - 1);
          const vNb = envNb.minMs + frac * (envNb.maxMs - envNb.minMs);
          if (getTisserandIntersectionTheta(body, vInfMs, nb, vNb, mu_main) !== null) {
            satisfiesNeigh = true;
            break;
          }
        }
        if (satisfiesNeigh) break;
      }
      return satisfiesNeigh;
    }

    return true;
  };

  let changed = true;
  let passCount = 0;
  const maxPasses = 100;

  while (changed && passCount < maxPasses) {
    changed = false;
    passCount++;

    const sweepOrder = passCount % 2 === 1
      ? [...instances]
      : [...instances].reverse();

    for (const inst of sweepOrder) {
      const prep = bodyPrepMap[inst.bodyName];
      if (!prep) continue;

      const curInstEnv = activeInstanceEnvelopes[inst.id];
      if (!curInstEnv || (curInstEnv.minMs === 0 && curInstEnv.maxMs === 0)) continue;

      const instPrevMinMs = curInstEnv.minMs;
      const instPrevMaxMs = curInstEnv.maxMs;

      const stepMs = 50;
      const coarseSamples: number[] = [];
      for (let v = curInstEnv.minMs; v < curInstEnv.maxMs; v += stepMs) {
        coarseSamples.push(v);
      }
      if (coarseSamples.length === 0 || coarseSamples[coarseSamples.length - 1] !== curInstEnv.maxMs) {
        coarseSamples.push(curInstEnv.maxMs);
      }

      const validCoarseIndices: number[] = [];
      for (let i = 0; i < coarseSamples.length; i++) {
        if (testInstanceVInfMsValid(inst, coarseSamples[i])) {
          validCoarseIndices.push(i);
        }
      }

      if (validCoarseIndices.length === 0) {
        for (let v = curInstEnv.minMs; v <= curInstEnv.maxMs; v += 10) {
          if (testInstanceVInfMsValid(inst, v)) {
            validCoarseIndices.push(0);
            break;
          }
        }
      }

      let newMinMs = 0;
      let newMaxMs = 0;

      if (validCoarseIndices.length > 0) {
        const firstValidIdx = validCoarseIndices[0];
        if (firstValidIdx === 0 && testInstanceVInfMsValid(inst, curInstEnv.minMs)) {
          newMinMs = curInstEnv.minMs;
        } else {
          let low = firstValidIdx > 0 ? coarseSamples[firstValidIdx - 1] : curInstEnv.minMs;
          let high = coarseSamples[firstValidIdx];
          while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            if (testInstanceVInfMsValid(inst, mid)) {
              high = mid;
            } else {
              low = mid;
            }
          }
          newMinMs = high;
        }

        const lastValidIdx = validCoarseIndices[validCoarseIndices.length - 1];
        if (lastValidIdx === coarseSamples.length - 1 && testInstanceVInfMsValid(inst, curInstEnv.maxMs)) {
          newMaxMs = curInstEnv.maxMs;
        } else {
          let low = coarseSamples[lastValidIdx];
          let high = lastValidIdx < coarseSamples.length - 1 ? coarseSamples[lastValidIdx + 1] : curInstEnv.maxMs;
          while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            if (testInstanceVInfMsValid(inst, mid)) {
              low = mid;
            } else {
              high = mid;
            }
          }
          newMaxMs = low;
        }
      }

      if (newMinMs > newMaxMs) {
        newMinMs = 0;
        newMaxMs = 0;
      }

      if (Math.abs(newMinMs - instPrevMinMs) >= 1 || Math.abs(newMaxMs - instPrevMaxMs) >= 1) {
        activeInstanceEnvelopes[inst.id] = { minMs: newMinMs, maxMs: newMaxMs };
        changed = true;
      }
    }
  }

  return activeInstanceEnvelopes;
}

/**
 * Computes and updates gray C3 range indication (computedMinC3, computedMaxC3) for each instance node
 * using the exact Tisserand 3-body envelope propagation algorithm.
 */
export function propagateC3Bounds(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody
): InstanceNode[] {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);

  return instances.map(inst => {
    const env = envs[inst.id];
    const hasIncoming = links.some(l => l.targetInstanceId === inst.id);
    const hasOutgoing = links.some(l => l.sourceInstanceId === inst.id);
    const isPureFlyby = hasIncoming && hasOutgoing && !inst.isSourceOverride;

    if (!env || (env.minMs === 0 && env.maxMs === 0)) {
      return {
        ...inst,
        computedMinC3: 0,
        computedMaxC3: !isPureFlyby ? (inst.maxC3 ?? 0) : 0,
      };
    }

    const minKms = env.minMs / 1000;
    const maxKms = env.maxMs / 1000;

    let minC3 = minKms * minKms;
    let maxC3 = maxKms * maxKms;

    if (!isPureFlyby && inst.maxC3 !== undefined) {
      maxC3 = Math.min(maxC3, inst.maxC3);
      if (minC3 > maxC3) minC3 = 0;
    }

    const finalMinC3 = Math.round(Math.max(0, minC3) * 10) / 10;
    const finalMaxC3 = Math.round(Math.max(finalMinC3, maxC3) * 10) / 10;

    return {
      ...inst,
      computedMinC3: finalMinC3,
      computedMaxC3: finalMaxC3,
    };
  });
}


/**
 * STEP 2: Determine list of candidate flyby dates for each link end
 * Length N >= max(3, ceil((max_date - min_date) / orbital_period * SAMPLE_PER_PERIOD))
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
    if (src?.dateSampleCount !== undefined) {
      departureSampleCount = src.dateSampleCount;
    } else if (src?.validFlybyDates && src.validFlybyDates.length > 0) {
      departureSampleCount = src.validFlybyDates.length;
    } else {
      const srcMinDate = src?.minDate ?? src?.computedMinDate ?? 0;
      const srcMaxDate = src?.maxDate ?? src?.computedMaxDate ?? srcMinDate + 31536000;
      const srcPeriod = srcBody ? getOrbitalPeriod(srcBody, mainBody) : 31536000;
      const srcRawN = Math.ceil(((srcMaxDate - srcMinDate) / Math.max(1, srcPeriod)) * SAMPLE_PER_PERIOD);
      departureSampleCount = Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, srcRawN));
    }

    let arrivalSampleCount: number;
    if (tgt?.dateSampleCount !== undefined) {
      arrivalSampleCount = tgt.dateSampleCount;
    } else if (tgt?.validFlybyDates && tgt.validFlybyDates.length > 0) {
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
  if (srcInstance.dateSampleCount !== undefined) {
    const srcMin = srcInstance.minDate ?? srcInstance.computedMinDate ?? 0;
    const srcMax = srcInstance.maxDate ?? srcInstance.computedMaxDate ?? srcMin + 31536000;
    const nDep = Math.max(1, srcInstance.dateSampleCount);
    srcDates = [];
    if (nDep === 1) {
      srcDates.push((srcMin + srcMax) / 2);
    } else {
      const stepDep = (srcMax - srcMin) / (nDep - 1);
      for (let i = 0; i < nDep; i++) {
        srcDates.push(srcMin + i * stepDep);
      }
    }
  } else if (srcInstance.validFlybyDates && srcInstance.validFlybyDates.length > 0) {
    srcDates = srcInstance.validFlybyDates;
  } else {
    const srcMin = srcInstance.minDate ?? srcInstance.computedMinDate ?? 0;
    const srcMax = srcInstance.maxDate ?? srcInstance.computedMaxDate ?? srcMin + 31536000;
    const nDep = link.departureSampleCount || 10;
    srcDates = [];
    if (nDep === 1) {
      srcDates.push((srcMin + srcMax) / 2);
    } else {
      const stepDep = (srcMax - srcMin) / Math.max(1, nDep - 1);
      for (let i = 0; i < nDep; i++) {
        srcDates.push(srcMin + i * stepDep);
      }
    }
  }

  let tgtDates: number[];
  if (tgtInstance.dateSampleCount !== undefined) {
    const tgtMin = tgtInstance.minDate ?? tgtInstance.computedMinDate ?? 0;
    const tgtMax = tgtInstance.maxDate ?? tgtInstance.computedMaxDate ?? tgtMin + 31536000;
    const nArr = Math.max(1, tgtInstance.dateSampleCount);
    tgtDates = [];
    if (nArr === 1) {
      tgtDates.push((tgtMin + tgtMax) / 2);
    } else {
      const stepArr = (tgtMax - tgtMin) / (nArr - 1);
      for (let j = 0; j < nArr; j++) {
        tgtDates.push(tgtMin + j * stepArr);
      }
    }
  } else if (tgtInstance.validFlybyDates && tgtInstance.validFlybyDates.length > 0) {
    tgtDates = tgtInstance.validFlybyDates;
  } else {
    const tgtMin = tgtInstance.minDate ?? tgtInstance.computedMinDate ?? 0;
    const tgtMax = tgtInstance.maxDate ?? tgtInstance.computedMaxDate ?? tgtMin + 31536000;
    const nArr = link.arrivalSampleCount || 10;
    tgtDates = [];
    if (nArr === 1) {
      tgtDates.push((tgtMin + tgtMax) / 2);
    } else {
      const stepArr = (tgtMax - tgtMin) / Math.max(1, nArr - 1);
      for (let j = 0; j < nArr; j++) {
        tgtDates.push(tgtMin + j * stepArr);
      }
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
    if (inst.dateSampleCount !== undefined) {
      const minD = inst.minDate ?? inst.computedMinDate ?? 0;
      const maxD = inst.maxDate ?? inst.computedMaxDate ?? minD + 31536000;
      const samples = Math.max(1, inst.dateSampleCount);
      const validFlybyDates: number[] = [];
      if (samples === 1) {
        validFlybyDates.push((minD + maxD) / 2);
      } else {
        const step = (maxD - minD) / (samples - 1);
        for (let i = 0; i < samples; i++) {
          validFlybyDates.push(minD + i * step);
        }
      }
      return {
        ...inst,
        validFlybyDates
      };
    }

    const incoming = links.filter(l => l.targetInstanceId === inst.id);
    const outgoing = links.filter(l => l.sourceInstanceId === inst.id);

    if (incoming.length === 0 && outgoing.length === 0) {
      return inst;
    }

    const minD = inst.minDate ?? inst.computedMinDate ?? 0;
    const maxD = inst.maxDate ?? inst.computedMaxDate ?? minD + 31536000;

    const body = bodyMap.get(inst.bodyName);
    const period = (body && mainBody) ? getOrbitalPeriod(body, mainBody) : 9203545;
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
 * Generates hierarchical interlaced pass steps (16, 8, 4, 2, 1)
 * to evaluate grid points in progressive refinement order.
 */
export function getHierarchicalGridIndices(nRows: number, nCols: number): { pass: number; step: number; points: [number, number][] }[] {
  const evaluated = Array.from({ length: nRows }, () => new Uint8Array(nCols));
  const passes: { pass: number; step: number; points: [number, number][] }[] = [];

  const steps = [16, 8, 4, 2, 1];

  for (let p = 0; p < steps.length; p++) {
    const step = steps[p];
    const points: [number, number][] = [];

    for (let i = 0; i < nRows; i++) {
      const isIKey = (i % step === 0) || (i === nRows - 1);
      if (!isIKey) continue;

      for (let j = 0; j < nCols; j++) {
        const isJKey = (j % step === 0) || (j === nCols - 1);
        if (!isJKey) continue;

        if (evaluated[i][j] === 0) {
          evaluated[i][j] = 1;
          points.push([i, j]);
        }
      }
    }

    if (points.length > 0) {
      passes.push({ pass: p, step, points });
    }
  }

  return passes;
}

const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

export function shallowClonePorkchopData(pcData: PorkchopPlotData): PorkchopPlotData {
  return {
    ...pcData,
    computedSamples: pcData.computedSamples,
    totalSamples: pcData.totalSamples,
  };
}

export function clonePorkchopData(pcData: PorkchopPlotData): PorkchopPlotData {
  return {
    ...pcData,
    computedSamples: pcData.computedSamples,
    totalSamples: pcData.totalSamples,
    c3DepMatrix: pcData.c3DepMatrix.map(row => [...row]),
    c3ArrMatrix: pcData.c3ArrMatrix.map(row => [...row]),
    dvMatrix: pcData.dvMatrix.map(row => [...row]),
    flightTimeMatrix: pcData.flightTimeMatrix.map(row => [...row]),
    validMatrix: pcData.validMatrix.map(row => [...row]),
    vTransDepMatrix: pcData.vTransDepMatrix.map(row => [...row]),
    vTransArrMatrix: pcData.vTransArrMatrix.map(row => [...row]),
  };
}

/**
 * STEP 5: Compute Porkchop Plot for a given link using progressive interlaced passes.
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
  const totalPoints = nDep * nArr;

  const c3DepMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const c3ArrMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const dvMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const flightTimeMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(0));
  const validMatrix: boolean[][] = Array.from({ length: nDep }, () => Array(nArr).fill(false));
  const vTransDepMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({ x: 0, y: 0, z: 0 }));
  const vTransArrMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({ x: 0, y: 0, z: 0 }));

  const muCentral = mainBody.stdGravParam || 1e12;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

  // Precompute body states once for all departure and arrival dates (400x speedup)
  const srcStates = srcDates.map(t => getBodyStateAtUT(srcBody, mainBody, t));
  const tgtStates = tgtDates.map(t => getBodyStateAtUT(tgtBody, mainBody, t));

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
    vTransArrMatrix,
    computedSamples: 0,
    totalSamples: totalPoints
  };

  // Immediate update to open window instantly with initial blank grid
  onPartialUpdatePorkchop?.(shallowClonePorkchopData(pcData), 0);
  await yieldUI();

  let validCount = 0;
  let computedPointsCount = 0;
  let lastYieldTime = performance.now();
  let lastUpdateDataTime = performance.now();

  const passes = getHierarchicalGridIndices(nDep, nArr);
  const evaluated = Array.from({ length: nDep }, () => new Uint8Array(nArr));

  for (const pass of passes) {
    if (shouldStop?.()) break;

    const S = pass.step;
    for (const [i, j] of pass.points) {
      if (shouldStop?.()) break;

      evaluated[i][j] = 1;
      computedPointsCount++;

      const depDate = srcDates[i];
      const arrDate = tgtDates[j];
      const dt = arrDate - depDate;

      flightTimeMatrix[i][j] = dt;

      const minDur = link.minFlightDuration ?? 0;
      const maxDur = link.maxFlightDuration ?? 1e10;

      let passC3 = false;
      let c3Dep = Infinity;
      let c3Arr = Infinity;
      let dv = Infinity;
      let v1 = { x: 0, y: 0, z: 0 };
      let v2 = { x: 0, y: 0, z: 0 };

      if (dt >= minDur && dt <= maxDur) {
        const srcState = srcStates[i];
        const tgtState = tgtStates[j];

        // Use fast direct Lambert solver (0-revolution) first for high-throughput grid calculation
        const sol = solveLambert(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius);

        if (sol.isValid) {
          v1 = sol.v1;
          v2 = sol.v2;

          const vInfDep = vecSub(sol.v1, srcState.vel);
          const vInfArr = vecSub(sol.v2, tgtState.vel);

          const vInfDepMag = vecMag(vInfDep);
          const vInfArrMag = vecMag(vInfArr);

          c3Dep = (vInfDepMag * vInfDepMag) / 1e6;
          c3Arr = (vInfArrMag * vInfArrMag) / 1e6;
          dv = vInfDepMag + vInfArrMag;

          const passSrcC3 = (srcInstance.maxC3 === undefined || c3Dep <= srcInstance.maxC3) &&
                            (srcInstance.computedMinC3 === undefined || c3Dep >= srcInstance.computedMinC3 - 0.05) &&
                            (srcInstance.computedMaxC3 === undefined || c3Dep <= srcInstance.computedMaxC3 + 0.05);

          const passTgtC3 = (tgtInstance.maxC3 === undefined || c3Arr <= tgtInstance.maxC3) &&
                            (tgtInstance.computedMinC3 === undefined || c3Arr >= tgtInstance.computedMinC3 - 0.05) &&
                            (tgtInstance.computedMaxC3 === undefined || c3Arr <= tgtInstance.computedMaxC3 + 0.05);

          passC3 = passSrcC3 && passTgtC3;
        }
      }

      vTransDepMatrix[i][j] = v1;
      vTransArrMatrix[i][j] = v2;
      c3DepMatrix[i][j] = c3Dep;
      c3ArrMatrix[i][j] = c3Arr;
      dvMatrix[i][j] = dv;
      validMatrix[i][j] = passC3;
      if (passC3) validCount++;

      // Preview block fill for unvisited neighbor cells
      for (let di = 0; di < S && i + di < nDep; di++) {
        const r = i + di;
        for (let dj = 0; dj < S && j + dj < nArr; dj++) {
          const c = j + dj;
          if (evaluated[r][c] === 0) {
            vTransDepMatrix[r][c] = v1;
            vTransArrMatrix[r][c] = v2;
            c3DepMatrix[r][c] = c3Dep;
            c3ArrMatrix[r][c] = c3Arr;
            dvMatrix[r][c] = dv;
            validMatrix[r][c] = passC3;
            flightTimeMatrix[r][c] = tgtDates[c] - srcDates[r];
          }
        }
      }

      const now = performance.now();
      // Yield execution every 25ms so the browser event loop remains responsive
      if (now - lastYieldTime > 25) {
        lastYieldTime = now;
        // Throttle UI updates to every 120ms (smooth ~8 FPS updates without deep cloning overhead)
        if (now - lastUpdateDataTime > 10000) {
          lastUpdateDataTime = now;
          pcData.computedSamples = computedPointsCount;
          pcData.totalSamples = totalPoints;
          const pct = Math.floor((computedPointsCount / totalPoints) * 100);
          onProgress?.(
            `Computing ${srcInstance.bodyName}-${tgtInstance.bodyName} porkchop plot (${pct}%, ${validCount} valid transfers)...`
          );
          onPartialUpdatePorkchop?.(shallowClonePorkchopData(pcData), validCount);
        }
        await yieldUI();
      }
    }

    pcData.computedSamples = computedPointsCount;
    pcData.totalSamples = totalPoints;
    onPartialUpdatePorkchop?.(shallowClonePorkchopData(pcData), validCount);
    await yieldUI();
  }

  pcData.computedSamples = computedPointsCount;
  pcData.totalSamples = totalPoints;
  const finalResult = shallowClonePorkchopData(pcData);
  onPartialUpdatePorkchop?.(finalResult, validCount);
  return finalResult;
}

/**
 * Evaluates the optimal transfer across intermediate flyby bodies for a given departure (tDep) and arrival (tArr).
 */
function evaluateSequenceTransferForDates(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  porkchops?: Record<string, PorkchopPlotData>
): {
  c3DepA: number;
  c3ArrFinal: number;
  totalDv: number;
  flybyDvs: number[];
  flybyDates: number[];
  c3ArrB?: number;
  c3DepB?: number;
  c3ArrC?: number;
  c3DepC?: number;
} | null {
  const N = pathInsts.length;
  if (N < 3) return null;

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const srcInst = pathInsts[0];
  const tgtInst = pathInsts[N - 1];
  const flybyInsts = pathInsts.slice(1, N - 1);

  const srcBody = bodyMap.get(srcInst.bodyName) || mainBody;
  const tgtBody = bodyMap.get(tgtInst.bodyName) || mainBody;
  const muCentral = mainBody.stdGravParam || 1e12;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

  const stA = getBodyStateAtUT(srcBody, mainBody, tDep);
  const stTgt = getBodyStateAtUT(tgtBody, mainBody, tArr);

  if (N === 3) {
    const flybyInst = flybyInsts[0];
    const flybyBody = bodyMap.get(flybyInst.bodyName) || mainBody;

    const candidateDates = new Set<number>();
    const FLYBY_SAMPLES = 20;
    const totalDt = tArr - tDep;
    const step = totalDt / (FLYBY_SAMPLES + 1);

    for (let k = 1; k <= FLYBY_SAMPLES; k++) {
      candidateDates.add(tDep + k * step);
    }
    if (flybyInst.validFlybyDates) {
      for (const vf of flybyInst.validFlybyDates) {
        if (vf > tDep + 3600 && vf < tArr - 3600) candidateDates.add(vf);
      }
    }

    const candList = Array.from(candidateDates).sort((a, b) => a - b);

    let minDv = Infinity;
    let bestChoice: {
      c3DepA: number;
      c3ArrB: number;
      c3DepB: number;
      c3ArrC: number;
      totalDv: number;
      flybyDvs: number[];
      flybyDates: number[];
    } | null = null;

    for (const tFlybyB of candList) {
      const dt1 = tFlybyB - tDep;
      const dt2 = tArr - tFlybyB;
      if (dt1 <= 3600 || dt2 <= 3600) continue;

      const stB = getBodyStateAtUT(flybyBody, mainBody, tFlybyB);

      let sols1 = [solveLambert(stA.pos, stB.pos, dt1, muCentral, true, minAllowedRadius)];
      if (!sols1[0].isValid) {
        sols1 = solveLambertAllRevolutions(stA.pos, stB.pos, dt1, muCentral, true, minAllowedRadius);
      }
      if (sols1.length === 0 || !sols1[0].isValid) continue;

      let sols2 = [solveLambert(stB.pos, stTgt.pos, dt2, muCentral, true, minAllowedRadius)];
      if (!sols2[0].isValid) {
        sols2 = solveLambertAllRevolutions(stB.pos, stTgt.pos, dt2, muCentral, true, minAllowedRadius);
      }
      if (sols2.length === 0 || !sols2[0].isValid) continue;

      for (const sol1 of sols1) {
        for (const sol2 of sols2) {
          const vInfDepA = vecSub(sol1.v1, stA.vel);
          const vInfInB = vecSub(sol1.v2, stB.vel);
          const vInfOutB = vecSub(sol2.v1, stB.vel);
          const vInfArrC = vecSub(sol2.v2, stTgt.vel);

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
          if (srcInst.computedMinC3 !== undefined && c3DepA < srcInst.computedMinC3 - 0.05) continue;
          if (srcInst.computedMaxC3 !== undefined && c3DepA > srcInst.computedMaxC3 + 0.05) continue;

          if (flybyInst.computedMinC3 !== undefined && (c3ArrB < flybyInst.computedMinC3 - 0.05 || c3DepB < flybyInst.computedMinC3 - 0.05)) continue;
          if (flybyInst.computedMaxC3 !== undefined && (c3ArrB > flybyInst.computedMaxC3 + 0.05 || c3DepB > flybyInst.computedMaxC3 + 0.05)) continue;

          if (tgtInst.maxC3 !== undefined && c3ArrC > tgtInst.maxC3) continue;
          if (tgtInst.computedMinC3 !== undefined && c3ArrC < tgtInst.computedMinC3 - 0.05) continue;
          if (tgtInst.computedMaxC3 !== undefined && c3ArrC > tgtInst.computedMaxC3 + 0.05) continue;

          if (evalRes.poweredDv < minDv) {
            minDv = evalRes.poweredDv;
            bestChoice = {
              c3DepA,
              c3ArrB,
              c3DepB,
              c3ArrC,
              totalDv: evalRes.poweredDv,
              flybyDvs: [evalRes.poweredDv],
              flybyDates: [tFlybyB],
            };
          }
        }
      }
    }

    if (!bestChoice) return null;
    return {
      c3DepA: bestChoice.c3DepA,
      c3ArrFinal: bestChoice.c3ArrC,
      totalDv: bestChoice.totalDv,
      flybyDvs: bestChoice.flybyDvs,
      flybyDates: bestChoice.flybyDates,
      c3ArrB: bestChoice.c3ArrB,
      c3DepB: bestChoice.c3DepB,
      c3ArrC: bestChoice.c3ArrC,
    };
  }

  if (N === 4) {
    const flyby1Inst = flybyInsts[0];
    const flyby2Inst = flybyInsts[1];
    const flyby1Body = bodyMap.get(flyby1Inst.bodyName) || mainBody;
    const flyby2Body = bodyMap.get(flyby2Inst.bodyName) || mainBody;

    const totalDt = tArr - tDep;
    const SAMPLES = 14;
    const step1 = totalDt / (SAMPLES + 1);

    const candBSet = new Set<number>();
    for (let k = 1; k <= SAMPLES; k++) candBSet.add(tDep + k * step1);
    if (flyby1Inst.validFlybyDates) {
      for (const vf of flyby1Inst.validFlybyDates) {
        if (vf > tDep + 3600 && vf < tArr - 7200) candBSet.add(vf);
      }
    }
    const candB = Array.from(candBSet).sort((a, b) => a - b);

    let minTotalDv = Infinity;
    let bestChoice: {
      c3DepA: number;
      c3ArrB: number;
      c3DepB: number;
      c3ArrC: number;
      c3DepC: number;
      c3ArrD: number;
      totalDv: number;
      flybyDvs: number[];
      flybyDates: number[];
    } | null = null;

    for (const tB of candB) {
      const dt1 = tB - tDep;
      if (dt1 <= 3600) continue;
      const stB = getBodyStateAtUT(flyby1Body, mainBody, tB);

      const sols1 = solveLambertAllRevolutions(stA.pos, stB.pos, dt1, muCentral, true, minAllowedRadius);
      if (sols1.length === 0) continue;

      const subDt = tArr - tB;
      const subStep = subDt / (SAMPLES + 1);
      const candCSet = new Set<number>();
      for (let m = 1; m <= SAMPLES; m++) candCSet.add(tB + m * subStep);
      if (flyby2Inst.validFlybyDates) {
        for (const vf of flyby2Inst.validFlybyDates) {
          if (vf > tB + 3600 && vf < tArr - 3600) candCSet.add(vf);
        }
      }
      const candC = Array.from(candCSet).sort((a, b) => a - b);

      for (const tC of candC) {
        const dt2 = tC - tB;
        const dt3 = tArr - tC;
        if (dt2 <= 3600 || dt3 <= 3600) continue;

        const stC = getBodyStateAtUT(flyby2Body, mainBody, tC);

        const sols2 = solveLambertAllRevolutions(stB.pos, stC.pos, dt2, muCentral, true, minAllowedRadius);
        if (sols2.length === 0) continue;

        const sols3 = solveLambertAllRevolutions(stC.pos, stTgt.pos, dt3, muCentral, true, minAllowedRadius);
        if (sols3.length === 0) continue;

        for (const sol1 of sols1) {
          for (const sol2 of sols2) {
            for (const sol3 of sols3) {
              const vInfDepA = vecSub(sol1.v1, stA.vel);
              const vInfInB = vecSub(sol1.v2, stB.vel);
              const vInfOutB = vecSub(sol2.v1, stB.vel);
              const vInfInC = vecSub(sol2.v2, stC.vel);
              const vInfOutC = vecSub(sol3.v1, stC.vel);
              const vInfArrD = vecSub(sol3.v2, stTgt.vel);

              const evalB = evaluateFlybyAtDate(flyby1Body, vInfInB, vInfOutB, tB, flyby1Inst.minFlybyRadius);
              if (evalB.flybyMargin < -1e-3) continue;

              const evalC = evaluateFlybyAtDate(flyby2Body, vInfInC, vInfOutC, tC, flyby2Inst.minFlybyRadius);
              if (evalC.flybyMargin < -1e-3) continue;

              const c3DepA = (vecMag(vInfDepA) ** 2) / 1e6;
              const c3ArrB = (evalB.vInfInMag ** 2) / 1e6;
              const c3DepB = (evalB.vInfOutMag ** 2) / 1e6;
              const c3ArrC = (evalC.vInfInMag ** 2) / 1e6;
              const c3DepC = (evalC.vInfOutMag ** 2) / 1e6;
              const c3ArrD = (vecMag(vInfArrD) ** 2) / 1e6;

              if (srcInst.maxC3 !== undefined && c3DepA > srcInst.maxC3) continue;
              if (srcInst.computedMinC3 !== undefined && c3DepA < srcInst.computedMinC3 - 0.05) continue;
              if (srcInst.computedMaxC3 !== undefined && c3DepA > srcInst.computedMaxC3 + 0.05) continue;

              if (flyby1Inst.computedMinC3 !== undefined && (c3ArrB < flyby1Inst.computedMinC3 - 0.05 || c3DepB < flyby1Inst.computedMinC3 - 0.05)) continue;
              if (flyby1Inst.computedMaxC3 !== undefined && (c3ArrB > flyby1Inst.computedMaxC3 + 0.05 || c3DepB > flyby1Inst.computedMaxC3 + 0.05)) continue;

              if (flyby2Inst.computedMinC3 !== undefined && (c3ArrC < flyby2Inst.computedMinC3 - 0.05 || c3DepC < flyby2Inst.computedMinC3 - 0.05)) continue;
              if (flyby2Inst.computedMaxC3 !== undefined && (c3ArrC > flyby2Inst.computedMaxC3 + 0.05 || c3DepC > flyby2Inst.computedMaxC3 + 0.05)) continue;

              if (tgtInst.maxC3 !== undefined && c3ArrD > tgtInst.maxC3) continue;
              if (tgtInst.computedMinC3 !== undefined && c3ArrD < tgtInst.computedMinC3 - 0.05) continue;
              if (tgtInst.computedMaxC3 !== undefined && c3ArrD > tgtInst.computedMaxC3 + 0.05) continue;

              const totDv = evalB.poweredDv + evalC.poweredDv;
              if (totDv < minTotalDv) {
                minTotalDv = totDv;
                bestChoice = {
                  c3DepA,
                  c3ArrB,
                  c3DepB,
                  c3ArrC,
                  c3DepC,
                  c3ArrD,
                  totalDv: totDv,
                  flybyDvs: [evalB.poweredDv, evalC.poweredDv],
                  flybyDates: [tB, tC],
                };
              }
            }
          }
        }
      }
    }

    if (!bestChoice) return null;
    return {
      c3DepA: bestChoice.c3DepA,
      c3ArrFinal: bestChoice.c3ArrD,
      totalDv: bestChoice.totalDv,
      flybyDvs: bestChoice.flybyDvs,
      flybyDates: bestChoice.flybyDates,
      c3ArrB: bestChoice.c3ArrB,
      c3DepB: bestChoice.c3DepB,
      c3ArrC: bestChoice.c3ArrC,
      c3DepC: bestChoice.c3DepC,
    };
  }

  // General N > 4
  let candidates: { times: number[]; totalDv: number; flybyDvs: number[] }[] = [
    { times: [tDep], totalDv: 0, flybyDvs: [] },
  ];

  for (let step = 0; step < flybyInsts.length; step++) {
    const currInst = pathInsts[step];
    const nextInst = pathInsts[step + 1];
    const nextBody = bodyMap.get(nextInst.bodyName) || mainBody;

    const newCandidates: { times: number[]; totalDv: number; flybyDvs: number[] }[] = [];

    for (const cand of candidates) {
      const tCurr = cand.times[cand.times.length - 1];
      const stCurr = getBodyStateAtUT(bodyMap.get(currInst.bodyName) || mainBody, mainBody, tCurr);

      const remSteps = N - 1 - (step + 1);
      const maxNextTime = tArr - remSteps * 86400;
      const minNextTime = tCurr + 86400;
      if (maxNextTime <= minNextTime) continue;

      const sampleDatesSet = new Set<number>();
      const SAMPLES = 16;
      const dtStep = (maxNextTime - minNextTime) / Math.max(1, SAMPLES - 1);
      for (let s = 0; s < SAMPLES; s++) {
        sampleDatesSet.add(minNextTime + s * dtStep);
      }
      if (nextInst.validFlybyDates) {
        for (const vf of nextInst.validFlybyDates) {
          if (vf > minNextTime && vf < maxNextTime) {
            sampleDatesSet.add(vf);
          }
        }
      }
      const sampleDates = Array.from(sampleDatesSet).sort((a, b) => a - b);

      for (const tNext of sampleDates) {
        const dtLeg = tNext - tCurr;
        if (dtLeg < 3600) continue;
        const stNext = getBodyStateAtUT(nextBody, mainBody, tNext);

        const sol = solveLambertBest(stCurr.pos, stNext.pos, dtLeg, muCentral, true, minAllowedRadius, stCurr.vel, stNext.vel);
        if (!sol.isValid) continue;

        let poweredDv = 0;
        if (step > 0) {
          const flybyInst = pathInsts[step];
          const flybyBody = bodyMap.get(flybyInst.bodyName) || mainBody;
          const prevTime = cand.times[cand.times.length - 2];
          const stPrev = getBodyStateAtUT(bodyMap.get(pathInsts[step - 1].bodyName) || mainBody, mainBody, prevTime);
          const solPrev = solveLambertBest(stPrev.pos, stCurr.pos, tCurr - prevTime, muCentral, true, minAllowedRadius, stPrev.vel, stCurr.vel);
          if (!solPrev.isValid) continue;

          const vInfIn = vecSub(solPrev.v2, stCurr.vel);
          const vInfOut = vecSub(sol.v1, stCurr.vel);

          const flybyEval = evaluateFlybyAtDate(
            flybyBody,
            vInfIn,
            vInfOut,
            tCurr,
            flybyInst.minFlybyRadius
          );

          if (flybyEval.flybyMargin < -100000) continue;
          poweredDv = flybyEval.poweredDv;
        }

        newCandidates.push({
          times: [...cand.times, tNext],
          totalDv: cand.totalDv + poweredDv,
          flybyDvs: [...cand.flybyDvs, poweredDv],
        });
      }
    }

    newCandidates.sort((a, b) => a.totalDv - b.totalDv);
    candidates = newCandidates.slice(0, 15);
  }

  let bestFinal: { times: number[]; totalDv: number; flybyDvs: number[]; c3DepA: number; c3ArrFinal: number } | null = null;
  let minTotalDv = Infinity;

  for (const cand of candidates) {
    if (cand.times.length !== N - 1) continue;
    const tLastFlyby = cand.times[cand.times.length - 1];
    const lastFlybyInst = pathInsts[N - 2];
    const lastFlybyBody = bodyMap.get(lastFlybyInst.bodyName) || mainBody;
    const stLast = getBodyStateAtUT(lastFlybyBody, mainBody, tLastFlyby);

    const solLeg1 = solveLambertBest(stA.pos, getBodyStateAtUT(bodyMap.get(pathInsts[1].bodyName) || mainBody, mainBody, cand.times[1]).pos, cand.times[1] - tDep, muCentral, true, minAllowedRadius, stA.vel);
    if (!solLeg1.isValid) continue;

    const solFinal = solveLambertBest(stLast.pos, stTgt.pos, tArr - tLastFlyby, muCentral, true, minAllowedRadius, stLast.vel, stTgt.vel);
    if (!solFinal.isValid) continue;

    const prevTime = cand.times[cand.times.length - 2];
    const stPrev = getBodyStateAtUT(bodyMap.get(pathInsts[N - 3].bodyName) || mainBody, mainBody, prevTime);
    const solPrev = solveLambertBest(stPrev.pos, stLast.pos, tLastFlyby - prevTime, muCentral, true, minAllowedRadius, stPrev.vel, stLast.vel);
    if (!solPrev.isValid) continue;

    const vInfIn = vecSub(solPrev.v2, stLast.vel);
    const vInfOut = vecSub(solFinal.v1, stLast.vel);

    const lastFlybyEval = evaluateFlybyAtDate(
      lastFlybyBody,
      vInfIn,
      vInfOut,
      tLastFlyby,
      lastFlybyInst.minFlybyRadius
    );
    if (lastFlybyEval.flybyMargin < -100000) continue;

    const allFlybyDvs = [...cand.flybyDvs.slice(1), lastFlybyEval.poweredDv];
    const totDv = allFlybyDvs.reduce((a, b) => a + b, 0);

    if (totDv < minTotalDv) {
      minTotalDv = totDv;
      const c3DepA = (vecMag(vecSub(solLeg1.v1, stA.vel)) ** 2) / 1e6;
      const c3ArrFinal = (vecMag(vecSub(solFinal.v2, stTgt.vel)) ** 2) / 1e6;
      bestFinal = {
        times: [...cand.times, tArr],
        totalDv: totDv,
        flybyDvs: allFlybyDvs,
        c3DepA,
        c3ArrFinal,
      };
    }
  }

  if (!bestFinal) return null;

  return {
    c3DepA: bestFinal.c3DepA,
    c3ArrFinal: bestFinal.c3ArrFinal,
    totalDv: bestFinal.totalDv,
    flybyDvs: bestFinal.flybyDvs,
    flybyDates: bestFinal.times.slice(1, N - 1),
  };
}

/**
 * Evaluates sequence transfer for a pair of departure/arrival dates using precomputed direct transfer porkchops.
 * NO Lambert calculations — parses direct transfer porkchop matrices and evaluates flybys.
 */
export function evaluateSequenceTransferFromDirectPorkchops(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = []
): {
  c3DepA: number;
  c3ArrB?: number;
  c3DepB?: number;
  c3ArrC?: number;
  c3DepC?: number;
  c3ArrFinal: number;
  totalDv: number;
  flybyDvs: number[];
  flybyDates: number[];
} | null {
  const N = pathInsts.length;
  if (N < 3) return null;

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // Find direct link porkchops for each leg
  const legPorkchops: PorkchopPlotData[] = [];
  for (let k = 0; k < N - 1; k++) {
    const srcInst = pathInsts[k];
    const tgtInst = pathInsts[k + 1];
    const link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === tgtInst.id);
    const linkId = link?.id || `link-${srcInst.id}-${tgtInst.id}`;
    const pc = porkchops[linkId];
    if (!pc || !pc.c3DepMatrix || pc.c3DepMatrix.length === 0) return null;
    legPorkchops.push(pc);
  }

  const P0 = legPorkchops[0];
  const P_last = legPorkchops[legPorkchops.length - 1];

  // Nearest departure row in P0
  let i0 = 0;
  let minDiffDep = Infinity;
  for (let i = 0; i < P0.depDates.length; i++) {
    const diff = Math.abs(P0.depDates[i] - tDep);
    if (diff < minDiffDep) {
      minDiffDep = diff;
      i0 = i;
    }
  }

  // Nearest arrival col in P_last
  let j_last = 0;
  let minDiffArr = Infinity;
  for (let j = 0; j < P_last.arrDates.length; j++) {
    const diff = Math.abs(P_last.arrDates[j] - tArr);
    if (diff < minDiffArr) {
      minDiffArr = diff;
      j_last = j;
    }
  }

  const muCentral = mainBody.stdGravParam || 1.32712440018e20;

  if (N === 3) {
    const P1 = legPorkchops[1];
    const flybyInst = pathInsts[1];
    const flybyBody = bodyMap.get(flybyInst.bodyName) || mainBody;
    const minFlybyRadius = flybyInst.minFlybyRadius ?? (1.1 * (flybyBody.radius + (flybyBody.atmosphereHeight || 0)));

    let bestDv = Infinity;
    let bestResult: {
      c3DepA: number;
      c3ArrB: number;
      c3DepB: number;
      c3ArrFinal: number;
      totalDv: number;
      flybyDvs: number[];
      flybyDates: number[];
    } | null = null;

    // Search across arrival dates at body B in P0
    for (let j0 = 0; j0 < P0.arrDates.length; j0++) {
      if (!P0.validMatrix[i0]?.[j0]) continue;

      const tFlyby = P0.arrDates[j0];

      // Find row in P1 closest to tFlyby
      let i1 = -1;
      let minDiffFlyby = 86400 * 5; // Within 5-day window
      for (let i = 0; i < P1.depDates.length; i++) {
        const diff = Math.abs(P1.depDates[i] - tFlyby);
        if (diff < minDiffFlyby) {
          minDiffFlyby = diff;
          i1 = i;
        }
      }
      if (i1 < 0) continue;
      if (!P1.validMatrix[i1]?.[j_last]) continue;

      const vTransArr0 = P0.vTransArrMatrix?.[i0]?.[j0];
      const vTransDep1 = P1.vTransDepMatrix?.[i1]?.[j_last];
      if (!vTransArr0 || !vTransDep1) continue;

      const stBody = getBodyStateAtUT(flybyBody, mainBody, tFlyby);
      const vInfIn = vecSub(vTransArr0, stBody.vel);
      const vInfOut = vecSub(vTransDep1, stBody.vel);

      const flybyEval = evaluateFlybyAtDate(flybyBody, vInfIn, vInfOut, tFlyby, minFlybyRadius);
      if (flybyEval.flybyMargin < -100000) continue;

      const c3DepA = P0.c3DepMatrix[i0][j0];
      const c3ArrB = P0.c3ArrMatrix[i0][j0];
      const c3DepB = P1.c3DepMatrix[i1][j_last];
      const c3ArrFinal = P1.c3ArrMatrix[i1][j_last];
      const totDv = flybyEval.poweredDv;

      if (totDv < bestDv) {
        bestDv = totDv;
        bestResult = {
          c3DepA,
          c3ArrB,
          c3DepB,
          c3ArrFinal,
          totalDv: totDv,
          flybyDvs: [flybyEval.poweredDv],
          flybyDates: [tFlyby],
        };
      }
    }

    return bestResult;
  }

  if (N === 4) {
    const P1 = legPorkchops[1];
    const P2 = legPorkchops[2];

    const fb1Inst = pathInsts[1];
    const fb2Inst = pathInsts[2];

    const fb1Body = bodyMap.get(fb1Inst.bodyName) || mainBody;
    const fb2Body = bodyMap.get(fb2Inst.bodyName) || mainBody;

    const minFb1Rad = fb1Inst.minFlybyRadius ?? (1.1 * (fb1Body.radius + (fb1Body.atmosphereHeight || 0)));
    const minFb2Rad = fb2Inst.minFlybyRadius ?? (1.1 * (fb2Body.radius + (fb2Body.atmosphereHeight || 0)));

    let bestDv = Infinity;
    let bestResult: {
      c3DepA: number;
      c3ArrB: number;
      c3DepB: number;
      c3ArrC: number;
      c3DepC: number;
      c3ArrFinal: number;
      totalDv: number;
      flybyDvs: number[];
      flybyDates: number[];
    } | null = null;

    for (let j0 = 0; j0 < P0.arrDates.length; j0++) {
      if (!P0.validMatrix[i0]?.[j0]) continue;
      const tFb1 = P0.arrDates[j0];

      let i1 = -1;
      let minDiff1 = 86400 * 5;
      for (let i = 0; i < P1.depDates.length; i++) {
        const diff = Math.abs(P1.depDates[i] - tFb1);
        if (diff < minDiff1) {
          minDiff1 = diff;
          i1 = i;
        }
      }
      if (i1 < 0) continue;

      for (let j1 = 0; j1 < P1.arrDates.length; j1++) {
        if (!P1.validMatrix[i1]?.[j1]) continue;
        const tFb2 = P1.arrDates[j1];

        let i2 = -1;
        let minDiff2 = 86400 * 5;
        for (let i = 0; i < P2.depDates.length; i++) {
          const diff = Math.abs(P2.depDates[i] - tFb2);
          if (diff < minDiff2) {
            minDiff2 = diff;
            i2 = i;
          }
        }
        if (i2 < 0) continue;
        if (!P2.validMatrix[i2]?.[j_last]) continue;

        const vTransArr0 = P0.vTransArrMatrix?.[i0]?.[j0];
        const vTransDep1 = P1.vTransDepMatrix?.[i1]?.[j1];
        const vTransArr1 = P1.vTransArrMatrix?.[i1]?.[j1];
        const vTransDep2 = P2.vTransDepMatrix?.[i2]?.[j_last];

        if (!vTransArr0 || !vTransDep1 || !vTransArr1 || !vTransDep2) continue;

        const stFb1 = getBodyStateAtUT(fb1Body, mainBody, tFb1);
        const stFb2 = getBodyStateAtUT(fb2Body, mainBody, tFb2);

        const vInfIn1 = vecSub(vTransArr0, stFb1.vel);
        const vInfOut1 = vecSub(vTransDep1, stFb1.vel);
        const eval1 = evaluateFlybyAtDate(fb1Body, vInfIn1, vInfOut1, tFb1, minFb1Rad);
        if (eval1.flybyMargin < -100000) continue;

        const vInfIn2 = vecSub(vTransArr1, stFb2.vel);
        const vInfOut2 = vecSub(vTransDep2, stFb2.vel);
        const eval2 = evaluateFlybyAtDate(fb2Body, vInfIn2, vInfOut2, tFb2, minFb2Rad);
        if (eval2.flybyMargin < -100000) continue;

        const totDv = eval1.poweredDv + eval2.poweredDv;

        if (totDv < bestDv) {
          bestDv = totDv;
          bestResult = {
            c3DepA: P0.c3DepMatrix[i0][j0],
            c3ArrB: P0.c3ArrMatrix[i0][j0],
            c3DepB: P1.c3DepMatrix[i1][j1],
            c3ArrC: P1.c3ArrMatrix[i1][j1],
            c3DepC: P2.c3DepMatrix[i2][j_last],
            c3ArrFinal: P2.c3ArrMatrix[i2][j_last],
            totalDv: totDv,
            flybyDvs: [eval1.poweredDv, eval2.poweredDv],
            flybyDates: [tFb1, tFb2],
          };
        }
      }
    }

    return bestResult;
  }

  return null;
}

/**
 * Unified Sequence Porkchop Plot solver for N-instance sequences (N >= 3).
 * Direct evaluation using precomputed direct transfer porkchops — NO Lambert calculations.
 */
export async function computeSequencePorkchopPlot(
  arg1: InstanceNode[] | InstanceNode,
  arg2: DirectionalLink[] | InstanceNode | CelestialBody[],
  arg3: CelestialBody[] | InstanceNode | CelestialBody,
  arg4?: CelestialBody | CelestialBody[] | ProgressCallback,
  arg5?: CelestialBody | ProgressCallback | ((seqPc: SequencePorkchopData) => void),
  arg6?: ProgressCallback | ((seqPc: SequencePorkchopData) => void) | (() => boolean),
  arg7?: ((seqPc: SequencePorkchopData) => void) | (() => boolean) | boolean,
  arg8?: (() => boolean) | boolean | DirectionalLink[],
  arg9?: boolean | Record<string, PorkchopPlotData>,
  arg10?: Record<string, PorkchopPlotData>
): Promise<SequencePorkchopData> {
  let pathInsts: InstanceNode[] = [];
  let links: DirectionalLink[] = [];
  let bodies: CelestialBody[] = [];
  let mainBody: CelestialBody;
  let onProgress: ProgressCallback | undefined;
  let onPartialUpdate: ((seqPc: SequencePorkchopData) => void) | undefined;
  let shouldStop: (() => boolean) | undefined;
  let isFullPath: boolean = false;
  let porkchops: Record<string, PorkchopPlotData> | undefined;

  if (Array.isArray(arg1)) {
    pathInsts = arg1;
    if (Array.isArray(arg3)) {
      links = Array.isArray(arg2) ? (arg2 as DirectionalLink[]) : [];
      bodies = arg3 as CelestialBody[];
      mainBody = arg4 as CelestialBody;
      onProgress = typeof arg5 === 'function' ? (arg5 as ProgressCallback) : undefined;
      onPartialUpdate = typeof arg6 === 'function' ? (arg6 as (seqPc: SequencePorkchopData) => void) : undefined;
      shouldStop = typeof arg7 === 'function' ? (arg7 as () => boolean) : undefined;
      isFullPath = typeof arg8 === 'boolean' ? arg8 : false;
      porkchops = (arg9 && typeof arg9 === 'object') ? (arg9 as Record<string, PorkchopPlotData>) : undefined;
    } else {
      links = Array.isArray(arg8) ? (arg8 as DirectionalLink[]) : [];
      bodies = Array.isArray(arg2) ? (arg2 as CelestialBody[]) : [];
      mainBody = arg3 as CelestialBody;
      onProgress = typeof arg4 === 'function' ? (arg4 as ProgressCallback) : undefined;
      onPartialUpdate = typeof arg5 === 'function' ? (arg5 as (seqPc: SequencePorkchopData) => void) : undefined;
      shouldStop = typeof arg6 === 'function' ? (arg6 as () => boolean) : undefined;
      isFullPath = typeof arg7 === 'boolean' ? arg7 : false;
      porkchops = (arg9 && typeof arg9 === 'object') ? (arg9 as Record<string, PorkchopPlotData>) : undefined;
    }
  } else {
    pathInsts = [arg1 as InstanceNode, arg2 as InstanceNode, arg3 as InstanceNode];
    links = [];
    bodies = Array.isArray(arg4) ? (arg4 as CelestialBody[]) : [];
    mainBody = arg5 as CelestialBody;
    onProgress = typeof arg6 === 'function' ? (arg6 as ProgressCallback) : undefined;
    onPartialUpdate = typeof arg7 === 'function' ? (arg7 as (seqPc: SequencePorkchopData) => void) : undefined;
    shouldStop = typeof arg8 === 'function' ? (arg8 as () => boolean) : undefined;
    isFullPath = typeof arg9 === 'boolean' ? arg9 : false;
    porkchops = (arg10 && typeof arg10 === 'object') ? (arg10 as Record<string, PorkchopPlotData>) : undefined;
  }

  if (typeof onProgress !== 'function') onProgress = undefined;
  if (typeof onPartialUpdate !== 'function') onPartialUpdate = undefined;
  if (typeof shouldStop !== 'function') shouldStop = undefined;

  const N = pathInsts.length;
  const porkchopsMap: Record<string, PorkchopPlotData> = { ...(porkchops || {}) };

  // Step 1: Ensure all direct transfer porkchops exist for each link in pathInsts
  for (let k = 0; k < N - 1; k++) {
    const srcInst = pathInsts[k];
    const tgtInst = pathInsts[k + 1];
    const link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === tgtInst.id);
    const linkId = link?.id || `link-${srcInst.id}-${tgtInst.id}`;

    let pc = porkchopsMap[linkId];
    if (!pc || !pc.c3DepMatrix || pc.c3DepMatrix.length === 0) {
      onProgress?.(`Computing Direct Transfer Porkchop for ${srcInst.bodyName} ➔ ${tgtInst.bodyName}...`);
      await yieldUI();
      if (shouldStop?.()) break;

      const dummyLink: DirectionalLink = link || {
        id: linkId,
        sourceInstanceId: srcInst.id,
        targetInstanceId: tgtInst.id,
      };

      pc = await computePorkchopPlot(dummyLink, srcInst, tgtInst, bodies, mainBody);
      porkchopsMap[linkId] = pc;
    }
  }

  const srcInst = pathInsts[0];
  const tgtInst = pathInsts[N - 1];
  const flybyInsts = pathInsts.slice(1, N - 1);

  // Use departure dates from P0 and arrival dates from P_last
  const P0_link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === pathInsts[1].id);
  const P0 = porkchopsMap[P0_link?.id || `link-${srcInst.id}-${pathInsts[1].id}`];

  const Plast_link = links.find(l => l.sourceInstanceId === pathInsts[N - 2].id && l.targetInstanceId === tgtInst.id);
  const Plast = porkchopsMap[Plast_link?.id || `link-${pathInsts[N - 2].id}-${tgtInst.id}`];

  const depDates: number[] = P0?.depDates || [];
  const arrDates: number[] = Plast?.arrDates || [];

  const N_DEP = depDates.length;
  const N_ARR = arrDates.length;

  const c3DepAMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3DepBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrCMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3DepCMatrix: number[][] | undefined = N >= 4 ? Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)) : undefined;
  const c3ArrDMatrix: number[][] | undefined = N >= 4 ? Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)) : undefined;
  const c3ArrFinalMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));

  const poweredDvBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const poweredDvCMatrix: number[][] | undefined = N >= 4 ? Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)) : undefined;
  const totalPoweredDvMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));

  const flybyDateMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const flyby2DateMatrix: number[][] | undefined = N >= 4 ? Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)) : undefined;
  const flightTimeMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const validMatrix: boolean[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(false));

  const flybyPoweredDvs = flybyInsts.map(inst => ({
    flybyBody: inst.bodyName,
    instanceId: inst.id,
    poweredDvMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)),
  }));

  const flybyDates = flybyInsts.map(inst => ({
    flybyBody: inst.bodyName,
    instanceId: inst.id,
    dateMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)),
  }));

  const seqId = `seq-pc-${pathInsts.map(i => i.id).join('-')}`;
  const seqLabel = pathInsts.map(i => i.bodyName).join(' ➔ ');

  const seqData: SequencePorkchopData = {
    id: seqId,
    sequenceLabel: seqLabel,
    isFullPath,
    instanceCount: N,
    instanceIds: pathInsts.map(i => i.id),
    bodyNames: pathInsts.map(i => i.bodyName),
    is4Body: N === 4,
    sourceInstanceId: srcInst.id,
    flybyInstanceId: flybyInsts[0]?.id || '',
    flyby2InstanceId: flybyInsts[1]?.id,
    targetInstanceId: tgtInst.id,
    sourceBody: srcInst.bodyName,
    flybyBody: flybyInsts[0]?.bodyName || '',
    flyby2Body: flybyInsts[1]?.bodyName,
    targetBody: tgtInst.bodyName,
    depDates,
    arrDates,
    c3DepAMatrix,
    c3ArrBMatrix,
    c3DepBMatrix,
    c3ArrCMatrix,
    c3DepCMatrix,
    c3ArrDMatrix,
    c3ArrFinalMatrix,
    poweredDvBMatrix,
    poweredDvCMatrix,
    totalPoweredDvMatrix,
    flybyDateMatrix,
    flyby2DateMatrix,
    flightTimeMatrix,
    validMatrix,
    flybyPoweredDvs,
    flybyDates,
  };

  // Emit immediate state so sequence viewer opens instantly
  onPartialUpdate?.({ ...seqData });

  const passes = getHierarchicalGridIndices(N_DEP, N_ARR);
  const evaluated = Array.from({ length: N_DEP }, () => new Uint8Array(N_ARR));

  let validCount = 0;
  let computedPointsCount = 0;
  let lastYieldTime = performance.now();

  for (const pass of passes) {
    if (shouldStop?.()) break;

    const S = pass.step;
    for (const [i, j] of pass.points) {
      if (shouldStop?.()) break;

      evaluated[i][j] = 1;
      computedPointsCount++;

      const tDep = depDates[i];
      const tArr = arrDates[j];
      const totalDt = tArr - tDep;
      flightTimeMatrix[i][j] = totalDt;

      const bestRes = totalDt >= 86400 * (N - 1)
        ? evaluateSequenceTransferFromDirectPorkchops(pathInsts, tDep, tArr, bodies, mainBody, porkchopsMap, links)
        : null;

      if (bestRes) {
        validMatrix[i][j] = true;
        c3DepAMatrix[i][j] = bestRes.c3DepA;
        c3ArrFinalMatrix[i][j] = bestRes.c3ArrFinal;
        totalPoweredDvMatrix[i][j] = bestRes.totalDv;

        if (N === 3) {
          c3ArrBMatrix[i][j] = bestRes.c3ArrB || 0;
          c3DepBMatrix[i][j] = bestRes.c3DepB || 0;
          c3ArrCMatrix[i][j] = bestRes.c3ArrFinal;
          poweredDvBMatrix[i][j] = bestRes.flybyDvs[0] || 0;
          flybyDateMatrix[i][j] = bestRes.flybyDates[0] || 0;
        } else if (N === 4) {
          c3ArrBMatrix[i][j] = bestRes.c3ArrB || 0;
          c3DepBMatrix[i][j] = bestRes.c3DepB || 0;
          if (c3ArrCMatrix) c3ArrCMatrix[i][j] = bestRes.c3ArrC || 0;
          if (c3DepCMatrix) c3DepCMatrix[i][j] = bestRes.c3DepC || 0;
          if (c3ArrDMatrix) c3ArrDMatrix[i][j] = bestRes.c3ArrFinal;
          poweredDvBMatrix[i][j] = bestRes.flybyDvs[0] || 0;
          if (poweredDvCMatrix) poweredDvCMatrix[i][j] = bestRes.flybyDvs[1] || 0;
          flybyDateMatrix[i][j] = bestRes.flybyDates[0] || 0;
          if (flyby2DateMatrix) flyby2DateMatrix[i][j] = bestRes.flybyDates[1] || 0;
        }

        for (let fb = 0; fb < flybyInsts.length; fb++) {
          if (flybyPoweredDvs[fb]) flybyPoweredDvs[fb].poweredDvMatrix[i][j] = bestRes.flybyDvs[fb] || 0;
          if (flybyDates[fb]) flybyDates[fb].dateMatrix[i][j] = bestRes.flybyDates[fb] || 0;
        }

        validCount++;
      }

      // Preview block fill for unvisited neighbor cells in current pass
      for (let di = 0; di < S && i + di < N_DEP; di++) {
        const r = i + di;
        for (let dj = 0; dj < S && j + dj < N_ARR; dj++) {
          const c = j + dj;
          if (evaluated[r][c] === 0) {
            flightTimeMatrix[r][c] = arrDates[c] - depDates[r];
            validMatrix[r][c] = !!bestRes;
            c3DepAMatrix[r][c] = bestRes?.c3DepA || 0;
            c3ArrFinalMatrix[r][c] = bestRes?.c3ArrFinal || 0;
            totalPoweredDvMatrix[r][c] = bestRes?.totalDv || 0;

            if (N === 3) {
              c3ArrBMatrix[r][c] = bestRes?.c3ArrB || 0;
              c3DepBMatrix[r][c] = bestRes?.c3DepB || 0;
              c3ArrCMatrix[r][c] = bestRes?.c3ArrFinal || 0;
              poweredDvBMatrix[r][c] = bestRes?.flybyDvs[0] || 0;
              flybyDateMatrix[r][c] = bestRes?.flybyDates[0] || 0;
            } else if (N === 4) {
              c3ArrBMatrix[r][c] = bestRes?.c3ArrB || 0;
              c3DepBMatrix[r][c] = bestRes?.c3DepB || 0;
              if (c3ArrCMatrix) c3ArrCMatrix[r][c] = bestRes?.c3ArrC || 0;
              if (c3DepCMatrix) c3DepCMatrix[r][c] = bestRes?.c3DepC || 0;
              if (c3ArrDMatrix) c3ArrDMatrix[r][c] = bestRes?.c3ArrFinal;
              poweredDvBMatrix[r][c] = bestRes?.flybyDvs[0] || 0;
              if (poweredDvCMatrix) poweredDvCMatrix[r][c] = bestRes?.flybyDvs[1] || 0;
              flybyDateMatrix[r][c] = bestRes?.flybyDates[0] || 0;
              if (flyby2DateMatrix) flyby2DateMatrix[r][c] = bestRes?.flybyDates[1] || 0;
            }

            for (let fb = 0; fb < flybyInsts.length; fb++) {
              if (flybyPoweredDvs[fb]) flybyPoweredDvs[fb].poweredDvMatrix[r][c] = bestRes?.flybyDvs[fb] || 0;
              if (flybyDates[fb]) flybyDates[fb].dateMatrix[r][c] = bestRes?.flybyDates[fb] || 0;
            }
          }
        }
      }

      const now = performance.now();
      if (now - lastYieldTime > 100) { // ~0.1Hz update frequency
        lastYieldTime = now;
        const totalPoints = N_DEP * N_ARR;
        const pct = Math.floor((computedPointsCount / totalPoints) * 100);
        onProgress?.(`Computing sequence porkchop plot for ${seqLabel} (${pct}%, ${validCount} valid)...`);
        onPartialUpdate?.({ ...seqData });
        await yieldUI();
      }
    }
  }

  onPartialUpdate?.({ ...seqData });
  return seqData;
}

export async function compute4BodySequencePorkchopPlot(
  srcInst: InstanceNode,
  flyby1Inst: InstanceNode,
  flyby2Inst: InstanceNode,
  tgtInst: InstanceNode,
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdate?: (partialSeq: SequencePorkchopData) => void,
  shouldStop?: () => boolean,
  isFullPath?: boolean
): Promise<SequencePorkchopData> {
  return computeSequencePorkchopPlot(
    [srcInst, flyby1Inst, flyby2Inst, tgtInst],
    [],
    bodies,
    mainBody,
    onProgress,
    onPartialUpdate,
    shouldStop,
    isFullPath
  );
}

export async function computeNBodySequencePorkchopPlot(
  pathInsts: InstanceNode[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdate?: (seqPc: SequencePorkchopData) => void,
  shouldStop?: () => boolean,
  isFullPath?: boolean,
  links?: DirectionalLink[],
  porkchops?: Record<string, PorkchopPlotData>
): Promise<SequencePorkchopData> {
  return computeSequencePorkchopPlot(
    pathInsts,
    links || [],
    bodies,
    mainBody,
    onProgress,
    onPartialUpdate,
    shouldStop,
    isFullPath,
    porkchops
  );
}

export type ProgressCallback = (statusMessage: string) => void;
export type PartialUpdateCallback = (update: {
  instances?: InstanceNode[];
  links?: DirectionalLink[];
  porkchops?: Record<string, PorkchopPlotData>;
  sequencePorkchops?: Record<string, SequencePorkchopData>;
}) => void;

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

  const startInstances = currInstances.filter(i => isInstanceSource(i, currLinks));
  const allPaths: DirectionalLink[][] = [];
  for (const startInst of startInstances) {
    allPaths.push(...findAllPaths(startInst.id, currLinks, currInstances));
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
    const paths = findAllPaths(startInst.id, currLinks, currInstances);

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

  // Step 8: Compute N-instance sequence porkchop plots for candidate sequences (N >= 3)
  const candidateSubPaths = findAllSubPathsInGraph(currLinks, currInstances);
  for (const cand of candidateSubPaths) {
    if (shouldStop?.()) return earlyReturn();
    // Auto-compute full paths during initial search execution
    if (cand.isFullPath) {
      if (!sequencePorkchops[cand.id]) {
        const seqPc = await computeNBodySequencePorkchopPlot(
          cand.pathInsts,
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
          shouldStop,
          cand.isFullPath
        );
        sequencePorkchops[seqPc.id] = seqPc;
      }
    }
  }

  return earlyReturn();
}

export function isInstanceSource(inst: InstanceNode, links: DirectionalLink[]): boolean {
  if (inst.isSourceOverride !== undefined) {
    return inst.isSourceOverride;
  }
  return !links.some(l => l.targetInstanceId === inst.id);
}

export function isInstanceTarget(inst: InstanceNode, links: DirectionalLink[]): boolean {
  if (inst.isTargetOverride !== undefined) {
    return inst.isTargetOverride;
  }
  return !links.some(l => l.sourceInstanceId === inst.id);
}

export function findAllPaths(
  currentId: string,
  links: DirectionalLink[],
  instances: InstanceNode[],
  currentPath: DirectionalLink[] = [],
  visitedInstances: Set<string> = new Set([currentId])
): DirectionalLink[][] {
  const outgoing = links.filter(l => l.sourceInstanceId === currentId);
  const foundPaths: DirectionalLink[][] = [];

  for (const link of outgoing) {
    const nextId = link.targetInstanceId;
    if (visitedInstances.has(nextId)) {
      continue; // Prevent infinite loops / cycles
    }

    const nextPath = [...currentPath, link];
    const nextInst = instances.find(i => i.id === nextId);

    // If nextInst is designated as a target (auto or explicit override), nextPath is a complete valid path
    if (nextInst && isInstanceTarget(nextInst, links)) {
      foundPaths.push(nextPath);
    }

    // Continue searching deeper along outgoing links
    const newVisited = new Set(visitedInstances);
    newVisited.add(nextId);
    const deeperPaths = findAllPaths(nextId, links, instances, nextPath, newVisited);
    foundPaths.push(...deeperPaths);
  }

  return foundPaths;
}

export interface CandidateSequencePath {
  id: string;
  sequenceLabel: string;
  count: number;
  pathInsts: InstanceNode[];
  isFullPath: boolean;
}

export function findAllSubPathsInGraph(
  links: DirectionalLink[],
  instances: InstanceNode[]
): CandidateSequencePath[] {
  const resultsMap = new Map<string, CandidateSequencePath>();

  function dfs(
    currentId: string,
    currentPathInsts: InstanceNode[],
    visitedIds: Set<string>
  ) {
    if (currentPathInsts.length >= 3) {
      const seqId = `seq-pc-${currentPathInsts.map(i => i.id).join('-')}`;
      if (!resultsMap.has(seqId)) {
        const startInst = currentPathInsts[0];
        const endInst = currentPathInsts[currentPathInsts.length - 1];
        const isFullPath = isInstanceSource(startInst, links) && isInstanceTarget(endInst, links);
        resultsMap.set(seqId, {
          id: seqId,
          sequenceLabel: currentPathInsts.map(i => i.bodyName).join(' ➔ '),
          count: currentPathInsts.length,
          pathInsts: currentPathInsts,
          isFullPath,
        });
      }
    }

    const outgoingLinks = links.filter(l => l.sourceInstanceId === currentId);
    for (const link of outgoingLinks) {
      const nextId = link.targetInstanceId;
      if (!visitedIds.has(nextId)) {
        const nextInst = instances.find(i => i.id === nextId);
        if (nextInst) {
          const nextVisited = new Set(visitedIds);
          nextVisited.add(nextId);
          dfs(nextId, [...currentPathInsts, nextInst], nextVisited);
        }
      }
    }
  }

  for (const startInst of instances) {
    dfs(startInst.id, [startInst], new Set([startInst.id]));
  }

  return Array.from(resultsMap.values());
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

/**
 * Alternative Sequence Search Algorithm ("Search possible sequences (another way)")
 * Directly searches multi-body trajectory sequences across all valid paths without grid pruning.
 * Computes flybys (including powered flyby maneuver delta-V if required).
 * Applies 100-day window filter: keeps global minimum fuel cost sequence + sequences at least 100 days later.
 * Sorts all matching sequences by sum(C3d, C3a, stocDv²).
 */
export async function runSequenceSearchAlt(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdate?: (partial: Partial<SolverProgress>) => void,
  shouldStop?: () => boolean
): Promise<SolverResult> {
  let currInstances = [...instances];
  let currLinks = [...links];
  const porkchops: Record<string, PorkchopPlotData> = {};
  const sequencePorkchops: Record<string, SequencePorkchopData> = {};

  const earlyReturn = (): SolverResult => ({
    updatedInstances: currInstances,
    updatedLinks: currLinks,
    porkchops,
    sequencePorkchops,
    sequences: []
  });

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // Step 1: Propagate date bounds
  onProgress?.('Propagating date bounds...');
  await yieldUI();
  if (shouldStop?.()) return earlyReturn();
  currInstances = propagateDateBounds(currInstances, currLinks);
  onPartialUpdate?.({ instances: currInstances, links: currLinks });

  // Step 2: Identify sequence paths
  const startInstances = currInstances.filter(i => isInstanceSource(i, currLinks));
  const allPaths: DirectionalLink[][] = [];
  for (const startInst of startInstances) {
    allPaths.push(...findAllPaths(startInst.id, currLinks, currInstances));
  }

  if (allPaths.length === 0) {
    onProgress?.('No complete sequence paths found.');
    return earlyReturn();
  }

  const allKeptSequences: FlyableSequenceResult[] = [];

  for (let pIdx = 0; pIdx < allPaths.length; pIdx++) {
    if (shouldStop?.()) return earlyReturn();
    const pathLinks = allPaths[pIdx];
    const pathInsts: InstanceNode[] = [];
    pathInsts.push(currInstances.find(i => i.id === pathLinks[0].sourceInstanceId)!);
    for (const l of pathLinks) {
      pathInsts.push(currInstances.find(i => i.id === l.targetInstanceId)!);
    }

    const pathStr = pathInsts.map(i => i.bodyName).join(' ➔ ');
    onProgress?.(`Searching trajectories for path ${pIdx + 1}/${allPaths.length}: ${pathStr}...`);
    await yieldUI();

    const srcInst = pathInsts[0];
    const t0Min = srcInst.computedMinDate !== undefined ? srcInst.computedMinDate : 0;
    const t0Max = srcInst.computedMaxDate !== undefined ? srcInst.computedMaxDate : t0Min + 3600 * 24 * 365 * 20;
    const dateRange = Math.max(3600 * 24 * 30, t0Max - t0Min);

    // Fine-grained departure dates sampling
    const numT0Samples = Math.min(100, Math.max(30, Math.floor(dateRange / (3600 * 24 * 20))));
    const stepT0 = dateRange / Math.max(1, numT0Samples - 1);

    const candidatesForPath: FlyableSequenceResult[] = [];

    const evaluatePathBranch = async (
      legIdx: number,
      tPrev: number,
      currentTransfers: LambertTransferResult[],
      currentFlybys: FlybyDetail[],
      currentSolPrev?: LambertSolution
    ) => {
      if (shouldStop?.()) return;

      if (legIdx === pathLinks.length) {
        // Reached target instance! Assemble sequence result
        const solFirst = currentTransfers[0].sol!;
        const solLast = currentTransfers[currentTransfers.length - 1].sol!;

        const depInstNode = pathInsts[0];
        const arrInstNode = pathInsts[pathInsts.length - 1];

        const depBody = bodyMap.get(depInstNode.bodyName) || mainBody;
        const arrBody = bodyMap.get(arrInstNode.bodyName) || mainBody;

        const depState = getBodyStateAtUT(depBody, mainBody, currentTransfers[0].depDate);
        const arrState = getBodyStateAtUT(arrBody, mainBody, tPrev);

        const vInfDepVec = vecSub(solFirst.v1, depState.vel);
        const vInfArrVec = vecSub(solLast.v2, arrState.vel);

        const depC3 = (vecMag(vInfDepVec) ** 2) / 1e6;
        const arrC3 = (vecMag(vInfArrVec) ** 2) / 1e6;

        if (depInstNode.maxC3 !== undefined && depC3 > depInstNode.maxC3) return;
        if (arrInstNode.maxC3 !== undefined && arrC3 > arrInstNode.maxC3) return;

        let totalStochasticDv = 0;
        currentFlybys.forEach(f => {
          totalStochasticDv += f.stochasticDv + (f.poweredDv || 0);
        });

        const seqResult: FlyableSequenceResult = {
          id: `seq-alt-${pathInsts.map(i => i.id).join('-')}-${Math.round(currentTransfers[0].depDate)}-${Math.round(tPrev)}-${candidatesForPath.length}`,
          instanceIds: pathInsts.map(i => i.id),
          bodyNames: pathInsts.map(i => i.bodyName),
          depDate: currentTransfers[0].depDate,
          arrDate: tPrev,
          totalFlightTime: tPrev - currentTransfers[0].depDate,
          depC3,
          arrC3,
          totalStochasticDv,
          totalDv: totalStochasticDv,
          transfers: currentTransfers,
          flybys: currentFlybys
        };

        candidatesForPath.push(seqResult);
        return;
      }

      const link = pathLinks[legIdx];
      const srcNode = pathInsts[legIdx];
      const tgtNode = pathInsts[legIdx + 1];

      const srcBody = bodyMap.get(srcNode.bodyName) || mainBody;
      const tgtBody = bodyMap.get(tgtNode.bodyName) || mainBody;

      const aSrc = srcBody.semiMajorAxis || 1e10;
      const aTgt = tgtBody.semiMajorAxis || 1e10;
      const aTrans = (aSrc + aTgt) / 2;
      const hohmannDur = Math.PI * Math.sqrt(Math.pow(aTrans, 3) / (mainBody.stdGravParam || 1e12));

      const minDur = link.minFlightDuration !== undefined ? link.minFlightDuration : Math.max(3600 * 24 * 5, hohmannDur * 0.15);
      const maxDur = link.maxFlightDuration !== undefined ? link.maxFlightDuration : Math.min(3600 * 24 * 365 * 30, hohmannDur * 3.0);

      const durRange = Math.max(3600 * 24 * 10, maxDur - minDur);
      const numDurSamples = Math.min(45, Math.max(15, Math.floor(durRange / (3600 * 24 * 20))));
      const durStep = durRange / Math.max(1, numDurSamples - 1);

      const stSrc = getBodyStateAtUT(srcBody, mainBody, tPrev);

      for (let dIdx = 0; dIdx < numDurSamples; dIdx++) {
        const dt = minDur + dIdx * durStep;
        const tCurr = tPrev + dt;

        if (tgtNode.computedMinDate !== undefined && tCurr < tgtNode.computedMinDate) continue;
        if (tgtNode.computedMaxDate !== undefined && tCurr > tgtNode.computedMaxDate) continue;

        const stTgt = getBodyStateAtUT(tgtBody, mainBody, tCurr);
        const sol = solveLambertBest(stSrc.pos, stTgt.pos, dt, mainBody.stdGravParam || 1e12, true, undefined, stSrc.vel, stTgt.vel);
        if (!sol.isValid) continue;

        let flybyDetail: FlybyDetail | undefined = undefined;

        if (legIdx > 0) {
          const vInfIn = vecSub(currentSolPrev!.v2, stSrc.vel);
          const vInfOut = vecSub(sol.v1, stSrc.vel);

          const flybyEval = evaluateFlybyAtDate(
            srcBody,
            vInfIn,
            vInfOut,
            tPrev,
            srcNode.minFlybyRadius
          );

          if (!flybyEval.isValid) continue;

          const c3In = (flybyEval.vInfInMag / 1000) ** 2;
          const c3Out = (flybyEval.vInfOutMag / 1000) ** 2;
          if (srcNode.computedMinC3 !== undefined && (c3In < srcNode.computedMinC3 - 0.05 || c3Out < srcNode.computedMinC3 - 0.05)) continue;
          if (srcNode.computedMaxC3 !== undefined && (c3In > srcNode.computedMaxC3 + 0.05 || c3Out > srcNode.computedMaxC3 + 0.05)) continue;

          flybyDetail = {
            bodyName: srcBody.name,
            instanceId: srcNode.id,
            flybyDate: tPrev,
            flybyDateSampling: 86400,
            periapsisAlt: flybyEval.periapsisAlt,
            flybyMargin: flybyEval.flybyMargin,
            deflectionAngle: flybyEval.deflectionAngleDeg,
            maxDeflectionAngle: flybyEval.maxDeflectionAngleDeg,
            stochasticDv: flybyEval.stochasticDv,
            poweredDv: flybyEval.poweredDv,
            vInfInMag: flybyEval.vInfInMag,
            vInfOutMag: flybyEval.vInfOutMag
          };
        }

        const vInfDepVec = vecSub(sol.v1, stSrc.vel);
        const vInfArrVec = vecSub(sol.v2, stTgt.vel);

        const c3Dep = (vecMag(vInfDepVec) ** 2) / 1e6;
        const c3Arr = (vecMag(vInfArrVec) ** 2) / 1e6;

        if (srcNode.maxC3 !== undefined && c3Dep > srcNode.maxC3) continue;
        if (srcNode.computedMinC3 !== undefined && c3Dep < srcNode.computedMinC3 - 0.05) continue;
        if (srcNode.computedMaxC3 !== undefined && c3Dep > srcNode.computedMaxC3 + 0.05) continue;

        if (tgtNode.maxC3 !== undefined && c3Arr > tgtNode.maxC3) continue;
        if (tgtNode.computedMinC3 !== undefined && c3Arr < tgtNode.computedMinC3 - 0.05) continue;
        if (tgtNode.computedMaxC3 !== undefined && c3Arr > tgtNode.computedMaxC3 + 0.05) continue;

        const transfer: LambertTransferResult = {
          linkId: link.id,
          sourceInstanceId: srcNode.id,
          targetInstanceId: tgtNode.id,
          depDate: tPrev,
          arrDate: tCurr,
          flightTime: dt,
          vInfDep: [vInfDepVec.x, vInfDepVec.y, vInfDepVec.z],
          vInfArr: [vInfArrVec.x, vInfArrVec.y, vInfArrVec.z],
          c3Dep: (vecMag(vInfDepVec) ** 2) / 1e6,
          c3Arr: (vecMag(vInfArrVec) ** 2) / 1e6,
          depAngle: 0,
          arrAngle: 0,
          transferOrbitSemiMajorAxis: sol.semiMajorAxis,
          vTransDep: [sol.v1.x, sol.v1.y, sol.v1.z],
          vTransArr: [sol.v2.x, sol.v2.y, sol.v2.z],
          isValid: true,
          sol
        };

        const nextTransfers = [...currentTransfers, transfer];
        const nextFlybys = flybyDetail ? [...currentFlybys, flybyDetail] : [...currentFlybys];

        await evaluatePathBranch(legIdx + 1, tCurr, nextTransfers, nextFlybys, sol);
      }
    };

    for (let s0 = 0; s0 < numT0Samples; s0++) {
      if (shouldStop?.()) break;
      const tDep0 = t0Min + s0 * stepT0;
      if (srcInst.computedMinDate !== undefined && tDep0 < srcInst.computedMinDate) continue;
      if (srcInst.computedMaxDate !== undefined && tDep0 > srcInst.computedMaxDate) continue;

      await evaluatePathBranch(0, tDep0, [], []);

      if (s0 % 10 === 0) {
        onProgress?.(`[${pathStr}] Sampling departure date ${s0 + 1}/${numT0Samples} - Found ${candidatesForPath.length} candidates...`);
        await yieldUI();
      }
    }

    // Apply 100-Day Window & Minimum Fuel Cost Filter
    if (candidatesForPath.length > 0) {
      candidatesForPath.sort((a, b) => a.depDate - b.depDate);

      let globalMinCandidate = candidatesForPath[0];
      let minScore = Infinity;
      candidatesForPath.forEach(c => {
        const score = c.depC3 + c.arrC3 + (c.totalStochasticDv / 1000) ** 2;
        if (score < minScore) {
          minScore = score;
          globalMinCandidate = c;
        }
      });

      const keptForPath: FlyableSequenceResult[] = [];
      let lastKeptDepDate = -Infinity;

      for (const cand of candidatesForPath) {
        const isGlobalMin = (cand.id === globalMinCandidate.id);
        const is100DaysLater = (cand.depDate >= lastKeptDepDate + 100 * 86400);

        if (isGlobalMin || is100DaysLater) {
          if (!keptForPath.some(k => k.id === cand.id)) {
            keptForPath.push(cand);
          }
          if (is100DaysLater) {
            lastKeptDepDate = cand.depDate;
          }
        }
      }

      allKeptSequences.push(...keptForPath);
    }
  }

  // Sort ALL kept sequence results by sum(C3d, C3a, stocDv²) ascending
  allKeptSequences.sort((a, b) => {
    const scoreA = a.depC3 + a.arrC3 + (a.totalStochasticDv / 1000) ** 2;
    const scoreB = b.depC3 + b.arrC3 + (b.totalStochasticDv / 1000) ** 2;
    return scoreA - scoreB;
  });

  onProgress?.(`Search completed! ${allKeptSequences.length} trajectory sequences evaluated and filtered.`);

  return {
    updatedInstances: currInstances,
    updatedLinks: currLinks,
    porkchops,
    sequencePorkchops,
    sequences: allKeptSequences
  };
}
