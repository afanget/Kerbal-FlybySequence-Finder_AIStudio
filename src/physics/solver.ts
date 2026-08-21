/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CelestialBody,
  OrbitalBody,
  InstanceNode,
  DirectionalLink,
  PorkchopPlotData,
  SequencePorkchopData,
  SubtaskProgressInfo,
  FlyableSequenceResult,
  FlybyDetail,
  Vector3D,
  LambertSolution,
  LambertTransferResult,
  SequencePorkchopFlybyData
} from '../types';
import { getBodyStateAtUT, getOrbitalPeriod, vecMag, vecDot, vecSub, vecScale, angleBetweenVecs } from './kepler';
import { solveLambert, solveLambertBest, solveLambertAllRevolutions } from './lambert';
import {
  matchUnpoweredFlyby,
  evaluateFlybyAtDate,
  computeMaxDeflectionAngle,
  computePeriapsisRadiusFromDeflection,
  computeFlybyStochasticDv,
  evaluateSequenceTransferFromDirectPorkchops,
  evaluateHigherOrderSequenceTransferAddLastLeg,
  evaluateHigherOrderSequenceTransferAddFirstLeg,
  SequenceTransferResult,
  SequenceTransferProfiler,
  KM_S_TO_M_S,
  KM2_S2_TO_M2_S2,
} from './flyby';
import { getMinFlybyRadius, getMinFlybyAlt } from '../data/solarSystems';

export {
  evaluateSequenceTransferFromDirectPorkchops,
  evaluateHigherOrderSequenceTransferAddLastLeg,
  evaluateHigherOrderSequenceTransferAddFirstLeg,
  SequenceTransferProfiler,
};
export type { SequenceTransferResult };

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
      const maxDur = link.maxFlightDuration ?? Infinity;

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
  bodyA: OrbitalBody,
  vInfA: number,
  bodyB: OrbitalBody,
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
 * This function calculates the minimum and maximum allowable incoming/outgoing velocity (v_infinity)
 * for each celestial body instance, ensuring compatibility with connected instances (flybys, arrivals, departures).
 *
 * @param instances - Array of mission instances (e.g., flybys, arrivals, departures).
 * @param links - Array of directional links between instances (e.g., trajectories).
 * @param bodies - Array of celestial bodies (e.g., planets, moons).
 * @param mainBody - The primary celestial body (e.g., the Sun) for gravitational calculations.
 * @returns A record mapping instance IDs to their { minMs, maxMs } velocity envelopes.
 */
export function computeTisserandEnvelopes(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: OrbitalBody[],
  mainBody: CelestialBody
): Record<string, { minMs: number; maxMs: number }> {

  // --- Step 1: Create lookup maps for instances and bodies for quick access ---
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // --- Step 2: Precompute body-specific parameters ---
  // For each body (except the main body), calculate:
  // - Minimum flyby radius (r_p_min): body radius + minimum altitude (from instances or atmosphere height)
  // - vInf5DegMs: Maximum v_infinity for a 5-degree deflection (derived from Tisserand's criterion)
  const bodyPrepMap: Record<string, {
    body: CelestialBody;
    r_p_min: number;
    vInf5DegMs: number;
  }> = {};

  // Initialize envelopes for active instances (default: { minMs: 0, maxMs: vInf5DegMs })
  const activeInstanceEnvelopes: Record<string, { minMs: number; maxMs: number }> = {};

  bodies.forEach(body => {
    if (body.name === mainBody.name) return; // Skip the main body

    const mu_b = body.stdGravParam; // Gravitational parameter of the body
    const R_b = body.radius; // Radius of the body

    // Find the minimum flyby altitude for this body across all instances
    const bodyInstances = instances.filter(i => i.bodyName === body.name);
    let minAlt = Infinity;
    bodyInstances.forEach(inst => {
      if (inst.minFlybyAltitude !== undefined && inst.minFlybyAltitude < minAlt) {
        minAlt = inst.minFlybyAltitude;
      }
    });
    // Fallback to atmosphere height if no instances define a minFlybyAltitude
    if (minAlt === Infinity) {
      minAlt = body.atmosphereHeight;
    }
    const r_p_min = R_b + minAlt; // Minimum flyby radius (body radius + min altitude)

    // Calculate v_infinity for a 5-degree deflection angle (Tisserand's criterion)
    const targetDeltaRad = (5 * Math.PI) / 180; // 5 degrees in radians
    const sinHalfDelta = Math.sin(targetDeltaRad / 2);
    const vInf5DegMs = Math.sqrt(((1 / sinHalfDelta) - 1) * mu_b / r_p_min);

    // Store precomputed values for the body
    bodyPrepMap[body.name] = {
      body,
      r_p_min,
      vInf5DegMs,
    };
  });

  // --- Step 3: Initialize envelopes for all instances ---
  // For each instance, set the initial maxMs to the body's vInf5DegMs (or maxC3 if applicable)
  instances.forEach(inst => {
    const prep = bodyPrepMap[inst.bodyName];
    if (!prep) return;

    let maxMs = prep.vInf5DegMs;
    const hasIncoming = links.some(l => l.targetInstanceId === inst.id); // Has incoming trajectory
    const hasOutgoing = links.some(l => l.sourceInstanceId === inst.id); // Has outgoing trajectory
    const isFlyby = hasIncoming && hasOutgoing; // Flyby instance among other roles

    // 1. maxC3 should not lower the maximum C3 given by the tisserand plot if the instance is a flyby among other roles
    if (!isFlyby && inst.maxC3 !== undefined && inst.maxC3 > 0) {
      maxMs = Math.min(maxMs, Math.sqrt(inst.maxC3) * 1000);
    }
    // Ensure maxMs is at least 1000 m/s
    maxMs = Math.max(1000, maxMs);

    activeInstanceEnvelopes[inst.id] = { minMs: 0, maxMs };
  });

  // --- Step 4: Helper function to validate v_infinity for an instance ---
  // Checks if a given v_infinity (vInfMs) is valid for an instance by ensuring:
  // - For pure flybys: The deflection angle is compatible with connected instances.
  // - For arrivals/departures: The v_infinity allows a connection to at least one neighbor.
  const testInstanceVInfMsValid = (inst: InstanceNode, vInfMs: number): boolean => {
    const body = bodyMap.get(inst.bodyName);
    const prep = bodyPrepMap[inst.bodyName];
    if (!body || !prep) return true; // Skip if body or prep data is missing

    const inLinks = links.filter(l => l.targetInstanceId === inst.id); // Incoming trajectories
    const outLinks = links.filter(l => l.sourceInstanceId === inst.id); // Outgoing trajectories

    // --- Case 1: Pure flyby (incoming + outgoing trajectories) ---
    if (inLinks.length > 0 && outLinks.length > 0) {
      // Calculate the maximum possible deflection angle for this v_infinity
      const sinHalfDeltaMax = Math.min(
        1,
        Math.max(0, 1 / (1 + (prep.r_p_min * vInfMs * vInfMs) / body.stdGravParam))
      );
      const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);

      // Check if there exists at least one pair of incoming/outgoing links that satisfy the deflection constraint
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

          // Sample velocities from the source and target envelopes
          const numSamples: number = 30;
          const theta1List: number[] = [];
          const theta2List: number[] = [];

          // Sample incoming velocities (env1)
          for (let i = 0; i < numSamples; i++) {
            const frac = numSamples === 1 ? 0 : i / (numSamples - 1);
            const v1 = env1.minMs + frac * (env1.maxMs - env1.minMs);
            const res1 = getTisserandIntersectionTheta(body, vInfMs, b1, v1, mainBody.stdGravParam);
            if (res1) theta1List.push(res1.thetaA);
          }

          // Sample outgoing velocities (env2)
          for (let i = 0; i < numSamples; i++) {
            const frac = numSamples === 1 ? 0 : i / (numSamples - 1);
            const v2 = env2.minMs + frac * (env2.maxMs - env2.minMs);
            const res2 = getTisserandIntersectionTheta(body, vInfMs, b2, v2, mainBody.stdGravParam);
            if (res2) theta2List.push(res2.thetaA);
          }

          if (theta1List.length === 0 || theta2List.length === 0) continue;

          // Find the minimum angular separation between incoming and outgoing theta ranges
          const minT1 = Math.min(...theta1List);
          const maxT1 = Math.max(...theta1List);
          const minT2 = Math.min(...theta2List);
          const maxT2 = Math.max(...theta2List);

          const minDeflectionRad = Math.max(0, minT2 - maxT1, minT1 - maxT2);

          // If the minimum deflection is <= deltaMaxRad, the pair is valid
          if (minDeflectionRad <= deltaMaxRad + 1e-4) {
            satisfiesPair = true;
            break;
          }
        }
        if (satisfiesPair) break;
      }
      return satisfiesPair;
    }
    // --- Case 2: Arrival (only incoming trajectories) ---
    else if (inLinks.length > 0) {
      let satisfiesNeigh = false;
      for (const inLink of inLinks) {
        const srcInst = instMap.get(inLink.sourceInstanceId);
        if (!srcInst) continue;
        const nb = bodyMap.get(srcInst.bodyName);
        const envNb = activeInstanceEnvelopes[srcInst.id];
        if (!nb || !envNb || (envNb.minMs === 0 && envNb.maxMs === 0)) continue;

        // Sample velocities from the source envelope
        const numSamplesIn: number = 30;
        for (let i = 0; i < numSamplesIn; i++) {
          const frac = numSamplesIn === 1 ? 0 : i / (numSamplesIn - 1);
          const vNb = envNb.minMs + frac * (envNb.maxMs - envNb.minMs);
          // Check if a valid intersection exists for this v_infinity
          if (getTisserandIntersectionTheta(body, vInfMs, nb, vNb, mainBody.stdGravParam) !== null) {
            satisfiesNeigh = true;
            break;
          }
        }
        if (satisfiesNeigh) break;
      }
      return satisfiesNeigh;
    }
    // --- Case 3: Departure (only outgoing trajectories) ---
    else if (outLinks.length > 0) {
      let satisfiesNeigh = false;
      for (const outLink of outLinks) {
        const tgtInst = instMap.get(outLink.targetInstanceId);
        if (!tgtInst) continue;
        const nb = bodyMap.get(tgtInst.bodyName);
        const envNb = activeInstanceEnvelopes[tgtInst.id];
        if (!nb || !envNb || (envNb.minMs === 0 && envNb.maxMs === 0)) continue;

        // Sample velocities from the target envelope
        const numSamplesOut: number = 30;
        for (let i = 0; i < numSamplesOut; i++) {
          const frac = numSamplesOut === 1 ? 0 : i / (numSamplesOut - 1);
          const vNb = envNb.minMs + frac * (envNb.maxMs - envNb.minMs);
          // Check if a valid intersection exists for this v_infinity
          if (getTisserandIntersectionTheta(body, vInfMs, nb, vNb, mainBody.stdGravParam) !== null) {
            satisfiesNeigh = true;
            break;
          }
        }
        if (satisfiesNeigh) break;
      }
      return satisfiesNeigh;
    }

    // If no links, assume valid (edge case)
    return true;
  };

  // --- Step 5: Iteratively refine envelopes ---
  // Use a binary search to adjust minMs and maxMs for each instance until convergence
  let changed = true;
  let passCount = 0;
  const maxPasses = 100; // Prevent infinite loops

  while (changed && passCount < maxPasses) {
    changed = false;
    passCount++;

    // Alternate sweep direction (forward/backward) for better convergence
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

      // --- Step 5.1: Coarse sampling of v_infinity values ---
      const stepMs = 50; // Coarse step size (m/s)
      const coarseSamples: number[] = [];
      for (let v = curInstEnv.minMs; v < curInstEnv.maxMs; v += stepMs) {
        coarseSamples.push(v);
      }
      // Ensure the maxMs is included
      if (coarseSamples.length === 0 || coarseSamples[coarseSamples.length - 1] !== curInstEnv.maxMs) {
        coarseSamples.push(curInstEnv.maxMs);
      }

      // Find indices of valid v_infinity values in the coarse sample
      const validCoarseIndices: number[] = [];
      for (let i = 0; i < coarseSamples.length; i++) {
        if (testInstanceVInfMsValid(inst, coarseSamples[i])) {
          validCoarseIndices.push(i);
        }
      }

      // If no valid coarse samples, try finer sampling
      if (validCoarseIndices.length === 0) {
        for (let v = curInstEnv.minMs; v <= curInstEnv.maxMs; v += 10) {
          if (testInstanceVInfMsValid(inst, v)) {
            validCoarseIndices.push(0);
            break;
          }
        }
      }

      // --- Step 5.2: Refine minMs and maxMs using binary search ---
      let newMinMs = 0;
      let newMaxMs = 0;

      if (validCoarseIndices.length > 0) {
        // Refine minMs
        const firstValidIdx = validCoarseIndices[0];
        if (firstValidIdx === 0 && testInstanceVInfMsValid(inst, curInstEnv.minMs)) {
          newMinMs = curInstEnv.minMs;
        } else {
          let low = firstValidIdx > 0 ? coarseSamples[firstValidIdx - 1] : curInstEnv.minMs;
          let high = coarseSamples[firstValidIdx];
          // Binary search to find the smallest valid v_infinity
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

        // Refine maxMs
        const lastValidIdx = validCoarseIndices[validCoarseIndices.length - 1];
        if (lastValidIdx === coarseSamples.length - 1 && testInstanceVInfMsValid(inst, curInstEnv.maxMs)) {
          newMaxMs = curInstEnv.maxMs;
        } else {
          let low = coarseSamples[lastValidIdx];
          let high = lastValidIdx < coarseSamples.length - 1 ? coarseSamples[lastValidIdx + 1] : curInstEnv.maxMs;
          // Binary search to find the largest valid v_infinity
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

      // Ensure minMs <= maxMs
      if (newMinMs > newMaxMs) {
        newMinMs = 0;
        newMaxMs = 0;
      }

      // Update the envelope if there's a significant change
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
  bodies: OrbitalBody[],
  mainBody: CelestialBody
): InstanceNode[] {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);

  return instances.map(inst => {
    const env = envs[inst.id];
    const hasIncoming = links.some(l => l.targetInstanceId === inst.id);
    const hasOutgoing = links.some(l => l.sourceInstanceId === inst.id);
    const isFlyby = hasIncoming && hasOutgoing;
    const isSource = !hasIncoming || !!inst.isSourceOverride;
    const isTarget = !hasOutgoing || !!inst.isTargetOverride;

    if (!env || (env.minMs === 0 && env.maxMs === 0)) {
      return {
        ...inst,
        computedMinC3: undefined,
        computedMaxC3: !isFlyby ? inst.maxC3 : undefined,
      };
    }

    const minKms = env.minMs / 1000;
    const maxKms = env.maxMs / 1000;

    // 2. an instance which is a source or target should have a minimum C3 of 0
    let minC3: number | undefined = (isSource || isTarget) ? 0 : minKms * minKms;
    let maxC3: number | undefined = maxKms * maxKms;

    // 1. maxC3 should not lower the maximum C3 given by the tisserand plot if the instance is a flyby among other roles
    if (!isFlyby && inst.maxC3 !== undefined) {
      maxC3 = Math.min(maxC3, inst.maxC3);
      if (minC3 !== undefined && minC3 > maxC3) minC3 = 0;
    }

    const finalMinC3 = minC3 !== undefined ? Math.round(Math.max(0, minC3) * 10) / 10 : undefined;
    const finalMaxC3 = maxC3 !== undefined ? Math.round(Math.max(finalMinC3 ?? 0, maxC3) * 10) / 10 : undefined;

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
  bodies: OrbitalBody[],
  mainBody: CelestialBody
): DirectionalLink[] {
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  return links.map(link => {
    const src = instances.find(i => i.id === link.sourceInstanceId)!;
    const tgt = instances.find(i => i.id === link.targetInstanceId)!;

    const srcBody = bodyMap.get(src.bodyName)!;
    const tgtBody = bodyMap.get(tgt.bodyName)!;

    let departureSampleCount: number;
    if (src?.dateSampleCount !== undefined) {
      departureSampleCount = src.dateSampleCount;
    } else if (src?.validFlybyDates && src.validFlybyDates.length > 0) {
      departureSampleCount = src.validFlybyDates.length;
    } else {
      const srcMinDate = src?.minDate ?? src?.computedMinDate!;
      const srcMaxDate = src?.maxDate ?? src?.computedMaxDate!;
      const srcPeriod = getOrbitalPeriod(srcBody, mainBody);
      const srcRawN = Math.ceil(((srcMaxDate - srcMinDate) / Math.max(1, srcPeriod)) * SAMPLE_PER_PERIOD);
      departureSampleCount = Math.min(MAX_SAMPLE_COUNT, Math.max(MIN_SAMPLE_COUNT, srcRawN));
    }

    let arrivalSampleCount: number;
    if (tgt?.dateSampleCount !== undefined) {
      arrivalSampleCount = tgt.dateSampleCount;
    } else if (tgt?.validFlybyDates && tgt.validFlybyDates.length > 0) {
      arrivalSampleCount = tgt.validFlybyDates.length;
    } else {
      const tgtMinDate = tgt?.minDate ?? tgt?.computedMinDate!;
      const tgtMaxDate = tgt?.maxDate ?? tgt?.computedMaxDate!;
      const tgtPeriod = getOrbitalPeriod(tgtBody, mainBody);
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
    const srcMin = srcInstance.minDate ?? srcInstance.computedMinDate!;
    const srcMax = srcInstance.maxDate ?? srcInstance.computedMaxDate!;
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
    const srcMin = srcInstance.minDate ?? srcInstance.computedMinDate!;
    const srcMax = srcInstance.maxDate ?? srcInstance.computedMaxDate!;
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
    const tgtMin = tgtInstance.minDate ?? tgtInstance.computedMinDate!;
    const tgtMax = tgtInstance.maxDate ?? tgtInstance.computedMaxDate!;
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
    const tgtMin = tgtInstance.minDate ?? tgtInstance.computedMinDate!;
    const tgtMax = tgtInstance.maxDate ?? tgtInstance.computedMaxDate!;
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
  const maxDur = link.maxFlightDuration ?? Infinity;
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
  bodies?: OrbitalBody[],
  mainBody?: CelestialBody
): InstanceNode[] {
  const bodyMap = new Map<string, OrbitalBody>();
  if (bodies) {
    bodies.forEach(b => bodyMap.set(b.name, b));
  }

  return instances.map(inst => {
    if (inst.dateSampleCount !== undefined) {
      const minD = inst.minDate ?? inst.computedMinDate!;
      const maxD = inst.maxDate ?? inst.computedMaxDate!;
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

    const minD = inst.minDate ?? inst.computedMinDate!;
    const maxD = inst.maxDate ?? inst.computedMaxDate!;

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
    physicalValidMatrix: pcData.physicalValidMatrix?.map(row => [...row]),
    constraintValidMatrix: pcData.constraintValidMatrix?.map(row => [...row]),
    vTransDepMatrix: pcData.vTransDepMatrix?.map(row => [...row]),
    vTransArrMatrix: pcData.vTransArrMatrix?.map(row => [...row]),
  };
}

/**
 * STEP 5: Compute Porkchop Plot for a given link using progressive interlaced passes.
 */
export async function computePorkchopPlot(
  link: DirectionalLink,
  srcInstance: InstanceNode,
  tgtInstance: InstanceNode,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  onProgress?: ProgressCallback,
  onPartialUpdatePorkchop?: (pcData: PorkchopPlotData, validCount: number) => void,
  shouldStop?: () => boolean
): Promise<PorkchopPlotData> {
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const srcBody = bodyMap.get(srcInstance.bodyName)!;
  const tgtBody = bodyMap.get(tgtInstance.bodyName)!;

  const { srcDates, tgtDates } = countPossibleTransfers(link, srcInstance, tgtInstance);

  const nDep = srcDates.length;
  const nArr = tgtDates.length;
  const totalPoints = nDep * nArr;

  const c3DepMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({x: Infinity, y: Infinity, z: Infinity}));
  const c3ArrMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({x: Infinity, y: Infinity, z: Infinity}));
  const dvMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(Infinity));
  const flightTimeMatrix: number[][] = Array.from({ length: nDep }, () => Array(nArr).fill(0));
  const physicalValidMatrix: boolean[][] = Array.from({ length: nDep }, () => Array(nArr).fill(false));
  const constraintValidMatrix: boolean[][] = Array.from({ length: nDep }, () => Array(nArr).fill(false));
  const vTransDepMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({ x: Infinity, y: Infinity, z: Infinity }));
  const vTransArrMatrix: Vector3D[][] = Array.from({ length: nDep }, () => Array(nArr).fill({ x: Infinity, y: Infinity, z: Infinity }));

  const muCentral = mainBody.stdGravParam || 1e12;
  const minAllowedRadius = getMinFlybyRadius(mainBody, undefined);

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
    physicalValidMatrix,
    constraintValidMatrix,
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
      const maxDur = link.maxFlightDuration ?? Infinity;

      let isPhysicallyPossible = false;
      let passC3 = false;
      let c3Dep : Vector3D = { x: Infinity, y: Infinity, z: Infinity };
      let c3Arr : Vector3D = { x: Infinity, y: Infinity, z: Infinity };
      let dv = Infinity;
      let v1 = { x: Infinity, y: Infinity, z: Infinity };
      let v2 = { x: Infinity, y: Infinity, z: Infinity };

      // Strictly physically impossible if dt < 3600 (e.g. arrival before/at departure)
      if (dt >= 3600) {
        const srcState = srcStates[i];
        const tgtState = tgtStates[j];

        // Use fast direct Lambert solver (0-revolution) first for high-throughput grid calculation
        const sol = solveLambert(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius);

        if (sol.isValid) {
          isPhysicallyPossible = true;
          v1 = sol.v1;
          v2 = sol.v2;

          const vInfDep = vecSub(sol.v1, srcState.vel);
          const vInfArr = vecSub(sol.v2, tgtState.vel);

          const vInfDepMag = vecMag(vInfDep);
          const vInfArrMag = vecMag(vInfArr);

          c3Dep = vecScale(vInfDep, vecMag(vInfDep) / 1e6);
          c3Arr = vecScale(vInfArr, vecMag(vInfArr) / 1e6);
          dv = vInfDepMag + vInfArrMag;

          const passDur = (dt >= minDur && dt <= maxDur);
          const passSrcC3 = (srcInstance.computedMinC3 === undefined || vecMag(c3Dep) >= srcInstance.computedMinC3 - 0.05) &&
                            (srcInstance.computedMaxC3 === undefined || vecMag(c3Dep) <= srcInstance.computedMaxC3 + 0.05);

          const passTgtC3 = (tgtInstance.computedMinC3 === undefined || vecMag(c3Arr) >= tgtInstance.computedMinC3 - 0.05) &&
                            (tgtInstance.computedMaxC3 === undefined || vecMag(c3Arr) <= tgtInstance.computedMaxC3 + 0.05);

          passC3 = passDur && passSrcC3 && passTgtC3;
        }
      }

      vTransDepMatrix[i][j] = v1;
      vTransArrMatrix[i][j] = v2;
      c3DepMatrix[i][j] = c3Dep;
      c3ArrMatrix[i][j] = c3Arr;
      dvMatrix[i][j] = dv;
      physicalValidMatrix[i][j] = isPhysicallyPossible;
      constraintValidMatrix[i][j] = passC3;
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
            physicalValidMatrix[r][c] = isPhysicallyPossible;
            constraintValidMatrix[r][c] = passC3;
            flightTimeMatrix[r][c] = tgtDates[c] - srcDates[r];
          }
        }
      }

      const now = performance.now();
      // Yield execution every 25ms so the browser event loop remains responsive
      if (now - lastYieldTime > 25) {
        lastYieldTime = now;
        // Throttle UI updates to every 60ms for smooth progress animation
        if (now - lastUpdateDataTime > 60) {
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

export interface ComputeSequencePorkchopOptions {
  pathInsts: InstanceNode[];
  bodies: OrbitalBody[];
  mainBody: CelestialBody;
  links: DirectionalLink[];
  porkchops: Record<string, PorkchopPlotData>;
  sequencePorkchops: Record<string, SequencePorkchopData>;
  isFullPath: boolean;
  onProgress?: ProgressCallback;
  onPartialUpdate?: (seqPc: SequencePorkchopData) => void;
  shouldStop?: () => boolean;
  onSubtaskProgress?: (subtask: SubtaskProgressInfo | null) => void;
  onDirectPorkchopUpdate?: (newPcs: Record<string, PorkchopPlotData>) => void;
  onSequencePorkchopUpdate?: (subSeqPc: SequencePorkchopData) => void;
}

/**
 * Unified Sequence Porkchop Plot solver for N-instance sequences (N >= 3).
 * Computes a porkchop plot for a sequence of celestial bodies (e.g., Kerbin -> Eve -> Duna -> Jool)
 * by evaluating precomputed direct transfer porkchops and recursive sub-sequence chains.
 * Uses NO Lambert calculations (relies on precomputed data).
 *
 * @param options - Configuration object containing:
 *   - pathInsts: Array of instances (celestial bodies) defining the path.
 *   - bodies: Celestial body data.
 *   - mainBody: The main gravitational body (e.g., Sun).
 *   - links: Predefined links between instances.
 *   - porkchops: Precomputed porkchop plots for direct transfers.
 *   - sequencePorkchops: Precomputed porkchop plots for sub-sequences.
 *   - isFullPath: Whether the sequence is a full path.
 *   - onProgress: Callback for progress updates.
 *   - onPartialUpdate: Callback for partial results during computation.
 *   - shouldStop: Function to check if computation should be aborted.
 *   - onSubtaskProgress: Callback for subtask progress (e.g., sub-sequence computation).
 *   - onDirectPorkchopUpdate: Callback for updates to direct porkchop plots.
 *   - onSequencePorkchopUpdate: Callback for updates to sequence porkchop plots.
 *
 * @returns Promise<SequencePorkchopData> - The computed porkchop plot data for the sequence.
 */
export async function computeSequencePorkchopPlot(
  options: ComputeSequencePorkchopOptions
): Promise<SequencePorkchopData> {
  if (options.pathInsts.length == 3) {
    return computeSequence3PorkchopPlot(options);
  } else if (options.pathInsts.length > 3) {
    return computeSequenceNSup3PorkchopPlot(options);
  } else {
    throw new Error(`computeSequencePorkchopPlot: Invalid path length ${options.pathInsts.length}. Must be >= 3.`);
  }
}

export async function computeSequence3PorkchopPlot(
  options: ComputeSequencePorkchopOptions
): Promise<SequencePorkchopData> {
  // --- 1. DESTRUCTURE OPTIONS ---
  const {
    pathInsts,          // Array of path instances (e.g., [Kerbin, Eve, Duna, Jool])
    bodies,             // Celestial body data (e.g., masses, positions)
    mainBody,           // Main gravitational body (e.g., Kerbol)
    links,              // Predefined links between instances (default: empty array)
    porkchops,          // Precomputed porkchop plots for direct transfers
    sequencePorkchops,  // Precomputed porkchop plots for sub-sequences
    isFullPath,         // Whether the sequence is a full path (default: false)
    onProgress,         // Callback for overall progress updates
    onPartialUpdate,    // Callback for partial results (e.g., for UI updates)
    shouldStop,         // Function to check if computation should stop
    onSubtaskProgress,  // Callback for subtask progress (e.g., sub-sequence computation)
    onDirectPorkchopUpdate, // Callback for direct porkchop updates
    onSequencePorkchopUpdate, // Callback for sequence porkchop updates
  } = options;

  // --- 2. INITIALIZE SEQUENCE METADATA ---
  const seqId = `seq-pc-${pathInsts.map(i => i.id).join('-')}`; // Unique ID for the sequence (e.g., "seq-pc-kerbin-eve-duna")
  const seqLabel = pathInsts.map(i => i.bodyName).join(' ➔ '); // Human-readable label (e.g., "Kerbin ➔ Eve ➔ Duna")

  // --- 3. HELPER FUNCTION: REPORT SUBTASK PROGRESS ---
  /**
   * Reports the current subtask progress to the UI.
   * @param subtask - Subtask info (null to clear the active subtask).
   */
  const reportSubtask = (subtask: SubtaskProgressInfo | null) => {
    onSubtaskProgress?.(subtask);
  };

  // --- 4. STEP 1: COMPUTE MISSING DIRECT TRANSFER PORKCHOPS ---
  // For each pair of consecutive instances in the path, ensure a porkchop plot exists.
  for (let k = 0; k < 2; k++) {
    const srcInst = pathInsts[k]; // Source instance (e.g., Kerbin)
    const tgtInst = pathInsts[k + 1]; // Target instance (e.g., Eve)
    // Find the link between the current pair of instances
    const link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === tgtInst.id);
    const linkId = link?.id || `link-${srcInst.id}-${tgtInst.id}`; // Generate a unique link ID if not provided

    // If the porkchop plot for this link doesn't exist or is empty, compute it
    let pc = porkchops[linkId];
    if (!pc || !pc.c3DepMatrix || pc.c3DepMatrix.length === 0) {
      const subtaskName = `Direct Transfer (${srcInst.bodyName} ➔ ${tgtInst.bodyName})`;
      const subInfo: SubtaskProgressInfo = {
        subtaskId: linkId,
        subtaskName,
        subtaskType: 'direct_link', // Type of subtask (direct transfer)
        computedSamples: 0,
        totalSamples: 100,
        progressPct: 0,
        statusText: `Computing direct transfer Lambert grid for ${srcInst.bodyName} ➔ ${tgtInst.bodyName}...`,
        parentTaskId: seqId,
      };
      reportSubtask(subInfo);
      onProgress?.(`Computing 3-Instance (${seqLabel}) — Subtask: ${subtaskName} (0%)`);
      await yieldUI(); // Yield to the event loop to avoid blocking the UI
      if (shouldStop?.()) break; // Abort if requested

      // Create a dummy link if none exists
      const dummyLink: DirectionalLink = link || {
        id: linkId,
        sourceInstanceId: srcInst.id,
        targetInstanceId: tgtInst.id,
      };

      // Compute the porkchop plot for this direct transfer
      pc = await computePorkchopPlot(
        dummyLink,
        srcInst,
        tgtInst,
        bodies,
        mainBody,
        // Callback for progress updates during porkchop computation
        (msg) => {
          const total = pc?.totalSamples;
          const comp = pc?.computedSamples;
          const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((comp / total) * 100))) : 0;
          reportSubtask({
            subtaskId: linkId,
            subtaskName,
            subtaskType: 'direct_link',
            computedSamples: comp,
            totalSamples: total,
            progressPct: pct,
            statusText: msg,
            parentTaskId: seqId,
          });
          onProgress?.(`Computing 3-Instance (${seqLabel}) — Subtask: ${subtaskName} (${pct}%)`);
        },
        // Callback for partial updates (e.g., intermediate results)
        (partialPc) => {
          const total = partialPc.totalSamples;
          const comp = partialPc.computedSamples;
          const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((comp / total) * 100))) : 0;
          porkchops[linkId] = partialPc; // Store partial result
          onDirectPorkchopUpdate?.({ [linkId]: partialPc }); // Notify UI
          reportSubtask({
            subtaskId: linkId,
            subtaskName,
            subtaskType: 'direct_link',
            computedSamples: comp,
            totalSamples: total,
            progressPct: pct,
            statusText: `Evaluating direct transfer Lambert grid...`,
            parentTaskId: seqId,
          });
        },
        shouldStop
      );
      // Store the computed porkchop plot
      porkchops[linkId] = pc;
      onDirectPorkchopUpdate?.({ [linkId]: pc });
    }
  }

  // --- 6. CLEAR ACTIVE SUBTASK ---
  // Notify that subtasks are complete and main computation is starting
  reportSubtask(null);

  // --- 7. INITIALIZE SEQUENCE DATA STRUCTURES ---
  const srcInst = pathInsts[0]; // First instance (e.g., Kerbin)
  const tgtInst = pathInsts[2]; // Last instance (e.g., Jool)
  const flybyInst = pathInsts[1]; // Intermediate instances (e.g., [Eve, Duna])

  // Get the first and last direct transfer porkchop plots for departure/arrival dates
  const P0_link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === pathInsts[1].id);
  const P0 = porkchops[P0_link?.id || `link-${srcInst.id}-${pathInsts[1].id}`]; // First leg porkchop

  const Plast_link = links.find(l => l.sourceInstanceId === pathInsts[1].id && l.targetInstanceId === tgtInst.id);
  const Plast = porkchops[Plast_link?.id || `link-${pathInsts[1].id}-${tgtInst.id}`]; // Last leg porkchop

  // Extract departure and arrival dates from the first and last porkchop plots
  const depDates: number[] = P0?.depDates || []; // Departure dates (from first leg)
  const arrDates: number[] = Plast?.arrDates || []; // Arrival dates (from last leg)

  const N_DEP = depDates.length; // Number of departure dates
  const N_ARR = arrDates.length; // Number of arrival dates

  // --- 8. INITIALIZE MATRICES FOR RESULTS ---
  // Matrices to store computed values for each (departure date, arrival date) pair
  const c3DepAMatrix: Vector3D[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })
  ); // Departure C3 matrix
  const c3ArrFinalMatrix: Vector3D[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })
  ); // Final arrival C3 matrix
  const totalPoweredDvMatrix: number[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(Infinity)
  ); // Total delta-v matrix
  const flightTimeMatrix: number[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(0)
  ); // Flight time matrix
  const physicalValidMatrix: boolean[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(false)
  ); // Physical validity matrix (e.g., trajectory is possible)
  const constraintValidMatrix: boolean[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(false)
  ); // Constraint validity matrix (e.g., meets user constraints)

  // Initialize flyby data for intermediate instances
  const flybyData = {
    instance: flybyInst,
    poweredDvMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill(Infinity)), // Delta-v for each flyby
    c3ArrMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })), // C3 at arrival
    c3DepMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })), // C3 at departure
    dateMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)), // Flyby date
  };

  const totalPoints = N_DEP * N_ARR; // Total number of (departure, arrival) pairs to evaluate

  // --- 9. INITIALIZE SEQUENCE DATA OBJECT ---
  const seqData: SequencePorkchopData = {
    id: seqId,
    sequenceLabel: seqLabel,
    isFullPath,
    instanceCount: 3,
    sourceBody: srcInst,
    targetBody: tgtInst,
    depDates,
    arrDates,
    c3DepMatrix: c3DepAMatrix,
    c3ArrMatrix: c3ArrFinalMatrix,
    flybys: [flybyData],
    totalPoweredDvMatrix,
    flightTimeMatrix,
    physicalValidMatrix,
    constraintValidMatrix,
    computedSamples: 0,
    totalSamples: totalPoints,
    activeSubtask: null,
  };

  // --- 10. START PROFILING ---
  const profiler = new SequenceTransferProfiler(); // Track performance metrics
  const computationStartTime = performance.now(); // Start time for profiling

  // Emit initial state to open the sequence viewer immediately
  seqData.profiling = profiler.getStats(0, 0);
  onPartialUpdate?.({ ...seqData });

  // --- 11. HIERARCHICAL GRID EVALUATION ---
  // Use a hierarchical grid to evaluate points in passes (coarse to fine)
  const passes = getHierarchicalGridIndices(N_DEP, N_ARR); // Get grid evaluation order (e.g., from low to high resolution)
  const evaluated = Array.from({ length: N_DEP }, () => new Uint8Array(N_ARR)); // Track evaluated points

  let validCount = 0; // Count of valid (constraint + physical) trajectories
  let computedPointsCount = 0; // Total points evaluated so far
  let lastYieldTime = performance.now(); // Track time to yield to UI

  // Loop through each pass (resolution level)
  for (const pass of passes) {
    if (shouldStop?.()) break; // Abort if requested

    const S = pass.step; // Current step size (resolution)
    // Loop through each point in the current pass
    for (const [i, j] of pass.points) {
      if (shouldStop?.()) break;

      evaluated[i][j] = 1; // Mark this point as evaluated
      computedPointsCount++;

      const tDep = depDates[i]; // Departure date
      const tArr = arrDates[j]; // Arrival date
      const totalDt = tArr - tDep; // Total flight time
      flightTimeMatrix[i][j] = totalDt;

      // --- 11.1. EVALUATE SEQUENCE TRANSFER ---
      // Compute the best transfer for this (departure, arrival) pair
      let bestRes : SequenceTransferResult | null = null;
      if (totalDt > 0)
      {
        // For 3-instance sequences, use direct porkchop evaluation
        bestRes = evaluateSequenceTransferFromDirectPorkchops(
          pathInsts,
          tDep,
          tArr,
          bodies,
          mainBody,
          porkchops,
          links,
          profiler
        );
      }

      // Check if the transfer is physically and constraint-valid
      const isPhysical = (totalDt > 0) && !!bestRes && (bestRes?.isPhysicallyValid !== false);
      const isConstraint = isPhysical && (bestRes?.isConstraintValid !== false);

      physicalValidMatrix[i][j] = isPhysical;
      constraintValidMatrix[i][j] = isConstraint;

      // --- 11.2. STORE RESULTS IF VALID ---
      if (bestRes) {
        c3DepAMatrix[i][j] = bestRes.c3DepA; // Departure C3
        c3ArrFinalMatrix[i][j] = bestRes.c3ArrFinal; // Final arrival C3
        totalPoweredDvMatrix[i][j] = bestRes.totalDv; // Total delta-v

        // Store flyby data for each intermediate instance
        flybyData.poweredDvMatrix[i][j] = bestRes.flybyDvs?.[0] ?? Infinity; // Delta-v for this flyby
        flybyData.dateMatrix[i][j] = bestRes.flybyDates?.[0] ?? 0; // Flyby date
        // Store C3 values for the first two flybys (if they exist)
        flybyData.c3ArrMatrix[i][j] = bestRes.c3ArrB ?? { x: Infinity, y: Infinity, z: Infinity };
        flybyData.c3DepMatrix[i][j] = bestRes.c3DepB ?? { x: Infinity, y: Infinity, z: Infinity };

        if (isConstraint) validCount++; // Increment valid trajectory count
      }

      // --- 11.3. PREVIEW FILL FOR UNVISITED NEIGHBORS ---
      // For hierarchical grid: fill in neighboring cells with the same values
      // to provide a preview for unevaluated points in the current pass.
      for (let di = 0; di < S && i + di < N_DEP; di++) {
        const r = i + di; // Row index
        for (let dj = 0; dj < S && j + dj < N_ARR; dj++) {
          const c = j + dj; // Column index
          if (evaluated[r][c] === 0) { // If this neighbor hasn't been evaluated yet
            // Copy values from the current point (i,j) to the neighbor (r,c)
            flightTimeMatrix[r][c] = flightTimeMatrix[i][j];
            physicalValidMatrix[r][c] = physicalValidMatrix[i][j];
            constraintValidMatrix[r][c] = constraintValidMatrix[i][j];
            c3DepAMatrix[r][c] = c3DepAMatrix[i][j];
            c3ArrFinalMatrix[r][c] = c3ArrFinalMatrix[i][j];
            totalPoweredDvMatrix[r][c] = totalPoweredDvMatrix[i][j];

            // Copy flyby data for all intermediate instances
            flybyData.poweredDvMatrix[r][c] = flybyData.poweredDvMatrix[i][j];
            flybyData.dateMatrix[r][c] = flybyData.dateMatrix[i][j];
            flybyData.c3ArrMatrix[r][c] = flybyData.c3ArrMatrix[i][j];
            flybyData.c3DepMatrix[r][c] = flybyData.c3DepMatrix[i][j];
          }
        }
      }

      // --- 11.4. YIELD TO UI PERIODICALLY ---
      // Update progress and yield to the UI every ~50ms to avoid freezing
      const now = performance.now();
      if (now - lastYieldTime > 50) {
        lastYieldTime = now;
        seqData.computedSamples = computedPointsCount;
        seqData.totalSamples = totalPoints;
        seqData.profiling = profiler.getStats(now - computationStartTime, computedPointsCount);
        const pct = Math.floor((computedPointsCount / totalPoints) * 100);
        onProgress?.(`Computing sequence porkchop plot for ${seqLabel} (${pct}%, ${validCount} valid)...`);
        onPartialUpdate?.({ ...seqData }); // Send partial results to UI
        await yieldUI(); // Yield to the event loop
      }
    }
  }

  // --- 12. FINALIZE AND RETURN RESULTS ---
  // Update final stats and return the complete sequence porkchop data
  seqData.computedSamples = totalPoints;
  seqData.totalSamples = totalPoints;
  seqData.profiling = profiler.getStats(performance.now() - computationStartTime, totalPoints);
  onPartialUpdate?.({ ...seqData }); // Final update
  return seqData;
}

export async function computeSequenceNSup3PorkchopPlot(
  options: ComputeSequencePorkchopOptions
): Promise<SequencePorkchopData> {
  // --- 1. DESTRUCTURE OPTIONS ---
  const {
    pathInsts,          // Array of path instances (e.g., [Kerbin, Eve, Duna, Jool])
    bodies,             // Celestial body data (e.g., masses, positions)
    mainBody,           // Main gravitational body (e.g., Kerbol)
    links,              // Predefined links between instances (default: empty array)
    porkchops,          // Precomputed porkchop plots for direct transfers
    sequencePorkchops,  // Precomputed porkchop plots for sub-sequences
    isFullPath,         // Whether the sequence is a full path (default: false)
    onProgress,         // Callback for overall progress updates
    onPartialUpdate,    // Callback for partial results (e.g., for UI updates)
    shouldStop,         // Function to check if computation should stop
    onSubtaskProgress,  // Callback for subtask progress (e.g., sub-sequence computation)
    onDirectPorkchopUpdate, // Callback for direct porkchop updates
    onSequencePorkchopUpdate, // Callback for sequence porkchop updates
  } = options;

  // --- 2. INITIALIZE SEQUENCE METADATA ---
  const N = pathInsts.length; // Number of instances in the path
  const seqId = `seq-pc-${pathInsts.map(i => i.id).join('-')}`; // Unique ID for the sequence (e.g., "seq-pc-kerbin-eve-duna")
  const seqLabel = pathInsts.map(i => i.bodyName).join(' ➔ '); // Human-readable label (e.g., "Kerbin ➔ Eve ➔ Duna")

  // --- 3. HELPER FUNCTION: REPORT SUBTASK PROGRESS ---
  /**
   * Reports the current subtask progress to the UI.
   * @param subtask - Subtask info (null to clear the active subtask).
   */
  const reportSubtask = (subtask: SubtaskProgressInfo | null) => {
    onSubtaskProgress?.(subtask);
  };

  // --- 4. STEP 1: COMPUTE MISSING DIRECT TRANSFER PORKCHOPS ---
  // For each pair of consecutive instances in the path, ensure a porkchop plot exists.
  for (let k = 0; k < N - 1; k++) {
    const srcInst = pathInsts[k]; // Source instance (e.g., Kerbin)
    const tgtInst = pathInsts[k + 1]; // Target instance (e.g., Eve)
    // Find the link between the current pair of instances
    const link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === tgtInst.id);
    const linkId = link?.id || `link-${srcInst.id}-${tgtInst.id}`; // Generate a unique link ID if not provided

    // If the porkchop plot for this link doesn't exist or is empty, compute it
    let pc = porkchops[linkId];
    if (!pc || !pc.c3DepMatrix || pc.c3DepMatrix.length === 0) {
      const subtaskName = `Direct Transfer (${srcInst.bodyName} ➔ ${tgtInst.bodyName})`;
      const subInfo: SubtaskProgressInfo = {
        subtaskId: linkId,
        subtaskName,
        subtaskType: 'direct_link', // Type of subtask (direct transfer)
        computedSamples: 0,
        totalSamples: 100,
        progressPct: 0,
        statusText: `Computing direct transfer Lambert grid for ${srcInst.bodyName} ➔ ${tgtInst.bodyName}...`,
        parentTaskId: seqId,
      };
      reportSubtask(subInfo);
      onProgress?.(`Computing ${N}-Instance (${seqLabel}) — Subtask: ${subtaskName} (0%)`);
      await yieldUI(); // Yield to the event loop to avoid blocking the UI
      if (shouldStop?.()) break; // Abort if requested

      // Create a dummy link if none exists
      const dummyLink: DirectionalLink = link || {
        id: linkId,
        sourceInstanceId: srcInst.id,
        targetInstanceId: tgtInst.id,
      };

      // Compute the porkchop plot for this direct transfer
      pc = await computePorkchopPlot(
        dummyLink,
        srcInst,
        tgtInst,
        bodies,
        mainBody,
        // Callback for progress updates during porkchop computation
        (msg) => {
          const total = pc?.totalSamples;
          const comp = pc?.computedSamples;
          const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((comp / total) * 100))) : 0;
          reportSubtask({
            subtaskId: linkId,
            subtaskName,
            subtaskType: 'direct_link',
            computedSamples: comp,
            totalSamples: total,
            progressPct: pct,
            statusText: msg,
            parentTaskId: seqId,
          });
          onProgress?.(`Computing ${N}-Instance (${seqLabel}) — Subtask: ${subtaskName} (${pct}%)`);
        },
        // Callback for partial updates (e.g., intermediate results)
        (partialPc) => {
          const total = partialPc.totalSamples;
          const comp = partialPc.computedSamples;
          const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((comp / total) * 100))) : 0;
          porkchops[linkId] = partialPc; // Store partial result
          onDirectPorkchopUpdate?.({ [linkId]: partialPc }); // Notify UI
          reportSubtask({
            subtaskId: linkId,
            subtaskName,
            subtaskType: 'direct_link',
            computedSamples: comp,
            totalSamples: total,
            progressPct: pct,
            statusText: `Evaluating direct transfer Lambert grid...`,
            parentTaskId: seqId,
          });
        },
        shouldStop
      );
      // Store the computed porkchop plot
      porkchops[linkId] = pc;
      onDirectPorkchopUpdate?.({ [linkId]: pc });
    }
  }

  // --- 5. STEP 1.5: HANDLE SUB-CHAINS FOR N > 3 ---
  // For sequences with more than 3 instances, we need to compute sub-sequences recursively.
  // This improves efficiency by breaking the problem into smaller parts.
  let subChainStrategy: 'prefix' | 'suffix' = 'prefix';
  let pivotIndex = 1; // Default pivot index (index of the intermediate instance to split the sequence)
  let firstLeg : SequencePorkchopData | PorkchopPlotData | null = null;
  let lastLeg : SequencePorkchopData | PorkchopPlotData | null = null;
  
  const srcInst = pathInsts[0]; // First instance (e.g., Kerbin)
  const tgtInst = pathInsts[N - 1]; // Last instance (e.g., Jool)

  // --- 5.1. CHECK IF PREFIX SUB-CHAIN EXISTS ---
  // Prefix: All instances except the last one (e.g., [Kerbin, Eve, Duna] for [Kerbin, Eve, Duna, Jool])
  const prefixPath = pathInsts.slice(0, N - 1);
  const prefixKey = prefixPath.map(i => i.id).join('-');
  const prefixSeqId = `seq-pc-${prefixKey}`;
  // Try to find an existing prefix sub-sequence in the cache
  const prefixSeq = sequencePorkchops[prefixSeqId] ||
                    sequencePorkchops[prefixKey] ||
                    Object.values(sequencePorkchops).find(
                      s => s.id === prefixSeqId ||
                          s.id === prefixKey ||
                          [s.sourceBody.id, ...s.flybys.map(f => f.instance.id), s.targetBody.id].join('-') === prefixKey
                    );
  const hasPrefix = !!(prefixSeq && prefixSeq.depDates && prefixSeq.depDates.length > 0 &&
                    prefixSeq.arrDates && prefixSeq.arrDates.length > 0);

  // --- 5.2. CHECK IF SUFFIX SUB-CHAIN EXISTS ---
  // Suffix: All instances except the first one (e.g., [Eve, Duna, Jool] for [Kerbin, Eve, Duna, Jool])
  const suffixPath = pathInsts.slice(1, N);
  const suffixKey = suffixPath.map(i => i.id).join('-');
  const suffixSeqId = `seq-pc-${suffixKey}`;
  // Try to find an existing suffix sub-sequence in the cache
  const suffixSeq = sequencePorkchops[suffixSeqId] ||
                    sequencePorkchops[suffixKey] ||
                    Object.values(sequencePorkchops).find(
                      s => s.id === suffixSeqId ||
                          s.id === suffixKey ||
                          [s.sourceBody.id, ...s.flybys.map(f => f.instance.id), s.targetBody.id].join('-') === suffixKey
                    );
  const hasSuffix = !!(suffixSeq && suffixSeq.depDates && suffixSeq.depDates.length > 0 &&
                    suffixSeq.arrDates && suffixSeq.arrDates.length > 0);

  // --- 5.3. CHOOSE SUB-CHAIN STRATEGY ---
  // TODO: Improve this logic to dynamically choose the most efficient sub-chain (prefix or suffix)
  // based on computational cost (e.g., compare date window samples or orbital periods).
  // Currently, defaults to 'suffix' if neither is pre-calculated.
  if (hasPrefix && !hasSuffix) {
    subChainStrategy = 'prefix'; // Use prefix if only prefix is available
  } else {
    subChainStrategy = 'suffix'; // Default to suffix
    pivotIndex = N - 2;
  }

  // --- 5.4. COMPUTE MISSING SUB-CHAIN (SUFFIX OR PREFIX) ---
  if (subChainStrategy === 'suffix') {
    let suffixSeqObj = suffixSeq;
    if (!hasSuffix) {
      // Compute the suffix sub-sequence if it doesn't exist
      const subtaskName = `${suffixPath.length}-Instance Suffix Subsequence (${suffixPath.map(i => i.bodyName).join(' ➔ ')})`;
      const initSubInfo: SubtaskProgressInfo = {
        subtaskId: suffixSeqId,
        subtaskName,
        subtaskType: 'subsequence',
        computedSamples: 0,
        totalSamples: 100,
        progressPct: 0,
        statusText: `Computing prerequisite suffix subsequence (${subtaskName})...`,
        parentTaskId: seqId,
      };
      reportSubtask(initSubInfo);
      onProgress?.(`Computing ${N}-Instance (${seqLabel}) — Subtask: ${subtaskName} (0%)`);
      await yieldUI();

      const subSeq = await computeSequencePorkchopPlot({
        pathInsts: suffixPath, // Compute the suffix sub-sequence
        links,
        bodies,
        mainBody,
        onProgress: (msg) => {
          onProgress?.(`Computing ${N}-Instance (${seqLabel}) — Subtask: ${msg}`);
        },
        onPartialUpdate: (subPartial) => {
          const total = subPartial.totalSamples;
          const comp = subPartial.computedSamples;
          const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((comp / total) * 100))) : 0;
          sequencePorkchops[suffixSeqId] = subPartial;
          sequencePorkchops[suffixKey] = subPartial;
          onSequencePorkchopUpdate?.(subPartial);
          reportSubtask({
            subtaskId: suffixSeqId,
            subtaskName,
            subtaskType: 'subsequence',
            computedSamples: comp,
            totalSamples: total,
            progressPct: pct,
            statusText: `Evaluating multi-body trajectories and flybys...`,
            parentTaskId: seqId,
          });
        },
        shouldStop,
        isFullPath: false,
        porkchops: porkchops,
        sequencePorkchops: sequencePorkchops,
        onSubtaskProgress,
        onDirectPorkchopUpdate,
        onSequencePorkchopUpdate,
      });
      // Store the computed sub-sequence
      sequencePorkchops[suffixSeqId] = subSeq;
      sequencePorkchops[suffixKey] = subSeq;
      suffixSeqObj = subSeq;
      onSequencePorkchopUpdate?.(subSeq);
    }
    const P0_link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === pathInsts[1].id);
    firstLeg = porkchops[P0_link?.id || `link-${srcInst.id}-${pathInsts[1].id}`]!; // First leg porkchop
    lastLeg = suffixSeqObj!;
  } else {
    // Compute the prefix sub-sequence if it doesn't exist
    let prefixSeqObj = prefixSeq;
    if (!hasPrefix) {
      const subtaskName = `${prefixPath.length}-Instance Prefix Subsequence (${prefixPath.map(i => i.bodyName).join(' ➔ ')})`;
      const initSubInfo: SubtaskProgressInfo = {
        subtaskId: prefixSeqId,
        subtaskName,
        subtaskType: 'subsequence',
        computedSamples: 0,
        totalSamples: 100,
        progressPct: 0,
        statusText: `Computing prerequisite prefix subsequence (${subtaskName})...`,
        parentTaskId: seqId,
      };
      reportSubtask(initSubInfo);
      onProgress?.(`Computing ${N}-Instance (${seqLabel}) — Subtask: ${subtaskName} (0%)`);
      await yieldUI();

      const subSeq = await computeSequencePorkchopPlot({
        pathInsts: prefixPath, // Compute the prefix sub-sequence
        links,
        bodies,
        mainBody,
        onProgress: (msg) => {
          onProgress?.(`Computing ${N}-Instance (${seqLabel}) — Subtask: ${msg}`);
        },
        onPartialUpdate: (subPartial) => {
          const total = subPartial.totalSamples;
          const comp = subPartial.computedSamples;
          const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((comp / total) * 100))) : 0;
          sequencePorkchops[prefixSeqId] = subPartial;
          sequencePorkchops[prefixKey] = subPartial;
          onSequencePorkchopUpdate?.(subPartial);
          reportSubtask({
            subtaskId: prefixSeqId,
            subtaskName,
            subtaskType: 'subsequence',
            computedSamples: comp,
            totalSamples: total,
            progressPct: pct,
            statusText: `Evaluating multi-body trajectories and flybys...`,
            parentTaskId: seqId,
          });
        },
        shouldStop,
        isFullPath: false,
        porkchops: porkchops,
        sequencePorkchops: sequencePorkchops,
        onSubtaskProgress,
        onDirectPorkchopUpdate,
        onSequencePorkchopUpdate,
      });
      // Store the computed sub-sequence
      sequencePorkchops[prefixSeqId] = subSeq;
      sequencePorkchops[prefixKey] = subSeq;
      prefixSeqObj = subSeq;
      onSequencePorkchopUpdate?.(subSeq);
    }
    firstLeg = prefixSeqObj!;
    const Plast_link = links.find(l => l.sourceInstanceId === pathInsts[N - 2].id && l.targetInstanceId === tgtInst.id);
    lastLeg = porkchops[Plast_link?.id || `link-${pathInsts[N - 2].id}-${tgtInst.id}`]!; // Last leg porkchop
  }

  if (!firstLeg || !lastLeg) { throw new Error(`Failed to compute prerequisite sub-sequence for ${seqLabel}`); }

  // --- 6. CLEAR ACTIVE SUBTASK ---
  // Notify that subtasks are complete and main computation is starting
  reportSubtask(null);

  // --- 7. INITIALIZE SEQUENCE DATA STRUCTURES ---
  const flybyInsts = pathInsts.slice(1, -1); // All intermediate flyby instances

  // Extract departure and arrival dates from the first and last porkchop plots
  const depDates: number[] = firstLeg.depDates; // Departure dates (from first leg)
  const arrDates: number[] = lastLeg.arrDates; // Arrival dates (from last leg)

  const N_DEP = depDates.length; // Number of departure dates
  const N_ARR = arrDates.length; // Number of arrival dates

  // --- 8. INITIALIZE MATRICES FOR RESULTS ---
  // Matrices to store computed values for each (departure date, arrival date) pair
  const c3DepAMatrix: Vector3D[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })
  ); // Departure C3 matrix
  const c3ArrFinalMatrix: Vector3D[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })
  ); // Final arrival C3 matrix
  const totalPoweredDvMatrix: number[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(Infinity)
  ); // Total delta-v matrix
  const flightTimeMatrix: number[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(0)
  ); // Flight time matrix
  const physicalValidMatrix: boolean[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(false)
  ); // Physical validity matrix (e.g., trajectory is possible)
  const constraintValidMatrix: boolean[][] = Array.from({ length: N_DEP }, () =>
    Array(N_ARR).fill(false)
  ); // Constraint validity matrix (e.g., meets user constraints)

  // Initialize flyby data for each intermediate instance
  const flybys: SequencePorkchopFlybyData[] = flybyInsts.map(inst => ({
    instance: inst,
    poweredDvMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill(Infinity)), // Delta-v for each flyby
    c3ArrMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })), // C3 at arrival
    c3DepMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill({ x: Infinity, y: Infinity, z: Infinity })), // C3 at departure
    dateMatrix: Array.from({ length: N_DEP }, () => Array(N_ARR).fill(0)), // Flyby date
  }));

  const totalPoints = N_DEP * N_ARR; // Total number of (departure, arrival) pairs to evaluate

  // --- 9. INITIALIZE SEQUENCE DATA OBJECT ---
  const seqData: SequencePorkchopData = {
    id: seqId,
    sequenceLabel: seqLabel,
    isFullPath,
    instanceCount: N,
    sourceBody: srcInst,
    targetBody: tgtInst,
    depDates,
    arrDates,
    c3DepMatrix: c3DepAMatrix,
    c3ArrMatrix: c3ArrFinalMatrix,
    flybys,
    totalPoweredDvMatrix,
    flightTimeMatrix,
    physicalValidMatrix,
    constraintValidMatrix,
    computedSamples: 0,
    totalSamples: totalPoints,
    activeSubtask: null,
  };

  // --- 10. START PROFILING ---
  const profiler = new SequenceTransferProfiler(); // Track performance metrics
  const computationStartTime = performance.now(); // Start time for profiling

  // Emit initial state to open the sequence viewer immediately
  seqData.profiling = profiler.getStats(0, 0);
  onPartialUpdate?.({ ...seqData });

  // --- 11. HIERARCHICAL GRID EVALUATION ---
  // Use a hierarchical grid to evaluate points in passes (coarse to fine)
  const passes = getHierarchicalGridIndices(N_DEP, N_ARR); // Get grid evaluation order (e.g., from low to high resolution)
  const evaluated = Array.from({ length: N_DEP }, () => new Uint8Array(N_ARR)); // Track evaluated points

  let validCount = 0; // Count of valid (constraint + physical) trajectories
  let computedPointsCount = 0; // Total points evaluated so far
  let lastYieldTime = performance.now(); // Track time to yield to UI

  // Loop through each pass (resolution level)
  for (const pass of passes) {
    if (shouldStop?.()) break; // Abort if requested

    const S = pass.step; // Current step size (resolution)
    // Loop through each point in the current pass
    for (const [i, j] of pass.points) {
      if (shouldStop?.()) break;

      evaluated[i][j] = 1; // Mark this point as evaluated
      computedPointsCount++;

      const tDep = depDates[i]; // Departure date
      const tArr = arrDates[j]; // Arrival date
      const totalDt = tArr - tDep; // Total flight time
      flightTimeMatrix[i][j] = totalDt;

      // --- 11.1. EVALUATE SEQUENCE TRANSFER ---
      // Compute the best transfer for this (departure, arrival) pair
      let bestRes : SequenceTransferResult | null = null;
      if (totalDt > 0)
      {
        if (subChainStrategy === 'suffix') {
          bestRes = evaluateHigherOrderSequenceTransferAddFirstLeg(
            pathInsts,
            tDep,
            tArr,
            bodies,
            mainBody,
            porkchops,
            links,
            sequencePorkchops,
            profiler
          );
        } else {
          bestRes = evaluateHigherOrderSequenceTransferAddLastLeg(
            pathInsts,
            tDep,
            tArr,
            bodies,
            mainBody,
            porkchops,
            links,
            sequencePorkchops,
            profiler
          );
        }
      }

      // Check if the transfer is physically and constraint-valid
      const isPhysical = (totalDt > 0) && !!bestRes && (bestRes?.isPhysicallyValid !== false);
      const isConstraint = isPhysical && (bestRes?.isConstraintValid !== false);

      physicalValidMatrix[i][j] = isPhysical;
      constraintValidMatrix[i][j] = isConstraint;

      // --- 11.2. STORE RESULTS IF VALID ---
      if (bestRes) {
        c3DepAMatrix[i][j] = bestRes.c3DepA; // Departure C3
        c3ArrFinalMatrix[i][j] = bestRes.c3ArrFinal; // Final arrival C3
        totalPoweredDvMatrix[i][j] = bestRes.totalDv; // Total delta-v

        // Store flyby data for each intermediate instance
        for (let fb = 0; fb < flybys.length; fb++) {
          flybys[fb].poweredDvMatrix[i][j] = bestRes.flybyDvs?.[fb] ?? Infinity;
          flybys[fb].dateMatrix[i][j] = bestRes.flybyDates?.[fb] ?? 0;
          flybys[fb].c3ArrMatrix[i][j] = bestRes.flybyC3Arrs?.[fb] ?? { x: Infinity, y: Infinity, z: Infinity };
          flybys[fb].c3DepMatrix[i][j] = bestRes.flybyC3Deps?.[fb] ?? { x: Infinity, y: Infinity, z: Infinity };
        }

        if (isConstraint) validCount++; // Increment valid trajectory count
      }

      // --- 11.3. PREVIEW FILL FOR UNVISITED NEIGHBORS ---
      // For hierarchical grid: fill in neighboring cells with the same values
      // to provide a preview for unevaluated points in the current pass.
      for (let di = 0; di < S && i + di < N_DEP; di++) {
        const r = i + di; // Row index
        for (let dj = 0; dj < S && j + dj < N_ARR; dj++) {
          const c = j + dj; // Column index
          if (evaluated[r][c] === 0) { // If this neighbor hasn't been evaluated yet
            // Copy values from the current point (i,j) to the neighbor (r,c)
            flightTimeMatrix[r][c] = flightTimeMatrix[i][j];
            physicalValidMatrix[r][c] = physicalValidMatrix[i][j];
            constraintValidMatrix[r][c] = constraintValidMatrix[i][j];
            c3DepAMatrix[r][c] = c3DepAMatrix[i][j];
            c3ArrFinalMatrix[r][c] = c3ArrFinalMatrix[i][j];
            totalPoweredDvMatrix[r][c] = totalPoweredDvMatrix[i][j];

            // Copy flyby data for all intermediate instances
            for (let fb = 0; fb < flybys.length; fb++) {
              flybys[fb].poweredDvMatrix[r][c] = flybys[fb].poweredDvMatrix[i][j];
              flybys[fb].dateMatrix[r][c] = flybys[fb].dateMatrix[i][j];
              flybys[fb].c3ArrMatrix[r][c] = flybys[fb].c3ArrMatrix[i][j];
              flybys[fb].c3DepMatrix[r][c] = flybys[fb].c3DepMatrix[i][j];
            }
          }
        }
      }

      // --- 11.4. YIELD TO UI PERIODICALLY ---
      // Update progress and yield to the UI every ~50ms to avoid freezing
      const now = performance.now();
      if (now - lastYieldTime > 50) {
        lastYieldTime = now;
        seqData.computedSamples = computedPointsCount;
        seqData.totalSamples = totalPoints;
        seqData.profiling = profiler.getStats(now - computationStartTime, computedPointsCount);
        const pct = Math.floor((computedPointsCount / totalPoints) * 100);
        onProgress?.(`Computing sequence porkchop plot for ${seqLabel} (${pct}%, ${validCount} valid)...`);
        onPartialUpdate?.({ ...seqData }); // Send partial results to UI
        await yieldUI(); // Yield to the event loop
      }
    }
  }

  // --- 12. FINALIZE AND RETURN RESULTS ---
  // Update final stats and return the complete sequence porkchop data
  seqData.computedSamples = totalPoints;
  seqData.totalSamples = totalPoints;
  seqData.profiling = profiler.getStats(performance.now() - computationStartTime, totalPoints);
  onPartialUpdate?.({ ...seqData }); // Final update
  return seqData;
}

export const computeNBodySequencePorkchopPlot = computeSequencePorkchopPlot;

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
  bodies: OrbitalBody[],
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
  const bodyMap = new Map<string, OrbitalBody>();
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
      if (Math.abs(vecMag(a.depC3) - vecMag(b.depC3)) > 1e-3) return vecMag(a.depC3) - vecMag(b.depC3);
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
        const matrix = pc.constraintValidMatrix || pc.physicalValidMatrix;
        if (matrix) {
          for (let r = 0; r < matrix.length; r++) {
            for (let c = 0; c < matrix[r].length; c++) {
              if (matrix[r][c]) valid++;
            }
          }
          return valid;
        }
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

      const srcBody = bodyMap.get(bestPair.srcInst.bodyName)!;
      const flybyBody = bodyMap.get(bestPair.flybyInst.bodyName)!;
      const tgtBody = bodyMap.get(bestPair.tgtInst.bodyName)!;

      const constrMatrix1 = pc1.constraintValidMatrix || pc1.physicalValidMatrix;
      const constrMatrix2 = pc2.constraintValidMatrix || pc2.physicalValidMatrix;

      const newValid1 = constrMatrix1?.map(row => [...row]) ?? [];
      const newValid2 = constrMatrix2?.map(row => [...row]) ?? [];

      const validEntry1 = constrMatrix1?.map(row => row.map(() => false)) ?? [];
      const validEntry2 = constrMatrix2?.map(row => row.map(() => false)) ?? [];

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
            if (!constrMatrix1?.[i]?.[j]) continue;
            const vTransIn1 = pc1.vTransArrMatrix?.[i]?.[j];
            const vTransIn2 = pc1.vTransArrMatrix?.[i]?.[j2];
            if (!vTransIn1 || !vTransIn2) continue;

            const vInfIn1 = vecSub(vTransIn1, stBody1.vel);
            const vInfIn2 = vecSub(vTransIn2, stBody2.vel);

            for (let n = 0; n < pc2.arrDates.length; n++) {
              if (!constrMatrix2?.[m]?.[n]) continue;
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
                bestPair.flybyInst.minFlybyAltitude
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
      if (constrMatrix1) {
        for (let r = 0; r < constrMatrix1.length; r++) {
          for (let c = 0; c < constrMatrix1[r].length; c++) {
            if (constrMatrix1[r][c]) count1++;
          }
        }
      }

      let count2 = 0;
      if (constrMatrix2) {
        for (let r = 0; r < constrMatrix2.length; r++) {
          for (let c = 0; c < constrMatrix2[r].length; c++) {
            if (constrMatrix2[r][c]) count2++;
          }
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
        const seqPc = await computeSequencePorkchopPlot({
          pathInsts: cand.pathInsts,
          bodies,
          mainBody,
          links: currLinks,
          porkchops,
          sequencePorkchops,
          onProgress,
          onPartialUpdate: (partialSeq) => {
            sequencePorkchops[partialSeq.id] = partialSeq;
            onPartialUpdate?.({
              instances: currInstances,
              links: currLinks,
              porkchops: { ...porkchops },
              sequencePorkchops: { ...sequencePorkchops },
            });
          },
          shouldStop,
          isFullPath: cand.isFullPath,
        });
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
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  outputSequences: FlyableSequenceResult[],
  onProgress?: ProgressCallback,
  shouldStop?: () => boolean
) {
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));
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

    const prevBody = bodyMap.get(prevInst.bodyName)!;
    const currBody = bodyMap.get(currInst.bodyName)!;

    const minDur = pathLinks[linkIdx].minFlightDuration ?? 0;
    const maxDur = pathLinks[linkIdx].maxFlightDuration ?? Infinity;

    const sPrev = getBodyStateAtUT(prevBody, mainBody, tPrev);

    const i = pc.depDates.indexOf(tPrev);
    if (i === -1) return;

    for (let j = 0; j < pc.arrDates.length; j++) {
      if (outputSequences.length >= 150) break;
      if (shouldStop?.()) break;

      if (!pc.constraintValidMatrix?.[i]?.[j]) continue;

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
          prevInst.minFlybyAltitude
        );

        if (!flybyFeas.isValid || flybyFeas.matchedFlybyDate === undefined) continue;

        const matchedFlybyUT = flybyFeas.matchedFlybyDate;

        currentFlybyDetail = {
          bodyName: prevBody.name,
          instanceId: prevInst.id,
          flybyDate: matchedFlybyUT,
          flybyDateSampling: Math.abs(t2 - t1),
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
        const depState = getBodyStateAtUT(bodyMap.get(pathInsts[0].bodyName)!, mainBody, currentChain[0].ut);
        const arrState = getBodyStateAtUT(currBody, mainBody, tCurr);

        const solFirst = newChain[1].solFromPrev!;
        const solLast = newChain[numLinks].solFromPrev!;

        const vInfDep = vecSub(solFirst.v1, depState.vel);
        const vInfArr = vecSub(solLast.v2, arrState.vel);

        const depC3 = vecScale(vInfDep, vecMag(vInfDep) / 1e6);
        const arrC3 = vecScale(vInfArr, vecMag(vInfArr) / 1e6);

        if (pathInsts[0].maxC3 !== undefined && vecMag(depC3) > pathInsts[0].maxC3) continue;
        if (currInst.maxC3 !== undefined && vecMag(arrC3) > currInst.maxC3) continue;

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

          const bSrc = bodyMap.get(pathInsts[k - 1].bodyName)!;
          const bTgt = bodyMap.get(pathInsts[k].bodyName)!;

          const stSrc = getBodyStateAtUT(bSrc, mainBody, prevK.ut);
          const stTgt = getBodyStateAtUT(bTgt, mainBody, stepK.ut);

          const solK = stepK.solFromPrev!;
          const vDep = vecSub(solK.v1, stSrc.vel);
          const vArr = vecSub(solK.v2, stTgt.vel);

          transfers.push({
            depDate: prevK.ut,
            arrDate: stepK.ut,
            flightTime: stepK.ut - prevK.ut,
            vInfDep: {x: vDep.x, y: vDep.y, z: vDep.z},
            vInfArr: {x: vArr.x, y: vArr.y, z: vArr.z},
            c3Dep: (vecMag(vDep) ** 2) / 1e6,
            c3Arr: (vecMag(vArr) ** 2) / 1e6,
            depAngle: 0,
            arrAngle: 0,
            transferOrbitSemiMajorAxis: solK.semiMajorAxis,
            vTransDep: {x: solK.v1.x, y: solK.v1.y, z: solK.v1.z},
            vTransArr: {x: solK.v2.x, y: solK.v2.y, z: solK.v2.z},
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
  bodies: OrbitalBody[],
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

  const bodyMap = new Map<string, OrbitalBody>();
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

        const depBody = bodyMap.get(depInstNode.bodyName)!;
        const arrBody = bodyMap.get(arrInstNode.bodyName)!;

        const depState = getBodyStateAtUT(depBody, mainBody, currentTransfers[0].depDate);
        const arrState = getBodyStateAtUT(arrBody, mainBody, tPrev);

        const vInfDepVec = vecSub(solFirst.v1, depState.vel);
        const vInfArrVec = vecSub(solLast.v2, arrState.vel);

        const depC3 = vecScale(vInfDepVec, vecMag(vInfDepVec) / 1e6);
        const arrC3 = vecScale(vInfArrVec, vecMag(vInfArrVec) / 1e6);

        if (depInstNode.maxC3 !== undefined && vecMag(depC3) > depInstNode.maxC3) return;
        if (arrInstNode.maxC3 !== undefined && vecMag(arrC3) > arrInstNode.maxC3) return;

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

      const srcBody = bodyMap.get(srcNode.bodyName)!;
      const tgtBody = bodyMap.get(tgtNode.bodyName)!;

      const aSrc = srcBody.semiMajorAxis;
      const aTgt = tgtBody.semiMajorAxis;
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
            srcNode.minFlybyAltitude
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
          vInfDep: { x: vInfDepVec.x, y: vInfDepVec.y, z: vInfDepVec.z },
          vInfArr: { x: vInfArrVec.x, y: vInfArrVec.y, z: vInfArrVec.z },
          c3Dep: (vecMag(vInfDepVec) ** 2) / 1e6,
          c3Arr: (vecMag(vInfArrVec) ** 2) / 1e6,
          depAngle: 0,
          arrAngle: 0,
          transferOrbitSemiMajorAxis: sol.semiMajorAxis,
          vTransDep: { x: sol.v1.x, y: sol.v1.y, z: sol.v1.z },
          vTransArr: { x: sol.v2.x, y: sol.v2.y, z: sol.v2.z },
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
        const score = vecMag(c.depC3) + vecMag(c.arrC3) + (c.totalStochasticDv / 1000) ** 2;
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
    const scoreA = vecMag(a.depC3) + vecMag(a.arrC3) + (a.totalStochasticDv / 1000) ** 2;
    const scoreB = vecMag(b.depC3) + vecMag(b.arrC3) + (b.totalStochasticDv / 1000) ** 2;
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

/**
 * Extract flyable sequences directly from sequence porkchop plots
 * filters for samples where each flyby delta-v <= maxFlybyDvMs (e.g. 1.0 m/s)
 * No new Lambert compute is needed as values are taken from the computed porkchops.
 */
export function extractSequencesFromSequencePorkchops(
  sequencePorkchops: Record<string, SequencePorkchopData>,
  candidatePaths: CandidateSequencePath[],
  instances: InstanceNode[],
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  maxFlybyDvMs: number = 1.0
): FlyableSequenceResult[] {
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));
  const results: FlyableSequenceResult[] = [];

  const fullPathCands = candidatePaths.filter(c => c.isFullPath);

  for (const cand of fullPathCands) {
    const pathKey = cand.pathInsts.map(i => i.id).join('-');
    const seqPc = sequencePorkchops[cand.id] || sequencePorkchops[`seq-pc-${pathKey}`] || sequencePorkchops[pathKey] || Object.values(sequencePorkchops).find(
      s => s.id === cand.id || [s.sourceBody.id, ...s.flybys.map(f => f.instance.id), s.targetBody.id].join('-') === pathKey
    );
    if (!seqPc || !seqPc.depDates || !seqPc.arrDates || (!seqPc.constraintValidMatrix && !seqPc.physicalValidMatrix)) continue;

    const pathInsts = cand.pathInsts;
    const numInsts = pathInsts.length;
    const flybyInsts = pathInsts.slice(1, numInsts - 1);
    const numFlybys = flybyInsts.length;

    for (let r = 0; r < seqPc.depDates.length; r++) {
      for (let c = 0; c < seqPc.arrDates.length; c++) {
        if (!seqPc.constraintValidMatrix?.[r]?.[c]) continue;

        const depDate = seqPc.depDates[r];
        const arrDate = seqPc.arrDates[c];
        const depC3 = seqPc.c3DepMatrix?.[r]?.[c];
        const arrC3 = seqPc.c3ArrMatrix?.[r]?.[c];

        const srcInst = pathInsts[0];
        const tgtInst = pathInsts[numInsts - 1];
        const TOL_C3 = 0.05;

        // Check source C3 limits
        const depC3Mag = (depC3 && typeof depC3 === 'object' && Number.isFinite(depC3.x)) ? vecMag(depC3) : Infinity;
        if (srcInst.computedMinC3 !== undefined && depC3Mag < srcInst.computedMinC3 - TOL_C3) continue;
        if (srcInst.computedMaxC3 !== undefined && depC3Mag > srcInst.computedMaxC3 + TOL_C3) continue;
        if (srcInst.maxC3 !== undefined && depC3Mag > srcInst.maxC3 + TOL_C3) continue;

        // Check target C3 limits
        const arrC3Mag = (arrC3 && typeof arrC3 === 'object' && Number.isFinite(arrC3.x)) ? vecMag(arrC3) : Infinity;
        if (tgtInst.computedMinC3 !== undefined && arrC3Mag < tgtInst.computedMinC3 - TOL_C3) continue;
        if (tgtInst.computedMaxC3 !== undefined && arrC3Mag > tgtInst.computedMaxC3 + TOL_C3) continue;
        if (tgtInst.maxC3 !== undefined && arrC3Mag > tgtInst.maxC3 + TOL_C3) continue;

        // Check if each flyby delta-v is <= maxFlybyDvMs (1.0 m/s)
        let passesFlybyDvCheck = true;
        const flybyDetails: FlybyDetail[] = [];
        let totalPoweredDv = 0;
        let totalStochasticDv = 0;

        for (let fb = 0; fb < numFlybys; fb++) {
          const fbInst = flybyInsts[fb];
          const fbBody = bodyMap.get(fbInst.bodyName) || mainBody;
          const flyby : SequencePorkchopFlybyData = seqPc.flybys[fb];

          let fbDv = 0;
          const rawFbDv = flyby.poweredDvMatrix?.[r]?.[c];
          if (rawFbDv !== undefined && Number.isFinite(rawFbDv)) {
            fbDv = rawFbDv;
          }

          if (fbDv > maxFlybyDvMs) {
            passesFlybyDvCheck = false;
            break;
          }

          const c3In = flyby.c3ArrMatrix?.[r]?.[c];
          const c3Out = flyby.c3DepMatrix?.[r]?.[c];
          const c3InMag = (c3In && typeof c3In === 'object' && Number.isFinite(c3In.x)) ? vecMag(c3In) : 0;
          const c3OutMag = (c3Out && typeof c3Out === 'object' && Number.isFinite(c3Out.x)) ? vecMag(c3Out) : 0;

          if (fbInst.computedMinC3 !== undefined && (c3InMag < fbInst.computedMinC3 - TOL_C3 || c3OutMag < fbInst.computedMinC3 - TOL_C3)) {
            passesFlybyDvCheck = false;
            break;
          }
          if (fbInst.computedMaxC3 !== undefined && (c3InMag > fbInst.computedMaxC3 + TOL_C3 || c3OutMag > fbInst.computedMaxC3 + TOL_C3)) {
            passesFlybyDvCheck = false;
            break;
          }
          if (fbInst.maxC3 !== undefined && (c3InMag > fbInst.maxC3 + TOL_C3 || c3OutMag > fbInst.maxC3 + TOL_C3)) {
            passesFlybyDvCheck = false;
            break;
          }

          totalPoweredDv += fbDv;

          const rawFbDate = seqPc.flybys[fb]?.dateMatrix?.[r]?.[c];
          const fbDate = Number.isFinite(rawFbDate) && rawFbDate !== undefined
            ? rawFbDate
            : depDate + (arrDate - depDate) * ((fb + 1) / (numFlybys + 1));

          const vInfIn = (c3In && c3InMag > 1e-12)
            ? vecScale(c3In, KM_S_TO_M_S / Math.sqrt(c3InMag))
            : { x: 0, y: 0, z: 0 };
          const vInfOut = (c3Out && c3OutMag > 1e-12)
            ? vecScale(c3Out, KM_S_TO_M_S / Math.sqrt(c3OutMag))
            : { x: 0, y: 0, z: 0 };
          const vInfInMag = (c3InMag > 1e-12) ? Math.sqrt(c3InMag) * KM_S_TO_M_S : 0;
          const vInfOutMag = (c3OutMag > 1e-12) ? Math.sqrt(c3OutMag) * KM_S_TO_M_S : 0;
          const meanVInfMag = (vInfInMag + vInfOutMag) / 2;

          const muBody = fbBody.stdGravParam;
          const rPeri = getMinFlybyRadius(fbBody, fbInst.minFlybyAltitude);
          const maxTurnAngle = computeMaxDeflectionAngle(rPeri, meanVInfMag, muBody);

          // Compute deflection angle from flyby delta-V and max turning angle
          const deflectionAngle = (vInfInMag > 1e-3 && vInfOutMag > 1e-3)
            ? angleBetweenVecs(vInfIn, vInfOut)
            : 0;

          // Compute periapsis radius from deflection angle at meanVInfMag
          const periapsisRadius = computePeriapsisRadiusFromDeflection(
            deflectionAngle,
            meanVInfMag,
            muBody,
            rPeri
          );

          // Compute stochastic delta-V by calling flyby.ts function
          const periapsisAlt = periapsisRadius - fbBody.radius;
          const stochasticDv = computeFlybyStochasticDv(
            fbBody,
            periapsisAlt,
            vInfInMag,
            vInfOutMag,
          );
          totalStochasticDv += stochasticDv + fbDv;

          const minAlt = getMinFlybyAlt(fbBody, fbInst.minFlybyAltitude);
          const flybyMargin = periapsisAlt - minAlt;

          flybyDetails.push({
            bodyName: fbInst.bodyName,
            instanceId: fbInst.id,
            flybyDate: fbDate,
            flybyDateSampling: 86400,
            periapsisAlt: Number.isFinite(periapsisAlt) ? periapsisAlt : 0,
            flybyMargin: Number.isFinite(flybyMargin) ? flybyMargin : 0,
            deflectionAngle: Number.isFinite(deflectionAngle) ? deflectionAngle : 0,
            maxDeflectionAngle: Number.isFinite(maxTurnAngle) ? maxTurnAngle : 0,
            stochasticDv: Number.isFinite(stochasticDv) ? stochasticDv : 0,
            poweredDv: Number.isFinite(fbDv) ? fbDv : 0,
            vInfInMag: Number.isFinite(vInfInMag) ? vInfInMag : 0,
            vInfOutMag: Number.isFinite(vInfOutMag) ? vInfOutMag : 0,
          });
        }

        if (!passesFlybyDvCheck) continue;

        // Build transfers list between consecutive bodies
        const transfers: LambertTransferResult[] = [];
        const legDates: number[] = [depDate, ...flybyDetails.map(f => f.flybyDate), arrDate];
        const minAllowedRadius = getMinFlybyRadius(mainBody, undefined);

        for (let legIdx = 0; legIdx < pathInsts.length - 1; legIdx++) {
          const tDepLeg = legDates[legIdx];
          const tArrLeg = legDates[legIdx + 1];
          const legDt = Math.max(1, tArrLeg - tDepLeg);

          const srcBodyLeg = bodyMap.get(pathInsts[legIdx].bodyName);
          const tgtBodyLeg = bodyMap.get(pathInsts[legIdx + 1].bodyName);

          if (srcBodyLeg && tgtBodyLeg) {
            const stSrcLeg = getBodyStateAtUT(srcBodyLeg, mainBody, tDepLeg);
            const stTgtLeg = getBodyStateAtUT(tgtBodyLeg, mainBody, tArrLeg);
            const legSol = solveLambert(stSrcLeg.pos, stTgtLeg.pos, legDt, mainBody.stdGravParam, true, minAllowedRadius);

            const vDepRel = vecSub(legSol.v1, stSrcLeg.vel);
            const vArrRel = vecSub(legSol.v2, stTgtLeg.vel);

            transfers.push({
              linkId: `link-${pathInsts[legIdx].id}-${pathInsts[legIdx + 1].id}`,
              sourceInstanceId: pathInsts[legIdx].id,
              targetInstanceId: pathInsts[legIdx + 1].id,
              depDate: tDepLeg,
              arrDate: tArrLeg,
              flightTime: legDt,
              vInfDep: vDepRel,
              vInfArr: vArrRel,
              c3Dep: (vecMag(vDepRel) ** 2) / 1e6,
              c3Arr: (vecMag(vArrRel) ** 2) / 1e6,
              depAngle: 0,
              arrAngle: 0,
              transferOrbitSemiMajorAxis: legSol.semiMajorAxis,
              vTransDep: legSol.v1,
              vTransArr: legSol.v2,
              isValid: legSol.isValid,
              sol: legSol
            });
          }
        }

        const rawFlightTime = seqPc.flightTimeMatrix?.[r]?.[c];
        const totalFlightTime = Number.isFinite(rawFlightTime) && rawFlightTime !== undefined && rawFlightTime > 0
          ? rawFlightTime
          : (arrDate - depDate);

        results.push({
          id: `seq-pc-cand-${cand.id}-${r}-${c}`,
          instanceIds: pathInsts.map(i => i.id),
          bodyNames: pathInsts.map(i => i.bodyName),
          depDate,
          arrDate,
          depC3,
          arrC3,
          totalFlightTime,
          totalStochasticDv: Number.isFinite(totalStochasticDv) ? totalStochasticDv : 0,
          totalDv: Number.isFinite(totalPoweredDv) ? totalPoweredDv : 0,
          flybys: flybyDetails,
          transfers
        });
      }
    }
  }

  // Sort results by sum of (C3d + C3a + stochasticDv^2)
  return results.sort((a, b) => {
    const costA = vecMag(a.depC3) + vecMag(a.arrC3) + ((a.totalStochasticDv / 1000) ** 2);
    const costB = vecMag(b.depC3) + vecMag(b.arrC3) + ((b.totalStochasticDv / 1000) ** 2);
    return costA - costB;
  });
}

/**
 * Filters sequence results based on Pareto dominance and adjacent departure date window clustering:
 * 1. For elements of the same "Flyby sequence Path", sorted by increasing departure date,
 *    remove elements which depart earlier than others while having a bigger (sum C3 + Stoch dv²).
 * 2. Then starting by the end, remove an element if the previous element departure date
 *    has the same departure date or the sample just before.
 */
export function filterOptimalDepartureSequenceResults(
  sequenceResults: FlyableSequenceResult[],
  instances: InstanceNode[],
  links: DirectionalLink[],
  sequencePorkchops?: Record<string, SequencePorkchopData>
): FlyableSequenceResult[] {
  if (!sequenceResults || sequenceResults.length === 0) return [];

  const getCost = (seq: FlyableSequenceResult): number => {
    const depC3Mag = vecMag(seq.depC3);
    const arrC3Mag = vecMag(seq.arrC3);
    const stochDvKms = (seq.totalStochasticDv || 0) / 1000;
    return depC3Mag + arrC3Mag + stochDvKms * stochDvKms;
  };

  // Group elements by Flyby sequence Path (e.g. "Kerbin ➔ Eve ➔ Duna")
  const pathGroups = new Map<string, FlyableSequenceResult[]>();
  for (const seq of sequenceResults) {
    const pathKey = seq.bodyNames.join(' ➔ ');
    if (!pathGroups.has(pathKey)) {
      pathGroups.set(pathKey, []);
    }
    pathGroups.get(pathKey)!.push(seq);
  }

  const keptResults: FlyableSequenceResult[] = [];

  for (const [pathKey, group] of pathGroups.entries()) {
    if (group.length <= 1) {
      keptResults.push(...group);
      continue;
    }

    // Determine the departure date sampling step for this path
    let sampleStep = 86400; // default 1 day (seconds)
    let foundStep = false;

    // Check if matching sequence porkchop exists with depDates
    if (sequencePorkchops) {
      const matchedSeqPc = Object.values(sequencePorkchops).find(
        spc => [spc.sourceBody?.bodyName, ...spc.flybys.map(f => f.instance?.bodyName), spc.targetBody?.bodyName].join(' ➔ ') === pathKey ||
               [spc.sourceBody?.id, ...spc.flybys.map(f => f.instance?.id), spc.targetBody?.id].join('-') === group[0].instanceIds?.join('-')
      );
      if (matchedSeqPc && matchedSeqPc.depDates && matchedSeqPc.depDates.length >= 2) {
        sampleStep = Math.abs(matchedSeqPc.depDates[1] - matchedSeqPc.depDates[0]);
        foundStep = true;
      }
    }

    // Check source instance date sample configuration
    if (!foundStep && group[0].instanceIds && group[0].instanceIds.length > 0) {
      const srcId = group[0].instanceIds[0];
      const srcInst = instances.find(i => i.id === srcId);
      if (srcInst) {
        const minD = srcInst.minDate ?? srcInst.computedMinDate ?? 0;
        const maxD = srcInst.maxDate ?? srcInst.computedMaxDate ?? (minD + 86400 * 100);
        if (srcInst.dateSampleCount && srcInst.dateSampleCount > 1) {
          sampleStep = (maxD - minD) / (srcInst.dateSampleCount - 1);
          foundStep = true;
        } else {
          const firstLink = links.find(l => l.sourceInstanceId === srcId);
          const nDep = firstLink?.departureSampleCount || 10;
          if (nDep > 1) {
            sampleStep = (maxD - minD) / (nDep - 1);
            foundStep = true;
          }
        }
      }
    }

    // Fallback: detect from distinct departure dates within this group
    if (!foundStep) {
      const sortedDates = Array.from(new Set(group.map(g => g.depDate))).sort((a, b) => a - b);
      let minDiff = Infinity;
      for (let i = 1; i < sortedDates.length; i++) {
        const d = sortedDates[i] - sortedDates[i - 1];
        if (d > 1e-2 && d < minDiff) {
          minDiff = d;
        }
      }
      if (isFinite(minDiff)) {
        sampleStep = minDiff;
      }
    }

    // Step 1: Sort by increasing departure date (and lower cost first if same date)
    const sortedGroup = [...group].sort((a, b) => {
      const dDate = a.depDate - b.depDate;
      if (Math.abs(dDate) > 1e-4) return dDate;
      return getCost(a) - getCost(b);
    });

    // Remove elements which depart earlier than other while having a bigger (sum C3 + Stoch dv²)
    // Scanning from right to left (latest departure to earliest departure):
    const stage1Kept: FlyableSequenceResult[] = [];
    let minCostLater = Infinity;

    for (let i = sortedGroup.length - 1; i >= 0; i--) {
      const item = sortedGroup[i];
      const itemCost = getCost(item);

      // If itemCost is greater than any element departing later, remove it
      if (itemCost > minCostLater + 1e-6) {
        continue;
      }

      stage1Kept.push(item);
      minCostLater = Math.min(minCostLater, itemCost);
    }

    // Restore increasing departure date order
    stage1Kept.reverse();

    if (stage1Kept.length <= 1) {
      keptResults.push(...stage1Kept);
      continue;
    }

    // Step 2: Starting by the end, remove an element if the previous element departure date
    // has the same departure date or the sample just before
    const currentList = [...stage1Kept];
    for (let i = currentList.length - 1; i >= 1; i--) {
      const curr = currentList[i];
      const prev = currentList[i - 1];
      const dateDiff = curr.depDate - prev.depDate;

      const isSameDate = Math.abs(dateDiff) <= 1e-2;
      const isSampleJustBefore = dateDiff > 1e-2 && dateDiff <= sampleStep * 1.05 + 1.0;

      if (isSameDate || isSampleJustBefore) {
        currentList.splice(i, 1);
      }
    }

    keptResults.push(...currentList);
  }

  return keptResults;
}


