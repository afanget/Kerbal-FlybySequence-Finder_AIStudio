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
    if (inst.maxC3 !== undefined && inst.maxC3 > 0) {
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
    if (!env || (env.minMs === 0 && env.maxMs === 0)) {
      return {
        ...inst,
        computedMinC3: 0,
        computedMaxC3: inst.maxC3 ?? 0,
      };
    }

    const minKms = env.minMs / 1000;
    const maxKms = env.maxMs / 1000;

    let minC3 = minKms * minKms;
    let maxC3 = maxKms * maxKms;

    if (inst.maxC3 !== undefined) {
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

        // Check C3 constraints including gray C3 range
        const passSrcC3 = (srcInstance.maxC3 === undefined || c3Dep <= srcInstance.maxC3) &&
                          (srcInstance.computedMinC3 === undefined || c3Dep >= srcInstance.computedMinC3 - 0.05) &&
                          (srcInstance.computedMaxC3 === undefined || c3Dep <= srcInstance.computedMaxC3 + 0.05);

        const passTgtC3 = (tgtInstance.maxC3 === undefined || c3Arr <= tgtInstance.maxC3) &&
                          (tgtInstance.computedMinC3 === undefined || c3Arr >= tgtInstance.computedMinC3 - 0.05) &&
                          (tgtInstance.computedMaxC3 === undefined || c3Arr <= tgtInstance.computedMaxC3 + 0.05);

        const passC3 = passSrcC3 && passTgtC3;

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

  const N_DEP = srcInst.dateSampleCount !== undefined ? Math.max(1, srcInst.dateSampleCount) : 30;
  const N_ARR = tgtInst.dateSampleCount !== undefined ? Math.max(1, tgtInst.dateSampleCount) : 30;

  const depDates: number[] = [];
  if (N_DEP === 1) {
    depDates.push((minDepA + maxDepA) / 2);
  } else {
    const stepDep = (maxDepA - minDepA) / Math.max(1, N_DEP - 1);
    for (let i = 0; i < N_DEP; i++) {
      depDates.push(minDepA + i * stepDep);
    }
  }

  const arrDates: number[] = [];
  if (N_ARR === 1) {
    arrDates.push((minArrC + maxArrC) / 2);
  } else {
    const stepArr = (maxArrC - minArrC) / Math.max(1, N_ARR - 1);
    for (let j = 0; j < N_ARR; j++) {
      arrDates.push(minArrC + j * stepArr);
    }
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
        if (srcInst.computedMinC3 !== undefined && c3DepA < srcInst.computedMinC3 - 0.05) continue;
        if (srcInst.computedMaxC3 !== undefined && c3DepA > srcInst.computedMaxC3 + 0.05) continue;

        if (flybyInst.maxC3 !== undefined && (c3ArrB > flybyInst.maxC3 || c3DepB > flybyInst.maxC3)) continue;
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

export async function compute4BodySequencePorkchopPlot(
  srcInst: InstanceNode,
  flyby1Inst: InstanceNode,
  flyby2Inst: InstanceNode,
  tgtInst: InstanceNode,
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdate?: (partialSeq: SequencePorkchopData) => void,
  shouldStop?: () => boolean
): Promise<SequencePorkchopData> {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const srcBody = bodyMap.get(srcInst.bodyName) || mainBody;
  const flyby1Body = bodyMap.get(flyby1Inst.bodyName) || mainBody;
  const flyby2Body = bodyMap.get(flyby2Inst.bodyName) || mainBody;
  const tgtBody = bodyMap.get(tgtInst.bodyName) || mainBody;

  const muCentral = mainBody.stdGravParam || 1e12;

  const minDepA = srcInst.minDate ?? srcInst.computedMinDate ?? 0;
  const maxDepA = srcInst.maxDate ?? srcInst.computedMaxDate ?? (minDepA + 31536000);

  const minArrD = tgtInst.minDate ?? tgtInst.computedMinDate ?? (minDepA + 86400 * 60);
  const maxArrD = tgtInst.maxDate ?? tgtInst.computedMaxDate ?? (minArrD + 31536000 * 3);

  const N_DEP = srcInst.dateSampleCount !== undefined ? Math.max(1, srcInst.dateSampleCount) : 25;
  const N_ARR = tgtInst.dateSampleCount !== undefined ? Math.max(1, tgtInst.dateSampleCount) : 25;

  const depDates: number[] = [];
  if (N_DEP === 1) {
    depDates.push((minDepA + maxDepA) / 2);
  } else {
    const stepDep = (maxDepA - minDepA) / Math.max(1, N_DEP - 1);
    for (let i = 0; i < N_DEP; i++) {
      depDates.push(minDepA + i * stepDep);
    }
  }

  const arrDates: number[] = [];
  if (N_ARR === 1) {
    arrDates.push((minArrD + maxArrD) / 2);
  } else {
    const stepArr = (maxArrD - minArrD) / Math.max(1, N_ARR - 1);
    for (let j = 0; j < N_ARR; j++) {
      arrDates.push(minArrD + j * stepArr);
    }
  }

  const c3DepAMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3DepBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrCMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3DepCMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const c3ArrDMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const poweredDvBMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const poweredDvCMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const totalPoweredDvMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const flybyDateMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const flyby2DateMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const flightTimeMatrix: number[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0));
  const validMatrix: boolean[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(false));

  const seqId = `seq-pc-${srcInst.id}-${flyby1Inst.id}-${flyby2Inst.id}-${tgtInst.id}`;
  const seqLabel = `${srcInst.bodyName} ➔ ${flyby1Inst.bodyName} ➔ ${flyby2Inst.bodyName} ➔ ${tgtInst.bodyName}`;

  const seqData: SequencePorkchopData = {
    id: seqId,
    sequenceLabel: seqLabel,
    is4Body: true,
    sourceInstanceId: srcInst.id,
    flybyInstanceId: flyby1Inst.id,
    flyby2InstanceId: flyby2Inst.id,
    targetInstanceId: tgtInst.id,
    sourceBody: srcInst.bodyName,
    flybyBody: flyby1Inst.bodyName,
    flyby2Body: flyby2Inst.bodyName,
    targetBody: tgtInst.bodyName,
    depDates,
    arrDates,
    c3DepAMatrix,
    c3ArrBMatrix,
    c3DepBMatrix,
    c3ArrCMatrix,
    c3DepCMatrix,
    c3ArrDMatrix,
    poweredDvBMatrix,
    poweredDvCMatrix,
    totalPoweredDvMatrix,
    flybyDateMatrix,
    flyby2DateMatrix,
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
      const tArrD = arrDates[j];
      const totalDt = tArrD - tDepA;
      flightTimeMatrix[i][j] = totalDt;

      if (totalDt < 86400 * 2) continue;

      const stD = getBodyStateAtUT(tgtBody, mainBody, tArrD);

      const SAMPLES = 12;
      const flybyStep1 = totalDt / (SAMPLES + 1);
      const candB: number[] = [];
      for (let k = 1; k <= SAMPLES; k++) candB.push(tDepA + k * flybyStep1);
      if (flyby1Inst.validFlybyDates) {
        for (const vf of flyby1Inst.validFlybyDates) {
          if (vf > tDepA + 3600 && vf < tArrD - 7200) candB.push(vf);
        }
      }

      let minTotalDv = Infinity;
      let bestChoice: {
        c3DepA: number;
        c3ArrB: number;
        c3DepB: number;
        c3ArrC: number;
        c3DepC: number;
        c3ArrD: number;
        poweredDvB: number;
        poweredDvC: number;
        totalPoweredDv: number;
        flyby1Date: number;
        flyby2Date: number;
      } | null = null;

      for (const tB of candB) {
        const dt1 = tB - tDepA;
        if (dt1 <= 3600) continue;
        const stB = getBodyStateAtUT(flyby1Body, mainBody, tB);

        const sol1 = solveLambert(stA.pos, stB.pos, dt1, muCentral, true, minAllowedRadius);
        if (!sol1.isValid) continue;

        const candC: number[] = [];
        const subDt = tArrD - tB;
        const subStep = subDt / (SAMPLES + 1);
        for (let m = 1; m <= SAMPLES; m++) candC.push(tB + m * subStep);
        if (flyby2Inst.validFlybyDates) {
          for (const vf of flyby2Inst.validFlybyDates) {
            if (vf > tB + 3600 && vf < tArrD - 3600) candC.push(vf);
          }
        }

        for (const tC of candC) {
          const dt2 = tC - tB;
          const dt3 = tArrD - tC;
          if (dt2 <= 3600 || dt3 <= 3600) continue;

          const stC = getBodyStateAtUT(flyby2Body, mainBody, tC);

          const sol2 = solveLambert(stB.pos, stC.pos, dt2, muCentral, true, minAllowedRadius);
          if (!sol2.isValid) continue;

          const sol3 = solveLambert(stC.pos, stD.pos, dt3, muCentral, true, minAllowedRadius);
          if (!sol3.isValid) continue;

          const vInfDepA = vecSub(sol1.v1, stA.vel);
          const vInfInB = vecSub(sol1.v2, stB.vel);
          const vInfOutB = vecSub(sol2.v1, stB.vel);
          const vInfInC = vecSub(sol2.v2, stC.vel);
          const vInfOutC = vecSub(sol3.v1, stC.vel);
          const vInfArrD = vecSub(sol3.v2, stD.vel);

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

          if (flyby1Inst.maxC3 !== undefined && (c3ArrB > flyby1Inst.maxC3 || c3DepB > flyby1Inst.maxC3)) continue;
          if (flyby1Inst.computedMinC3 !== undefined && (c3ArrB < flyby1Inst.computedMinC3 - 0.05 || c3DepB < flyby1Inst.computedMinC3 - 0.05)) continue;
          if (flyby1Inst.computedMaxC3 !== undefined && (c3ArrB > flyby1Inst.computedMaxC3 + 0.05 || c3DepB > flyby1Inst.computedMaxC3 + 0.05)) continue;

          if (flyby2Inst.maxC3 !== undefined && (c3ArrC > flyby2Inst.maxC3 || c3DepC > flyby2Inst.maxC3)) continue;
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
              poweredDvB: evalB.poweredDv,
              poweredDvC: evalC.poweredDv,
              totalPoweredDv: totDv,
              flyby1Date: tB,
              flyby2Date: tC
            };
          }
        }
      }

      if (bestChoice) {
        c3DepAMatrix[i][j] = bestChoice.c3DepA;
        c3ArrBMatrix[i][j] = bestChoice.c3ArrB;
        c3DepBMatrix[i][j] = bestChoice.c3DepB;
        c3ArrCMatrix[i][j] = bestChoice.c3ArrC;
        c3DepCMatrix[i][j] = bestChoice.c3DepC;
        c3ArrDMatrix[i][j] = bestChoice.c3ArrD;
        poweredDvBMatrix[i][j] = bestChoice.poweredDvB;
        poweredDvCMatrix[i][j] = bestChoice.poweredDvC;
        totalPoweredDvMatrix[i][j] = bestChoice.totalPoweredDv;
        flybyDateMatrix[i][j] = bestChoice.flyby1Date;
        flyby2DateMatrix[i][j] = bestChoice.flyby2Date;
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

  // Step 8: Compute 3-instance & 4-instance sequence porkchop plots
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

  // 4-instance sequence porkchops for paths of length 3 links
  for (const startInst of startInstances) {
    if (shouldStop?.()) return earlyReturn();
    const paths = findAllPaths(startInst.id, currLinks, currInstances);
    for (const pathLinks of paths) {
      if (shouldStop?.()) return earlyReturn();
      if (pathLinks.length >= 3) {
        for (let k = 0; k <= pathLinks.length - 3; k++) {
          const l1 = pathLinks[k];
          const l2 = pathLinks[k + 1];
          const l3 = pathLinks[k + 2];
          const seq4Id = `seq-pc-${l1.sourceInstanceId}-${l1.targetInstanceId}-${l2.targetInstanceId}-${l3.targetInstanceId}`;
          if (!sequencePorkchops[seq4Id]) {
            const srcInst = currInstances.find(i => i.id === l1.sourceInstanceId);
            const flyby1Inst = currInstances.find(i => i.id === l1.targetInstanceId);
            const flyby2Inst = currInstances.find(i => i.id === l2.targetInstanceId);
            const tgtInst = currInstances.find(i => i.id === l3.targetInstanceId);

            if (srcInst && flyby1Inst && flyby2Inst && tgtInst) {
              const seqPc = await compute4BodySequencePorkchopPlot(
                srcInst,
                flyby1Inst,
                flyby2Inst,
                tgtInst,
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
        }
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
        const sol = solveLambert(stSrc.pos, stTgt.pos, dt, mainBody.stdGravParam || 1e12, true);
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
          if (srcNode.maxC3 !== undefined && (c3In > srcNode.maxC3 || c3Out > srcNode.maxC3)) continue;
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
