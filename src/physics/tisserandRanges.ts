/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { InstanceNode, DirectionalLink, CelestialBody } from '../types';
import { getBodyStateAtUT, vecMag, vecSub } from './kepler';
import { solveLambertBest } from './lambert';
import { computeTisserandEnvelopes, findAllSubPathsInGraph, countPossibleTransfers } from './solver';

export interface LinkEndDateRanges {
  linkId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  sourceBodyName: string;
  targetBodyName: string;

  // Departure End (at sourceInstance)
  depDateMin: number; // UT sec
  depDateMax: number; // UT sec
  depVinfMin: number; // m/s achieved
  depVinfMax: number; // m/s achieved
  depTargetVinfRange: { minMs: number; maxMs: number };
  hasValidDepRange: boolean;

  // Arrival End (at targetInstance)
  arrDateMin: number; // UT sec
  arrDateMax: number; // UT sec
  arrVinfMin: number; // m/s achieved
  arrVinfMax: number; // m/s achieved
  arrTargetVinfRange: { minMs: number; maxMs: number };
  hasValidArrRange: boolean;
}

export interface Sequence3BodyConsolidatedRange {
  sequenceId: string;
  sequenceLabel: string;
  pathInsts: InstanceNode[];

  sourceInstance: InstanceNode;
  flybyInstance: InstanceNode;
  targetInstance: InstanceNode;

  link1: DirectionalLink;
  link2: DirectionalLink;

  // Link 1 arrival date range at flybyInstance
  link1ArrMin: number;
  link1ArrMax: number;

  // Link 2 departure date range at flybyInstance
  link2DepMin: number;
  link2DepMax: number;

  // Consolidated Intersection Date Range at flybyInstance
  consolidatedFlybyMin: number;
  consolidatedFlybyMax: number;
  hasFlybyOverlap: boolean;
  overlapDurationSec: number;

  // Consolidated Departure Date Range at sourceInstance
  consolidatedDepMin: number;
  consolidatedDepMax: number;

  // Consolidated Arrival Date Range at targetInstance
  consolidatedArrMin: number;
  consolidatedArrMax: number;
}

/**
 * Evaluates the optimal departure v_inf for a given departure date across a range of arrival dates.
 */
function evalMinDepVinf(
  depDate: number,
  srcBody: CelestialBody,
  tgtBody: CelestialBody,
  mainBody: CelestialBody,
  arrDates: number[],
  minDur: number,
  maxDur: number
): { minDepVinfMs: number; minArrVinfMs: number; bestArrDate: number } {
  const muCentral = mainBody.stdGravParam || 1.32712440018e20;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));
  const srcState = getBodyStateAtUT(srcBody, mainBody, depDate);

  let minDepVinfMs = Infinity;
  let minArrVinfMs = Infinity;
  let bestArrDate = arrDates[0] || depDate + minDur;

  for (const arrDate of arrDates) {
    const dt = arrDate - depDate;
    if (dt < minDur || dt > maxDur) continue;

    const tgtState = getBodyStateAtUT(tgtBody, mainBody, arrDate);
    const sol = solveLambertBest(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius, srcState.vel, tgtState.vel);

    if (sol.isValid) {
      const vInfDep = vecSub(sol.v1, srcState.vel);
      const vInfArr = vecSub(sol.v2, tgtState.vel);
      const depMag = vecMag(vInfDep);
      const arrMag = vecMag(vInfArr);

      if (depMag < minDepVinfMs) {
        minDepVinfMs = depMag;
        minArrVinfMs = arrMag;
        bestArrDate = arrDate;
      }
    }
  }

  return { minDepVinfMs, minArrVinfMs, bestArrDate };
}

/**
 * Evaluates the optimal arrival v_inf for a given arrival date across a range of departure dates.
 */
function evalMinArrVinf(
  arrDate: number,
  srcBody: CelestialBody,
  tgtBody: CelestialBody,
  mainBody: CelestialBody,
  depDates: number[],
  minDur: number,
  maxDur: number
): { minArrVinfMs: number; minDepVinfMs: number; bestDepDate: number } {
  const muCentral = mainBody.stdGravParam || 1.32712440018e20;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));
  const tgtState = getBodyStateAtUT(tgtBody, mainBody, arrDate);

  let minArrVinfMs = Infinity;
  let minDepVinfMs = Infinity;
  let bestDepDate = depDates[0] || arrDate - minDur;

  for (const depDate of depDates) {
    const dt = arrDate - depDate;
    if (dt < minDur || dt > maxDur) continue;

    const srcState = getBodyStateAtUT(srcBody, mainBody, depDate);
    const sol = solveLambertBest(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius, srcState.vel, tgtState.vel);

    if (sol.isValid) {
      const vInfDep = vecSub(sol.v1, srcState.vel);
      const vInfArr = vecSub(sol.v2, tgtState.vel);
      const depMag = vecMag(vInfDep);
      const arrMag = vecMag(vInfArr);

      if (arrMag < minArrVinfMs) {
        minArrVinfMs = arrMag;
        minDepVinfMs = depMag;
        bestDepDate = depDate;
      }
    }
  }

  return { minArrVinfMs, minDepVinfMs, bestDepDate };
}

/**
 * Dichotomic (bisection) search to locate exact boundary date to 0.01 day precision.
 */
function bisectDepBoundary(
  tValid: number,
  tInvalid: number,
  srcBody: CelestialBody,
  tgtBody: CelestialBody,
  mainBody: CelestialBody,
  arrDates: number[],
  vInfMax: number,
  minDur: number,
  maxDur: number,
  timeFormatMode: 'ksp' | 'earth'
): number {
  const secondsPerDay = timeFormatMode === 'ksp' ? 21600 : 86400;
  const toleranceSec = 0.01 * secondsPerDay;

  let low = tValid;
  let high = tInvalid;

  for (let iter = 0; iter < 25; iter++) {
    if (Math.abs(high - low) <= toleranceSec) break;
    const mid = (low + high) / 2;
    const res = evalMinDepVinf(mid, srcBody, tgtBody, mainBody, arrDates, minDur, maxDur);
    const isValid = res.minDepVinfMs <= vInfMax + 1.0;

    if (isValid) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

function bisectArrBoundary(
  tValid: number,
  tInvalid: number,
  srcBody: CelestialBody,
  tgtBody: CelestialBody,
  mainBody: CelestialBody,
  depDates: number[],
  vInfMax: number,
  minDur: number,
  maxDur: number,
  timeFormatMode: 'ksp' | 'earth'
): number {
  const secondsPerDay = timeFormatMode === 'ksp' ? 21600 : 86400;
  const toleranceSec = 0.01 * secondsPerDay;

  let low = tValid;
  let high = tInvalid;

  for (let iter = 0; iter < 25; iter++) {
    if (Math.abs(high - low) <= toleranceSec) break;
    const mid = (low + high) / 2;
    const res = evalMinArrVinf(mid, srcBody, tgtBody, mainBody, depDates, minDur, maxDur);
    const isValid = res.minArrVinfMs <= vInfMax + 1.0;

    if (isValid) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Computes link end date ranges filtered by Tisserand v_inf ranges with 0.01 day dichotomic search (asynchronously with progress callbacks and UI yielding).
 */
const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

export async function computeLinkEndDateRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<Record<string, LinkEndDateRanges>> {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const result: Record<string, LinkEndDateRanges> = {};
  const totalLinks = links.length;

  for (let lIdx = 0; lIdx < totalLinks; lIdx++) {
    const link = links[lIdx];
    const srcInst = instMap.get(link.sourceInstanceId);
    const tgtInst = instMap.get(link.targetInstanceId);
    if (!srcInst || !tgtInst) continue;

    const srcBody = bodyMap.get(srcInst.bodyName) || mainBody;
    const tgtBody = bodyMap.get(tgtInst.bodyName) || mainBody;

    const srcEnv = envs[srcInst.id] || { minMs: 0, maxMs: 1e6 };
    const tgtEnv = envs[tgtInst.id] || { minMs: 0, maxMs: 1e6 };

    const minDur = link.minFlightDuration ?? 0;
    const maxDur = link.maxFlightDuration ?? 1e10;

    let depDates: number[] = [];
    let arrDates: number[] = [];

    const { srcDates, tgtDates } = countPossibleTransfers(link, srcInst, tgtInst);
    if (srcDates.length >= 2 && tgtDates.length >= 2) {
      depDates = srcDates;
      arrDates = tgtDates;
    } else {
      const minDep = srcInst.computedMinDate ?? 0;
      const maxDep = srcInst.computedMaxDate ?? (minDep + 86400 * 365 * 3);
      const minArr = tgtInst.computedMinDate ?? (minDep + minDur);
      const maxArr = tgtInst.computedMaxDate ?? (maxDep + (maxDur < 1e9 ? maxDur : 86400 * 365 * 3));

      const N = 32;
      const stepDep = Math.max(1, (maxDep - minDep) / (N - 1));
      const stepArr = Math.max(1, (maxArr - minArr) / (N - 1));

      for (let i = 0; i < N; i++) depDates.push(minDep + i * stepDep);
      for (let j = 0; j < N; j++) arrDates.push(minArr + j * stepArr);
    }

    const baseProgress = (lIdx / totalLinks) * 100;
    const linkWeight = 100 / totalLinks;
    onProgress?.(
      Math.round(baseProgress),
      `Evaluating link date ranges: ${srcInst.bodyName} ➔ ${tgtInst.bodyName}...`
    );
    await yieldUI();

    // --- 1. Departure End Date Range ---
    const depValidIndices: number[] = [];
    const depVinfAchieved: number[] = [];

    for (let i = 0; i < depDates.length; i++) {
      if (i % 6 === 0) {
        onProgress?.(
          Math.min(99, Math.round(baseProgress + (i / depDates.length) * (linkWeight * 0.5))),
          `Evaluating departure date bounds: ${srcInst.bodyName} ➔ ${tgtInst.bodyName} (${i + 1}/${depDates.length})...`
        );
        await yieldUI();
      }
      const tDep = depDates[i];
      const evalRes = evalMinDepVinf(tDep, srcBody, tgtBody, mainBody, arrDates, minDur, maxDur);
      if (evalRes.minDepVinfMs < Infinity) {
        if (evalRes.minDepVinfMs >= srcEnv.minMs - 1.0 && evalRes.minDepVinfMs <= srcEnv.maxMs + 10.0) {
          depValidIndices.push(i);
          depVinfAchieved.push(evalRes.minDepVinfMs);
        }
      }
    }

    let depDateMin = depDates[0];
    let depDateMax = depDates[depDates.length - 1];
    let depVinfMin = depVinfAchieved.length > 0 ? Math.min(...depVinfAchieved) : 0;
    let depVinfMax = depVinfAchieved.length > 0 ? Math.max(...depVinfAchieved) : 0;
    const hasValidDepRange = depValidIndices.length > 0;

    if (hasValidDepRange) {
      const firstIdx = depValidIndices[0];
      const lastIdx = depValidIndices[depValidIndices.length - 1];

      depDateMin = depDates[firstIdx];
      depDateMax = depDates[lastIdx];

      if (firstIdx > 0) {
        depDateMin = bisectDepBoundary(
          depDates[firstIdx],
          depDates[firstIdx - 1],
          srcBody,
          tgtBody,
          mainBody,
          arrDates,
          srcEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }

      if (lastIdx < depDates.length - 1) {
        depDateMax = bisectDepBoundary(
          depDates[lastIdx],
          depDates[lastIdx + 1],
          srcBody,
          tgtBody,
          mainBody,
          arrDates,
          srcEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }
    }

    // --- 2. Arrival End Date Range ---
    const arrValidIndices: number[] = [];
    const arrVinfAchieved: number[] = [];

    for (let j = 0; j < arrDates.length; j++) {
      if (j % 6 === 0) {
        onProgress?.(
          Math.min(99, Math.round(baseProgress + (linkWeight * 0.5) + (j / arrDates.length) * (linkWeight * 0.5))),
          `Evaluating arrival date bounds: ${srcInst.bodyName} ➔ ${tgtInst.bodyName} (${j + 1}/${arrDates.length})...`
        );
        await yieldUI();
      }
      const tArr = arrDates[j];
      const evalRes = evalMinArrVinf(tArr, srcBody, tgtBody, mainBody, depDates, minDur, maxDur);
      if (evalRes.minArrVinfMs < Infinity) {
        if (evalRes.minArrVinfMs >= tgtEnv.minMs - 1.0 && evalRes.minArrVinfMs <= tgtEnv.maxMs + 10.0) {
          arrValidIndices.push(j);
          arrVinfAchieved.push(evalRes.minArrVinfMs);
        }
      }
    }

    let arrDateMin = arrDates[0];
    let arrDateMax = arrDates[arrDates.length - 1];
    let arrVinfMin = arrVinfAchieved.length > 0 ? Math.min(...arrVinfAchieved) : 0;
    let arrVinfMax = arrVinfAchieved.length > 0 ? Math.max(...arrVinfAchieved) : 0;
    const hasValidArrRange = arrValidIndices.length > 0;

    if (hasValidArrRange) {
      const firstIdx = arrValidIndices[0];
      const lastIdx = arrValidIndices[arrValidIndices.length - 1];

      arrDateMin = arrDates[firstIdx];
      arrDateMax = arrDates[lastIdx];

      if (firstIdx > 0) {
        arrDateMin = bisectArrBoundary(
          arrDates[firstIdx],
          arrDates[firstIdx - 1],
          srcBody,
          tgtBody,
          mainBody,
          depDates,
          tgtEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }

      if (lastIdx < arrDates.length - 1) {
        arrDateMax = bisectArrBoundary(
          arrDates[lastIdx],
          arrDates[lastIdx + 1],
          srcBody,
          tgtBody,
          mainBody,
          depDates,
          tgtEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }
    }

    result[link.id] = {
      linkId: link.id,
      sourceInstanceId: link.sourceInstanceId,
      targetInstanceId: link.targetInstanceId,
      sourceBodyName: srcInst.bodyName,
      targetBodyName: tgtInst.bodyName,
      depDateMin,
      depDateMax,
      depVinfMin,
      depVinfMax,
      depTargetVinfRange: srcEnv,
      hasValidDepRange,
      arrDateMin,
      arrDateMax,
      arrVinfMin,
      arrVinfMax,
      arrTargetVinfRange: tgtEnv,
      hasValidArrRange
    };
  }

  onProgress?.(100, 'Finished computing Tisserand date ranges');
  return result;
}

export async function compute3BodyConsolidatedRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<{
  linkEndRangesMap: Record<string, LinkEndDateRanges>;
  sequence3BodyRangesList: Sequence3BodyConsolidatedRange[];
}> {
  const linkEndRangesMap = await computeLinkEndDateRangesAsync(
    instances,
    links,
    bodies,
    mainBody,
    timeFormatMode,
    onProgress
  );

  const subPaths = findAllSubPathsInGraph(links, instances);
  const sub3Paths = subPaths.filter(sp => sp.pathInsts.length === 3);

  const consolidatedList: Sequence3BodyConsolidatedRange[] = [];

  for (const sp of sub3Paths) {
    const pInsts = sp.pathInsts;
    if (pInsts.length < 3) continue;

    const sourceInstance = pInsts[0];
    const flybyInstance = pInsts[1];
    const targetInstance = pInsts[2];

    const link1 = links.find(l => l.sourceInstanceId === sourceInstance.id && l.targetInstanceId === flybyInstance.id);
    const link2 = links.find(l => l.sourceInstanceId === flybyInstance.id && l.targetInstanceId === targetInstance.id);

    if (!link1 || !link2) continue;

    const range1 = linkEndRangesMap[link1.id];
    const range2 = linkEndRangesMap[link2.id];

    if (!range1 || !range2) continue;

    const link1ArrMin = range1.arrDateMin;
    const link1ArrMax = range1.arrDateMax;

    const link2DepMin = range2.depDateMin;
    const link2DepMax = range2.depDateMax;

    const consolidatedFlybyMin = Math.max(link1ArrMin, link2DepMin);
    const consolidatedFlybyMax = Math.min(link1ArrMax, link2DepMax);

    const hasFlybyOverlap = consolidatedFlybyMin <= consolidatedFlybyMax;
    const overlapDurationSec = hasFlybyOverlap
      ? (consolidatedFlybyMax - consolidatedFlybyMin)
      : (consolidatedFlybyMin - consolidatedFlybyMax);

    const minDur1 = link1.minFlightDuration ?? 0;
    const maxDur1 = link1.maxFlightDuration ?? 1e10;

    let consolidatedDepMin = range1.depDateMin;
    let consolidatedDepMax = range1.depDateMax;

    if (hasFlybyOverlap) {
      consolidatedDepMin = Math.max(range1.depDateMin, consolidatedFlybyMin - (maxDur1 < 1e9 ? maxDur1 : 86400 * 365 * 5));
      consolidatedDepMax = Math.min(range1.depDateMax, consolidatedFlybyMax - minDur1);
      if (consolidatedDepMin > consolidatedDepMax) {
        consolidatedDepMin = range1.depDateMin;
        consolidatedDepMax = range1.depDateMax;
      }
    }

    const minDur2 = link2.minFlightDuration ?? 0;
    const maxDur2 = link2.maxFlightDuration ?? 1e10;

    let consolidatedArrMin = range2.arrDateMin;
    let consolidatedArrMax = range2.arrDateMax;

    if (hasFlybyOverlap) {
      consolidatedArrMin = Math.max(range2.arrDateMin, consolidatedFlybyMin + minDur2);
      consolidatedArrMax = Math.min(range2.arrDateMax, consolidatedFlybyMax + (maxDur2 < 1e9 ? maxDur2 : 86400 * 365 * 5));
      if (consolidatedArrMin > consolidatedArrMax) {
        consolidatedArrMin = range2.arrDateMin;
        consolidatedArrMax = range2.arrDateMax;
      }
    }

    consolidatedList.push({
      sequenceId: sp.id,
      sequenceLabel: sp.sequenceLabel,
      pathInsts: pInsts,
      sourceInstance,
      flybyInstance,
      targetInstance,
      link1,
      link2,
      link1ArrMin,
      link1ArrMax,
      link2DepMin,
      link2DepMax,
      consolidatedFlybyMin,
      consolidatedFlybyMax,
      hasFlybyOverlap,
      overlapDurationSec,
      consolidatedDepMin,
      consolidatedDepMax,
      consolidatedArrMin,
      consolidatedArrMax
    });
  }

  return { linkEndRangesMap, sequence3BodyRangesList: consolidatedList };
}

/**
 * Computes link end date ranges filtered by Tisserand v_inf ranges with 0.01 day dichotomic search.
 */
export function computeLinkEndDateRanges(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp'
): Record<string, LinkEndDateRanges> {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const result: Record<string, LinkEndDateRanges> = {};

  for (const link of links) {
    const srcInst = instMap.get(link.sourceInstanceId);
    const tgtInst = instMap.get(link.targetInstanceId);
    if (!srcInst || !tgtInst) continue;

    const srcBody = bodyMap.get(srcInst.bodyName) || mainBody;
    const tgtBody = bodyMap.get(tgtInst.bodyName) || mainBody;

    const srcEnv = envs[srcInst.id] || { minMs: 0, maxMs: 1e6 };
    const tgtEnv = envs[tgtInst.id] || { minMs: 0, maxMs: 1e6 };

    const minDur = link.minFlightDuration ?? 0;
    const maxDur = link.maxFlightDuration ?? 1e10;

    let depDates: number[] = [];
    let arrDates: number[] = [];

    const { srcDates, tgtDates } = countPossibleTransfers(link, srcInst, tgtInst);
    if (srcDates.length >= 2 && tgtDates.length >= 2) {
      depDates = srcDates;
      arrDates = tgtDates;
    } else {
      const minDep = srcInst.computedMinDate ?? 0;
      const maxDep = srcInst.computedMaxDate ?? (minDep + 86400 * 365 * 3);
      const minArr = tgtInst.computedMinDate ?? (minDep + minDur);
      const maxArr = tgtInst.computedMaxDate ?? (maxDep + (maxDur < 1e9 ? maxDur : 86400 * 365 * 3));

      const N = 48;
      const stepDep = Math.max(1, (maxDep - minDep) / (N - 1));
      const stepArr = Math.max(1, (maxArr - minArr) / (N - 1));

      for (let i = 0; i < N; i++) depDates.push(minDep + i * stepDep);
      for (let j = 0; j < N; j++) arrDates.push(minArr + j * stepArr);
    }

    // --- 1. Departure End Date Range ---
    const depValidIndices: number[] = [];
    const depVinfAchieved: number[] = [];

    for (let i = 0; i < depDates.length; i++) {
      const tDep = depDates[i];
      const evalRes = evalMinDepVinf(tDep, srcBody, tgtBody, mainBody, arrDates, minDur, maxDur);
      if (evalRes.minDepVinfMs < Infinity) {
        if (evalRes.minDepVinfMs >= srcEnv.minMs - 1.0 && evalRes.minDepVinfMs <= srcEnv.maxMs + 10.0) {
          depValidIndices.push(i);
          depVinfAchieved.push(evalRes.minDepVinfMs);
        }
      }
    }

    let depDateMin = depDates[0];
    let depDateMax = depDates[depDates.length - 1];
    let depVinfMin = depVinfAchieved.length > 0 ? Math.min(...depVinfAchieved) : 0;
    let depVinfMax = depVinfAchieved.length > 0 ? Math.max(...depVinfAchieved) : 0;
    const hasValidDepRange = depValidIndices.length > 0;

    if (hasValidDepRange) {
      const firstIdx = depValidIndices[0];
      const lastIdx = depValidIndices[depValidIndices.length - 1];

      depDateMin = depDates[firstIdx];
      depDateMax = depDates[lastIdx];

      // Dichotomic refinement for start boundary
      if (firstIdx > 0) {
        depDateMin = bisectDepBoundary(
          depDates[firstIdx],
          depDates[firstIdx - 1],
          srcBody,
          tgtBody,
          mainBody,
          arrDates,
          srcEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }

      // Dichotomic refinement for end boundary
      if (lastIdx < depDates.length - 1) {
        depDateMax = bisectDepBoundary(
          depDates[lastIdx],
          depDates[lastIdx + 1],
          srcBody,
          tgtBody,
          mainBody,
          arrDates,
          srcEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }
    }

    // --- 2. Arrival End Date Range ---
    const arrValidIndices: number[] = [];
    const arrVinfAchieved: number[] = [];

    for (let j = 0; j < arrDates.length; j++) {
      const tArr = arrDates[j];
      const evalRes = evalMinArrVinf(tArr, srcBody, tgtBody, mainBody, depDates, minDur, maxDur);
      if (evalRes.minArrVinfMs < Infinity) {
        if (evalRes.minArrVinfMs >= tgtEnv.minMs - 1.0 && evalRes.minArrVinfMs <= tgtEnv.maxMs + 10.0) {
          arrValidIndices.push(j);
          arrVinfAchieved.push(evalRes.minArrVinfMs);
        }
      }
    }

    let arrDateMin = arrDates[0];
    let arrDateMax = arrDates[arrDates.length - 1];
    let arrVinfMin = arrVinfAchieved.length > 0 ? Math.min(...arrVinfAchieved) : 0;
    let arrVinfMax = arrVinfAchieved.length > 0 ? Math.max(...arrVinfAchieved) : 0;
    const hasValidArrRange = arrValidIndices.length > 0;

    if (hasValidArrRange) {
      const firstIdx = arrValidIndices[0];
      const lastIdx = arrValidIndices[arrValidIndices.length - 1];

      arrDateMin = arrDates[firstIdx];
      arrDateMax = arrDates[lastIdx];

      // Dichotomic refinement for start boundary
      if (firstIdx > 0) {
        arrDateMin = bisectArrBoundary(
          arrDates[firstIdx],
          arrDates[firstIdx - 1],
          srcBody,
          tgtBody,
          mainBody,
          depDates,
          tgtEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }

      // Dichotomic refinement for end boundary
      if (lastIdx < arrDates.length - 1) {
        arrDateMax = bisectArrBoundary(
          arrDates[lastIdx],
          arrDates[lastIdx + 1],
          srcBody,
          tgtBody,
          mainBody,
          depDates,
          tgtEnv.maxMs,
          minDur,
          maxDur,
          timeFormatMode
        );
      }
    }

    result[link.id] = {
      linkId: link.id,
      sourceInstanceId: link.sourceInstanceId,
      targetInstanceId: link.targetInstanceId,
      sourceBodyName: srcInst.bodyName,
      targetBodyName: tgtInst.bodyName,
      depDateMin,
      depDateMax,
      depVinfMin,
      depVinfMax,
      depTargetVinfRange: srcEnv,
      hasValidDepRange,
      arrDateMin,
      arrDateMax,
      arrVinfMin,
      arrVinfMax,
      arrTargetVinfRange: tgtEnv,
      hasValidArrRange
    };
  }

  return result;
}

/**
 * Computes consolidated intersection date ranges for all 3-body sub-paths (Inst1 ➔ Inst2 ➔ Inst3).
 */
export function compute3BodyConsolidatedRanges(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp'
): Sequence3BodyConsolidatedRange[] {
  const linkEndRanges = computeLinkEndDateRanges(instances, links, bodies, mainBody, timeFormatMode);
  const subPaths = findAllSubPathsInGraph(links, instances);
  const sub3Paths = subPaths.filter(sp => sp.pathInsts.length === 3);

  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const linkMap = new Map<string, DirectionalLink>();
  links.forEach(l => linkMap.set(l.id, l));

  const consolidatedList: Sequence3BodyConsolidatedRange[] = [];

  for (const sp of sub3Paths) {
    const pInsts = sp.pathInsts;
    if (pInsts.length < 3) continue;

    const sourceInstance = pInsts[0];
    const flybyInstance = pInsts[1];
    const targetInstance = pInsts[2];

    const link1 = links.find(l => l.sourceInstanceId === sourceInstance.id && l.targetInstanceId === flybyInstance.id);
    const link2 = links.find(l => l.sourceInstanceId === flybyInstance.id && l.targetInstanceId === targetInstance.id);

    if (!link1 || !link2) continue;

    const range1 = linkEndRanges[link1.id];
    const range2 = linkEndRanges[link2.id];

    if (!range1 || !range2) continue;

    const link1ArrMin = range1.arrDateMin;
    const link1ArrMax = range1.arrDateMax;

    const link2DepMin = range2.depDateMin;
    const link2DepMax = range2.depDateMax;

    // Intersection at Flyby Instance
    const consolidatedFlybyMin = Math.max(link1ArrMin, link2DepMin);
    const consolidatedFlybyMax = Math.min(link1ArrMax, link2DepMax);

    const hasFlybyOverlap = consolidatedFlybyMin <= consolidatedFlybyMax;
    const overlapDurationSec = hasFlybyOverlap
      ? (consolidatedFlybyMax - consolidatedFlybyMin)
      : (consolidatedFlybyMin - consolidatedFlybyMax);

    // Consolidated departure window at Source Instance
    const minDur1 = link1.minFlightDuration ?? 0;
    const maxDur1 = link1.maxFlightDuration ?? 1e10;

    let consolidatedDepMin = range1.depDateMin;
    let consolidatedDepMax = range1.depDateMax;

    if (hasFlybyOverlap) {
      consolidatedDepMin = Math.max(range1.depDateMin, consolidatedFlybyMin - (maxDur1 < 1e9 ? maxDur1 : 86400 * 365 * 5));
      consolidatedDepMax = Math.min(range1.depDateMax, consolidatedFlybyMax - minDur1);
      if (consolidatedDepMin > consolidatedDepMax) {
        consolidatedDepMin = range1.depDateMin;
        consolidatedDepMax = range1.depDateMax;
      }
    }

    // Consolidated arrival window at Target Instance
    const minDur2 = link2.minFlightDuration ?? 0;
    const maxDur2 = link2.maxFlightDuration ?? 1e10;

    let consolidatedArrMin = range2.arrDateMin;
    let consolidatedArrMax = range2.arrDateMax;

    if (hasFlybyOverlap) {
      consolidatedArrMin = Math.max(range2.arrDateMin, consolidatedFlybyMin + minDur2);
      consolidatedArrMax = Math.min(range2.arrDateMax, consolidatedFlybyMax + (maxDur2 < 1e9 ? maxDur2 : 86400 * 365 * 5));
      if (consolidatedArrMin > consolidatedArrMax) {
        consolidatedArrMin = range2.arrDateMin;
        consolidatedArrMax = range2.arrDateMax;
      }
    }

    consolidatedList.push({
      sequenceId: sp.id,
      sequenceLabel: sp.sequenceLabel,
      pathInsts: pInsts,
      sourceInstance,
      flybyInstance,
      targetInstance,
      link1,
      link2,
      link1ArrMin,
      link1ArrMax,
      link2DepMin,
      link2DepMax,
      consolidatedFlybyMin,
      consolidatedFlybyMax,
      hasFlybyOverlap,
      overlapDurationSec,
      consolidatedDepMin,
      consolidatedDepMax,
      consolidatedArrMin,
      consolidatedArrMax
    });
  }

  return consolidatedList;
}
