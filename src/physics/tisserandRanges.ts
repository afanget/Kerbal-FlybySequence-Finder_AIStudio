/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { InstanceNode, DirectionalLink, CelestialBody } from '../types';
import { getBodyStateAtUT, vecMag, vecSub, Vector3D } from './kepler';
import { solveLambertBest } from './lambert';
import { computeTisserandEnvelopes, findAllSubPathsInGraph } from './solver';

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

interface LinkPorkchopGrid {
  linkId: string;
  srcInst: InstanceNode;
  tgtInst: InstanceNode;
  srcBody: CelestialBody;
  tgtBody: CelestialBody;
  srcEnv: { minMs: number; maxMs: number };
  tgtEnv: { minMs: number; maxMs: number };
  minDur: number;
  maxDur: number;
  srcMinDate: number;
  srcMaxDate: number;
  tgtMinDate: number;
  tgtMaxDate: number;
  depDates: number[];
  arrDates: number[];
  depStates: { pos: Vector3D; vel: Vector3D }[];
  tgtStates: { pos: Vector3D; vel: Vector3D }[];
  validMatrix: boolean[][];
}

const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Bisection search to locate departure boundary date to high precision (~10 seconds).
 */
function bisectDepBoundary(
  tValid: number,
  tInvalid: number,
  depStatesSample: { pos: Vector3D; vel: Vector3D }[],
  tgtDates: number[],
  tgtStates: { pos: Vector3D; vel: Vector3D }[],
  srcBody: CelestialBody,
  tgtBody: CelestialBody,
  mainBody: CelestialBody,
  srcInst: InstanceNode,
  tgtInst: InstanceNode,
  srcEnv: { minMs: number; maxMs: number },
  tgtEnv: { minMs: number; maxMs: number },
  minDur: number,
  maxDur: number,
  arrMinLimit: number = -Infinity,
  arrMaxLimit: number = Infinity
): number {
  const muCentral = mainBody.stdGravParam || 1.32712440018e20;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

  let low = tValid;
  let high = tInvalid;

  const testDepValid = (tDep: number): boolean => {
    const srcState = getBodyStateAtUT(srcBody, mainBody, tDep);
    for (let j = 0; j < tgtDates.length; j++) {
      const tArr = tgtDates[j];
      if (tArr < arrMinLimit || tArr > arrMaxLimit) continue;
      const dt = tArr - tDep;
      if (dt < minDur || dt > maxDur) continue;

      const tgtState = tgtStates[j];
      const sol = solveLambertBest(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius, srcState.vel, tgtState.vel);
      if (!sol.isValid) continue;

      const vInfDepMag = vecMag(vecSub(sol.v1, srcState.vel));
      const vInfArrMag = vecMag(vecSub(sol.v2, tgtState.vel));
      const c3Dep = (vInfDepMag * vInfDepMag) / 1e6;
      const c3Arr = (vInfArrMag * vInfArrMag) / 1e6;

      const passSrc = (srcInst.maxC3 === undefined || c3Dep <= srcInst.maxC3) &&
                       (srcInst.computedMinC3 === undefined || c3Dep >= srcInst.computedMinC3 - 0.05) &&
                       (srcInst.computedMaxC3 === undefined || c3Dep <= srcInst.computedMaxC3 + 0.05) &&
                       (vInfDepMag >= srcEnv.minMs - 1.0 && vInfDepMag <= srcEnv.maxMs + 10.0);

      const passTgt = (tgtInst.maxC3 === undefined || c3Arr <= tgtInst.maxC3) &&
                       (tgtInst.computedMinC3 === undefined || c3Arr >= tgtInst.computedMinC3 - 0.05) &&
                       (tgtInst.computedMaxC3 === undefined || c3Arr <= tgtInst.computedMaxC3 + 0.05) &&
                       (vInfArrMag >= tgtEnv.minMs - 1.0 && vInfArrMag <= tgtEnv.maxMs + 10.0);

      if (passSrc && passTgt) return true;
    }
    return false;
  };

  for (let iter = 0; iter < 20; iter++) {
    if (Math.abs(high - low) <= 10) break;
    const mid = (low + high) / 2;
    if (testDepValid(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Bisection search to locate arrival boundary date to high precision (~10 seconds).
 */
function bisectArrBoundary(
  tValid: number,
  tInvalid: number,
  depDates: number[],
  depStates: { pos: Vector3D; vel: Vector3D }[],
  srcBody: CelestialBody,
  tgtBody: CelestialBody,
  mainBody: CelestialBody,
  srcInst: InstanceNode,
  tgtInst: InstanceNode,
  srcEnv: { minMs: number; maxMs: number },
  tgtEnv: { minMs: number; maxMs: number },
  minDur: number,
  maxDur: number,
  depMinLimit: number = -Infinity,
  depMaxLimit: number = Infinity
): number {
  const muCentral = mainBody.stdGravParam || 1.32712440018e20;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

  let low = tValid;
  let high = tInvalid;

  const testArrValid = (tArr: number): boolean => {
    const tgtState = getBodyStateAtUT(tgtBody, mainBody, tArr);
    for (let i = 0; i < depDates.length; i++) {
      const tDep = depDates[i];
      if (tDep < depMinLimit || tDep > depMaxLimit) continue;
      const dt = tArr - tDep;
      if (dt < minDur || dt > maxDur) continue;

      const srcState = depStates[i];
      const sol = solveLambertBest(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius, srcState.vel, tgtState.vel);
      if (!sol.isValid) continue;

      const vInfDepMag = vecMag(vecSub(sol.v1, srcState.vel));
      const vInfArrMag = vecMag(vecSub(sol.v2, tgtState.vel));
      const c3Dep = (vInfDepMag * vInfDepMag) / 1e6;
      const c3Arr = (vInfArrMag * vInfArrMag) / 1e6;

      const passSrc = (srcInst.maxC3 === undefined || c3Dep <= srcInst.maxC3) &&
                       (srcInst.computedMinC3 === undefined || c3Dep >= srcInst.computedMinC3 - 0.05) &&
                       (srcInst.computedMaxC3 === undefined || c3Dep <= srcInst.computedMaxC3 + 0.05) &&
                       (vInfDepMag >= srcEnv.minMs - 1.0 && vInfDepMag <= srcEnv.maxMs + 10.0);

      const passTgt = (tgtInst.maxC3 === undefined || c3Arr <= tgtInst.maxC3) &&
                       (tgtInst.computedMinC3 === undefined || c3Arr >= tgtInst.computedMinC3 - 0.05) &&
                       (tgtInst.computedMaxC3 === undefined || c3Arr <= tgtInst.computedMaxC3 + 0.05) &&
                       (vInfArrMag >= tgtEnv.minMs - 1.0 && vInfArrMag <= tgtEnv.maxMs + 10.0);

      if (passSrc && passTgt) return true;
    }
    return false;
  };

  for (let iter = 0; iter < 20; iter++) {
    if (Math.abs(high - low) <= 10) break;
    const mid = (low + high) / 2;
    if (testArrValid(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

/**
 * Computes link end date ranges by constructing 2D transfer porkchop matrices for each link.
 */
export async function computeLinkEndDateRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<Record<string, LinkEndDateRanges>> {
  const { linkEndRangesMap } = await computeLinkGridsAndRangesAsync(
    instances,
    links,
    bodies,
    mainBody,
    onProgress
  );
  return linkEndRangesMap;
}

/**
 * Internal async solver that calculates porkchop grids and date ranges for all links.
 */
async function computeLinkGridsAndRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<{
  linkEndRangesMap: Record<string, LinkEndDateRanges>;
  porkchopGridsMap: Record<string, LinkPorkchopGrid>;
}> {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const muCentral = mainBody.stdGravParam || 1.32712440018e20;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

  const linkEndRangesMap: Record<string, LinkEndDateRanges> = {};
  const porkchopGridsMap: Record<string, LinkPorkchopGrid> = {};
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

    const srcMinDate = srcInst.minDate ?? srcInst.computedMinDate ?? 0;
    let srcMaxDate = srcInst.maxDate ?? srcInst.computedMaxDate ?? (srcMinDate + 86400 * 365 * 10);
    if (srcMaxDate <= srcMinDate) srcMaxDate = srcMinDate + 86400 * 365 * 10;

    const tgtMinDate = tgtInst.minDate ?? tgtInst.computedMinDate ?? (srcMinDate + minDur);
    let tgtMaxDate = tgtInst.maxDate ?? tgtInst.computedMaxDate ?? (srcMaxDate + (maxDur < 1e9 ? maxDur : 86400 * 365 * 10));
    if (tgtMaxDate <= tgtMinDate) tgtMaxDate = tgtMinDate + 86400 * 365 * 10;

    const N_DEP = Math.max(96, link.departureSampleCount || 10);
    const N_ARR = Math.max(96, link.arrivalSampleCount || 10);

    const stepDep = (srcMaxDate - srcMinDate) / (N_DEP - 1);
    const stepArr = (tgtMaxDate - tgtMinDate) / (N_ARR - 1);

    const depDates: number[] = [];
    const arrDates: number[] = [];

    for (let i = 0; i < N_DEP; i++) depDates.push(srcMinDate + i * stepDep);
    for (let j = 0; j < N_ARR; j++) arrDates.push(tgtMinDate + j * stepArr);

    const depStates = depDates.map(t => getBodyStateAtUT(srcBody, mainBody, t));
    const tgtStates = arrDates.map(t => getBodyStateAtUT(tgtBody, mainBody, t));

    const validMatrix: boolean[][] = Array.from({ length: N_DEP }, () => Array(N_ARR).fill(false));
    const depValidRowSet = new Set<number>();
    const arrValidColSet = new Set<number>();

    const depVinfAchieved: number[] = [];
    const arrVinfAchieved: number[] = [];

    const baseProgress = (lIdx / totalLinks) * 100;
    const linkWeight = 100 / totalLinks;

    for (let i = 0; i < N_DEP; i++) {
      if (i % 12 === 0) {
        onProgress?.(
          Math.min(99, Math.round(baseProgress + (i / N_DEP) * linkWeight)),
          `Computing Porkchop Grid for ${srcInst.bodyName} ➔ ${tgtInst.bodyName} (${i + 1}/${N_DEP})...`
        );
        await yieldUI();
      }

      const tDep = depDates[i];
      const srcState = depStates[i];

      for (let j = 0; j < N_ARR; j++) {
        const tArr = arrDates[j];
        const dt = tArr - tDep;
        if (dt < minDur || dt > maxDur) continue;

        const tgtState = tgtStates[j];
        const sol = solveLambertBest(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius, srcState.vel, tgtState.vel);
        if (!sol.isValid) continue;

        const vInfDepMag = vecMag(vecSub(sol.v1, srcState.vel));
        const vInfArrMag = vecMag(vecSub(sol.v2, tgtState.vel));
        const c3Dep = (vInfDepMag * vInfDepMag) / 1e6;
        const c3Arr = (vInfArrMag * vInfArrMag) / 1e6;

        const passSrc = (srcInst.maxC3 === undefined || c3Dep <= srcInst.maxC3) &&
                         (srcInst.computedMinC3 === undefined || c3Dep >= srcInst.computedMinC3 - 0.05) &&
                         (srcInst.computedMaxC3 === undefined || c3Dep <= srcInst.computedMaxC3 + 0.05) &&
                         (vInfDepMag >= srcEnv.minMs - 1.0 && vInfDepMag <= srcEnv.maxMs + 10.0);

        const passTgt = (tgtInst.maxC3 === undefined || c3Arr <= tgtInst.maxC3) &&
                         (tgtInst.computedMinC3 === undefined || c3Arr >= tgtInst.computedMinC3 - 0.05) &&
                         (tgtInst.computedMaxC3 === undefined || c3Arr <= tgtInst.computedMaxC3 + 0.05) &&
                         (vInfArrMag >= tgtEnv.minMs - 1.0 && vInfArrMag <= tgtEnv.maxMs + 10.0);

        if (passSrc && passTgt) {
          validMatrix[i][j] = true;
          depValidRowSet.add(i);
          arrValidColSet.add(j);
          depVinfAchieved.push(vInfDepMag);
          arrVinfAchieved.push(vInfArrMag);
        }
      }
    }

    // Departure Window Projection & Bisection
    const validDepIndices = Array.from(depValidRowSet).sort((a, b) => a - b);
    const hasValidDepRange = validDepIndices.length > 0;
    let depDateMin = NaN;
    let depDateMax = NaN;

    if (hasValidDepRange) {
      const firstI = validDepIndices[0];
      const lastI = validDepIndices[validDepIndices.length - 1];

      depDateMin = firstI === 0 ? depDates[0] : bisectDepBoundary(
        depDates[firstI],
        depDates[firstI - 1],
        depStates,
        arrDates,
        tgtStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );

      depDateMax = lastI === N_DEP - 1 ? depDates[N_DEP - 1] : bisectDepBoundary(
        depDates[lastI],
        depDates[lastI + 1],
        depStates,
        arrDates,
        tgtStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );
    }

    // Arrival Window Projection & Bisection
    const validArrIndices = Array.from(arrValidColSet).sort((a, b) => a - b);
    const hasValidArrRange = validArrIndices.length > 0;
    let arrDateMin = NaN;
    let arrDateMax = NaN;

    if (hasValidArrRange) {
      const firstJ = validArrIndices[0];
      const lastJ = validArrIndices[validArrIndices.length - 1];

      arrDateMin = firstJ === 0 ? arrDates[0] : bisectArrBoundary(
        arrDates[firstJ],
        arrDates[firstJ - 1],
        depDates,
        depStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );

      arrDateMax = lastJ === N_ARR - 1 ? arrDates[N_ARR - 1] : bisectArrBoundary(
        arrDates[lastJ],
        arrDates[lastJ + 1],
        depDates,
        depStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );
    }

    linkEndRangesMap[link.id] = {
      linkId: link.id,
      sourceInstanceId: link.sourceInstanceId,
      targetInstanceId: link.targetInstanceId,
      sourceBodyName: srcInst.bodyName,
      targetBodyName: tgtInst.bodyName,
      depDateMin,
      depDateMax,
      depVinfMin: depVinfAchieved.length > 0 ? Math.min(...depVinfAchieved) : 0,
      depVinfMax: depVinfAchieved.length > 0 ? Math.max(...depVinfAchieved) : 0,
      depTargetVinfRange: srcEnv,
      hasValidDepRange,
      arrDateMin,
      arrDateMax,
      arrVinfMin: arrVinfAchieved.length > 0 ? Math.min(...arrVinfAchieved) : 0,
      arrVinfMax: arrVinfAchieved.length > 0 ? Math.max(...arrVinfAchieved) : 0,
      arrTargetVinfRange: tgtEnv,
      hasValidArrRange
    };

    porkchopGridsMap[link.id] = {
      linkId: link.id,
      srcInst,
      tgtInst,
      srcBody,
      tgtBody,
      srcEnv,
      tgtEnv,
      minDur,
      maxDur,
      srcMinDate,
      srcMaxDate,
      tgtMinDate,
      tgtMaxDate,
      depDates,
      arrDates,
      depStates,
      tgtStates,
      validMatrix
    };
  }

  return { linkEndRangesMap, porkchopGridsMap };
}

/**
 * Computes consolidated 3-body sequence ranges using transfer porkchop matrix projections.
 */
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
  const { linkEndRangesMap, porkchopGridsMap } = await computeLinkGridsAndRangesAsync(
    instances,
    links,
    bodies,
    mainBody,
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

    const grid1 = porkchopGridsMap[link1.id];
    const grid2 = porkchopGridsMap[link2.id];

    const link1ArrMin = range1.arrDateMin;
    const link1ArrMax = range1.arrDateMax;

    const link2DepMin = range2.depDateMin;
    const link2DepMax = range2.depDateMax;

    const isLink1Valid = range1.hasValidArrRange && !isNaN(link1ArrMin) && !isNaN(link1ArrMax);
    const isLink2Valid = range2.hasValidDepRange && !isNaN(link2DepMin) && !isNaN(link2DepMax);

    let consolidatedFlybyMin = NaN;
    let consolidatedFlybyMax = NaN;
    let hasFlybyOverlap = false;

    if (isLink1Valid && isLink2Valid) {
      consolidatedFlybyMin = Math.max(link1ArrMin, link2DepMin);
      consolidatedFlybyMax = Math.min(link1ArrMax, link2DepMax);
      hasFlybyOverlap = consolidatedFlybyMin <= consolidatedFlybyMax;
    }

    const overlapDurationSec = hasFlybyOverlap
      ? (consolidatedFlybyMax - consolidatedFlybyMin)
      : (isLink1Valid && isLink2Valid ? Math.abs(link2DepMin - link1ArrMax) : 0);

    let consolidatedDepMin = NaN;
    let consolidatedDepMax = NaN;
    let consolidatedArrMin = NaN;
    let consolidatedArrMax = NaN;

    if (hasFlybyOverlap && grid1 && grid2) {
      // 1. Consolidated Departure Window at Source Instance (filtering Link 1 porkchop grid)
      const validDepRows: number[] = [];
      for (let i = 0; i < grid1.depDates.length; i++) {
        let rowHasOverlapCell = false;
        for (let j = 0; j < grid1.arrDates.length; j++) {
          if (grid1.validMatrix[i][j]) {
            const arrT = grid1.arrDates[j];
            if (arrT >= consolidatedFlybyMin - 1.0 && arrT <= consolidatedFlybyMax + 1.0) {
              rowHasOverlapCell = true;
              break;
            }
          }
        }
        if (rowHasOverlapCell) validDepRows.push(i);
      }

      if (validDepRows.length > 0) {
        const minI = validDepRows[0];
        const maxI = validDepRows[validDepRows.length - 1];

        consolidatedDepMin = minI === 0 ? grid1.depDates[0] : bisectDepBoundary(
          grid1.depDates[minI],
          grid1.depDates[minI - 1],
          grid1.depStates,
          grid1.arrDates,
          grid1.tgtStates,
          grid1.srcBody,
          grid1.tgtBody,
          mainBody,
          grid1.srcInst,
          grid1.tgtInst,
          grid1.srcEnv,
          grid1.tgtEnv,
          grid1.minDur,
          grid1.maxDur,
          consolidatedFlybyMin,
          consolidatedFlybyMax
        );

        consolidatedDepMax = maxI === grid1.depDates.length - 1 ? grid1.depDates[grid1.depDates.length - 1] : bisectDepBoundary(
          grid1.depDates[maxI],
          grid1.depDates[maxI + 1],
          grid1.depStates,
          grid1.arrDates,
          grid1.tgtStates,
          grid1.srcBody,
          grid1.tgtBody,
          mainBody,
          grid1.srcInst,
          grid1.tgtInst,
          grid1.srcEnv,
          grid1.tgtEnv,
          grid1.minDur,
          grid1.maxDur,
          consolidatedFlybyMin,
          consolidatedFlybyMax
        );
      } else {
        consolidatedDepMin = range1.depDateMin;
        consolidatedDepMax = range1.depDateMax;
      }

      // 2. Consolidated Arrival Window at Target Instance (filtering Link 2 porkchop grid)
      const validArrCols: number[] = [];
      for (let j = 0; j < grid2.arrDates.length; j++) {
        let colHasOverlapCell = false;
        for (let i = 0; i < grid2.depDates.length; i++) {
          if (grid2.validMatrix[i][j]) {
            const depT = grid2.depDates[i];
            if (depT >= consolidatedFlybyMin - 1.0 && depT <= consolidatedFlybyMax + 1.0) {
              colHasOverlapCell = true;
              break;
            }
          }
        }
        if (colHasOverlapCell) validArrCols.push(j);
      }

      if (validArrCols.length > 0) {
        const minJ = validArrCols[0];
        const maxJ = validArrCols[validArrCols.length - 1];

        consolidatedArrMin = minJ === 0 ? grid2.arrDates[0] : bisectArrBoundary(
          grid2.arrDates[minJ],
          grid2.arrDates[minJ - 1],
          grid2.depDates,
          grid2.depStates,
          grid2.srcBody,
          grid2.tgtBody,
          mainBody,
          grid2.srcInst,
          grid2.tgtInst,
          grid2.srcEnv,
          grid2.tgtEnv,
          grid2.minDur,
          grid2.maxDur,
          consolidatedFlybyMin,
          consolidatedFlybyMax
        );

        consolidatedArrMax = maxJ === grid2.arrDates.length - 1 ? grid2.arrDates[grid2.arrDates.length - 1] : bisectArrBoundary(
          grid2.arrDates[maxJ],
          grid2.arrDates[maxJ + 1],
          grid2.depDates,
          grid2.depStates,
          grid2.srcBody,
          grid2.tgtBody,
          mainBody,
          grid2.srcInst,
          grid2.tgtInst,
          grid2.srcEnv,
          grid2.tgtEnv,
          grid2.minDur,
          grid2.maxDur,
          consolidatedFlybyMin,
          consolidatedFlybyMax
        );
      } else {
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

  onProgress?.(100, 'Finished computing Tisserand date ranges');
  return { linkEndRangesMap, sequence3BodyRangesList: consolidatedList };
}

/**
 * Synchronous version for legacy compatibility.
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

  const muCentral = mainBody.stdGravParam || 1.32712440018e20;
  const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));

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

    const srcMinDate = srcInst.minDate ?? srcInst.computedMinDate ?? 0;
    let srcMaxDate = srcInst.maxDate ?? srcInst.computedMaxDate ?? (srcMinDate + 86400 * 365 * 10);
    if (srcMaxDate <= srcMinDate) srcMaxDate = srcMinDate + 86400 * 365 * 10;

    const tgtMinDate = tgtInst.minDate ?? tgtInst.computedMinDate ?? (srcMinDate + minDur);
    let tgtMaxDate = tgtInst.maxDate ?? tgtInst.computedMaxDate ?? (srcMaxDate + (maxDur < 1e9 ? maxDur : 86400 * 365 * 10));
    if (tgtMaxDate <= tgtMinDate) tgtMaxDate = tgtMinDate + 86400 * 365 * 10;

    const N_DEP = Math.max(96, link.departureSampleCount || 10);
    const N_ARR = Math.max(96, link.arrivalSampleCount || 10);

    const stepDep = (srcMaxDate - srcMinDate) / (N_DEP - 1);
    const stepArr = (tgtMaxDate - tgtMinDate) / (N_ARR - 1);

    const depDates: number[] = [];
    const arrDates: number[] = [];

    for (let i = 0; i < N_DEP; i++) depDates.push(srcMinDate + i * stepDep);
    for (let j = 0; j < N_ARR; j++) arrDates.push(tgtMinDate + j * stepArr);

    const depStates = depDates.map(t => getBodyStateAtUT(srcBody, mainBody, t));
    const tgtStates = arrDates.map(t => getBodyStateAtUT(tgtBody, mainBody, t));

    const depValidRowSet = new Set<number>();
    const arrValidColSet = new Set<number>();

    const depVinfAchieved: number[] = [];
    const arrVinfAchieved: number[] = [];

    for (let i = 0; i < N_DEP; i++) {
      const tDep = depDates[i];
      const srcState = depStates[i];

      for (let j = 0; j < N_ARR; j++) {
        const tArr = arrDates[j];
        const dt = tArr - tDep;
        if (dt < minDur || dt > maxDur) continue;

        const tgtState = tgtStates[j];
        const sol = solveLambertBest(srcState.pos, tgtState.pos, dt, muCentral, true, minAllowedRadius, srcState.vel, tgtState.vel);
        if (!sol.isValid) continue;

        const vInfDepMag = vecMag(vecSub(sol.v1, srcState.vel));
        const vInfArrMag = vecMag(vecSub(sol.v2, tgtState.vel));
        const c3Dep = (vInfDepMag * vInfDepMag) / 1e6;
        const c3Arr = (vInfArrMag * vInfArrMag) / 1e6;

        const passSrc = (srcInst.maxC3 === undefined || c3Dep <= srcInst.maxC3) &&
                         (srcInst.computedMinC3 === undefined || c3Dep >= srcInst.computedMinC3 - 0.05) &&
                         (srcInst.computedMaxC3 === undefined || c3Dep <= srcInst.computedMaxC3 + 0.05) &&
                         (vInfDepMag >= srcEnv.minMs - 1.0 && vInfDepMag <= srcEnv.maxMs + 10.0);

        const passTgt = (tgtInst.maxC3 === undefined || c3Arr <= tgtInst.maxC3) &&
                         (tgtInst.computedMinC3 === undefined || c3Arr >= tgtInst.computedMinC3 - 0.05) &&
                         (tgtInst.computedMaxC3 === undefined || c3Arr <= tgtInst.computedMaxC3 + 0.05) &&
                         (vInfArrMag >= tgtEnv.minMs - 1.0 && vInfArrMag <= tgtEnv.maxMs + 10.0);

        if (passSrc && passTgt) {
          depValidRowSet.add(i);
          arrValidColSet.add(j);
          depVinfAchieved.push(vInfDepMag);
          arrVinfAchieved.push(vInfArrMag);
        }
      }
    }

    const validDepIndices = Array.from(depValidRowSet).sort((a, b) => a - b);
    const hasValidDepRange = validDepIndices.length > 0;
    let depDateMin = NaN;
    let depDateMax = NaN;

    if (hasValidDepRange) {
      const firstI = validDepIndices[0];
      const lastI = validDepIndices[validDepIndices.length - 1];

      depDateMin = firstI === 0 ? depDates[0] : bisectDepBoundary(
        depDates[firstI],
        depDates[firstI - 1],
        depStates,
        arrDates,
        tgtStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );

      depDateMax = lastI === N_DEP - 1 ? depDates[N_DEP - 1] : bisectDepBoundary(
        depDates[lastI],
        depDates[lastI + 1],
        depStates,
        arrDates,
        tgtStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );
    }

    const validArrIndices = Array.from(arrValidColSet).sort((a, b) => a - b);
    const hasValidArrRange = validArrIndices.length > 0;
    let arrDateMin = NaN;
    let arrDateMax = NaN;

    if (hasValidArrRange) {
      const firstJ = validArrIndices[0];
      const lastJ = validArrIndices[validArrIndices.length - 1];

      arrDateMin = firstJ === 0 ? arrDates[0] : bisectArrBoundary(
        arrDates[firstJ],
        arrDates[firstJ - 1],
        depDates,
        depStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );

      arrDateMax = lastJ === N_ARR - 1 ? arrDates[N_ARR - 1] : bisectArrBoundary(
        arrDates[lastJ],
        arrDates[lastJ + 1],
        depDates,
        depStates,
        srcBody,
        tgtBody,
        mainBody,
        srcInst,
        tgtInst,
        srcEnv,
        tgtEnv,
        minDur,
        maxDur
      );
    }

    result[link.id] = {
      linkId: link.id,
      sourceInstanceId: link.sourceInstanceId,
      targetInstanceId: link.targetInstanceId,
      sourceBodyName: srcInst.bodyName,
      targetBodyName: tgtInst.bodyName,
      depDateMin,
      depDateMax,
      depVinfMin: depVinfAchieved.length > 0 ? Math.min(...depVinfAchieved) : 0,
      depVinfMax: depVinfAchieved.length > 0 ? Math.max(...depVinfAchieved) : 0,
      depTargetVinfRange: srcEnv,
      hasValidDepRange,
      arrDateMin,
      arrDateMax,
      arrVinfMin: arrVinfAchieved.length > 0 ? Math.min(...arrVinfAchieved) : 0,
      arrVinfMax: arrVinfAchieved.length > 0 ? Math.max(...arrVinfAchieved) : 0,
      arrTargetVinfRange: tgtEnv,
      hasValidArrRange
    };
  }

  return result;
}

/**
 * Synchronous version for 3-body sequences.
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

    const isLink1Valid = range1.hasValidArrRange && !isNaN(link1ArrMin) && !isNaN(link1ArrMax);
    const isLink2Valid = range2.hasValidDepRange && !isNaN(link2DepMin) && !isNaN(link2DepMax);

    let consolidatedFlybyMin = NaN;
    let consolidatedFlybyMax = NaN;
    let hasFlybyOverlap = false;

    if (isLink1Valid && isLink2Valid) {
      consolidatedFlybyMin = Math.max(link1ArrMin, link2DepMin);
      consolidatedFlybyMax = Math.min(link1ArrMax, link2DepMax);
      hasFlybyOverlap = consolidatedFlybyMin <= consolidatedFlybyMax;
    }

    const overlapDurationSec = hasFlybyOverlap
      ? (consolidatedFlybyMax - consolidatedFlybyMin)
      : (isLink1Valid && isLink2Valid ? Math.abs(link2DepMin - link1ArrMax) : 0);

    let consolidatedDepMin = NaN;
    let consolidatedDepMax = NaN;
    let consolidatedArrMin = NaN;
    let consolidatedArrMax = NaN;

    if (hasFlybyOverlap) {
      const minDur1 = link1.minFlightDuration ?? 0;
      const maxDur1 = link1.maxFlightDuration ?? 1e10;
      consolidatedDepMin = Math.max(range1.depDateMin, consolidatedFlybyMin - (maxDur1 < 1e9 ? maxDur1 : 86400 * 365 * 5));
      consolidatedDepMax = Math.min(range1.depDateMax, consolidatedFlybyMax - minDur1);

      const minDur2 = link2.minFlightDuration ?? 0;
      const maxDur2 = link2.maxFlightDuration ?? 1e10;
      consolidatedArrMin = Math.max(range2.arrDateMin, consolidatedFlybyMin + minDur2);
      consolidatedArrMax = Math.min(range2.arrDateMax, consolidatedFlybyMax + (maxDur2 < 1e9 ? maxDur2 : 86400 * 365 * 5));
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
