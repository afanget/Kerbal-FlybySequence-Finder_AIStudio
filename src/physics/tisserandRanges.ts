/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { InstanceNode, DirectionalLink, CelestialBody, PorkchopPlotData } from '../types';
import { computeTisserandEnvelopes, findAllSubPathsInGraph, computePorkchopPlot } from './solver';

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

const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Parses direct transfer porkchops to derive Tisserand v_inf filtered date ranges for links.
 * Contains ZERO Lambert calculations and ZERO dichotomial searches.
 */
export async function computeLinkGridsAndRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<{
  linkEndRangesMap: Record<string, LinkEndDateRanges>;
  porkchopsMap: Record<string, PorkchopPlotData>;
}> {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const linkEndRangesMap: Record<string, LinkEndDateRanges> = {};
  const porkchopsMap: Record<string, PorkchopPlotData> = { ...porkchops };
  const totalLinks = links.length;

  for (let lIdx = 0; lIdx < totalLinks; lIdx++) {
    const link = links[lIdx];
    const srcInst = instMap.get(link.sourceInstanceId);
    const tgtInst = instMap.get(link.targetInstanceId);
    if (!srcInst || !tgtInst) continue;

    const srcEnv = envs[srcInst.id] || { minMs: 0, maxMs: 1e6 };
    const tgtEnv = envs[tgtInst.id] || { minMs: 0, maxMs: 1e6 };

    // Ensure direct porkchop exists without recomputing if already present
    let pcData = porkchopsMap[link.id];
    if (!pcData || !pcData.c3DepMatrix || pcData.c3DepMatrix.length === 0) {
      onProgress?.(
        Math.min(99, Math.round((lIdx / totalLinks) * 100)),
        `Computing Direct Transfer Porkchop for ${srcInst.bodyName} ➔ ${tgtInst.bodyName}...`
      );
      await yieldUI();
      pcData = await computePorkchopPlot(link, srcInst, tgtInst, bodies, mainBody);
      porkchopsMap[link.id] = pcData;
    }

    const { depDates, arrDates, c3DepMatrix, c3ArrMatrix, constraintValidMatrix, physicalValidMatrix } = pcData;
    const validMatrix = constraintValidMatrix || physicalValidMatrix || [];
    const N_DEP = depDates.length;
    const N_ARR = arrDates.length;

    const validDepDates: number[] = [];
    const validArrDates: number[] = [];
    const depVinfAchieved: number[] = [];
    const arrVinfAchieved: number[] = [];

    const isSrcSource = !links.some(l => l.targetInstanceId === srcInst.id) || !!srcInst.isSourceOverride;
    const isTgtTarget = !links.some(l => l.sourceInstanceId === tgtInst.id);
    const minSrcVinfMs = isSrcSource ? 0 : srcEnv.minMs;
    const minTgtVinfMs = isTgtTarget ? 0 : tgtEnv.minMs;
    const maxSrcVinfMs = srcInst.computedMaxC3 !== undefined ? Math.sqrt(srcInst.computedMaxC3 * 1e6) : srcEnv.maxMs;
    const maxTgtVinfMs = tgtInst.computedMaxC3 !== undefined ? Math.sqrt(tgtInst.computedMaxC3 * 1e6) : tgtEnv.maxMs;

    // Pure parsing of existing direct porkchop grid
    for (let i = 0; i < N_DEP; i++) {
      for (let j = 0; j < N_ARR; j++) {
        if (!validMatrix[i]?.[j]) continue;

        const c3Dep = c3DepMatrix[i][j];
        const c3Arr = c3ArrMatrix[i][j];
        if (!isFinite(c3Dep) || !isFinite(c3Arr)) continue;

        const vInfDepMag = Math.sqrt(Math.max(0, c3Dep) * 1e6);
        const vInfArrMag = Math.sqrt(Math.max(0, c3Arr) * 1e6);

        const passSrc = (srcInst.computedMinC3 === undefined || c3Dep >= srcInst.computedMinC3 - 0.05) &&
                         (srcInst.computedMaxC3 === undefined || c3Dep <= srcInst.computedMaxC3 + 0.05) &&
                         (vInfDepMag >= minSrcVinfMs - 1.0 && vInfDepMag <= maxSrcVinfMs + 10.0);

        const passTgt = (tgtInst.computedMinC3 === undefined || c3Arr >= tgtInst.computedMinC3 - 0.05) &&
                         (tgtInst.computedMaxC3 === undefined || c3Arr <= tgtInst.computedMaxC3 + 0.05) &&
                         (vInfArrMag >= minTgtVinfMs - 1.0 && vInfArrMag <= maxTgtVinfMs + 10.0);

        if (passSrc && passTgt) {
          validDepDates.push(depDates[i]);
          validArrDates.push(arrDates[j]);
          depVinfAchieved.push(vInfDepMag);
          arrVinfAchieved.push(vInfArrMag);
        }
      }
    }

    const hasValidDepRange = validDepDates.length > 0;
    const hasValidArrRange = validArrDates.length > 0;

    const depDateMin = hasValidDepRange ? Math.min(...validDepDates) : NaN;
    const depDateMax = hasValidDepRange ? Math.max(...validDepDates) : NaN;
    const arrDateMin = hasValidArrRange ? Math.min(...validArrDates) : NaN;
    const arrDateMax = hasValidArrRange ? Math.max(...validArrDates) : NaN;

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
  }

  return { linkEndRangesMap, porkchopsMap };
}

/**
 * Computes Link End Date Ranges asynchronously by parsing direct transfer porkchops.
 */
export async function computeLinkEndDateRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  porkchops: Record<string, PorkchopPlotData> = {},
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<Record<string, LinkEndDateRanges>> {
  const { linkEndRangesMap } = await computeLinkGridsAndRangesAsync(
    instances,
    links,
    bodies,
    mainBody,
    porkchops,
    onProgress
  );
  return linkEndRangesMap;
}

/**
 * Computes consolidated 3-body sequence ranges using transfer porkchop matrix projections.
 * Direct parsing only - zero Lambert calculations and zero dichotomial searches.
 */
export async function compute3BodyConsolidatedRangesAsync(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  porkchops: Record<string, PorkchopPlotData> = {},
  onProgress?: (progressPercent: number, statusText: string) => void
): Promise<{
  linkEndRangesMap: Record<string, LinkEndDateRanges>;
  sequence3BodyRangesList: Sequence3BodyConsolidatedRange[];
  porkchopsMap: Record<string, PorkchopPlotData>;
}> {
  const { linkEndRangesMap, porkchopsMap } = await computeLinkGridsAndRangesAsync(
    instances,
    links,
    bodies,
    mainBody,
    porkchops,
    onProgress
  );

  const subPaths = findAllSubPathsInGraph(links, instances);
  const sub3Paths = subPaths.filter(sp => sp?.pathInsts && sp.pathInsts.length === 3);

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

    const pc1 = porkchopsMap[link1.id];
    const pc2 = porkchopsMap[link2.id];

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

    if (hasFlybyOverlap && pc1 && pc2) {
      // 1. Consolidated Departure Window at Source Instance (filtering Link 1 porkchop grid for flyby overlap)
      const validDepDatesForSeq: number[] = [];
      const valid1 = pc1.constraintValidMatrix || pc1.physicalValidMatrix;
      for (let i = 0; i < pc1.depDates.length; i++) {
        for (let j = 0; j < pc1.arrDates.length; j++) {
          if (valid1?.[i]?.[j]) {
            const arrT = pc1.arrDates[j];
            if (arrT >= consolidatedFlybyMin - 1.0 && arrT <= consolidatedFlybyMax + 1.0) {
              validDepDatesForSeq.push(pc1.depDates[i]);
              break;
            }
          }
        }
      }

      if (validDepDatesForSeq.length > 0) {
        consolidatedDepMin = Math.min(...validDepDatesForSeq);
        consolidatedDepMax = Math.max(...validDepDatesForSeq);
      } else {
        consolidatedDepMin = range1.depDateMin;
        consolidatedDepMax = range1.depDateMax;
      }

      // 2. Consolidated Arrival Window at Target Instance (filtering Link 2 porkchop grid for flyby overlap)
      const validArrDatesForSeq: number[] = [];
      const valid2 = pc2.constraintValidMatrix || pc2.physicalValidMatrix;
      for (let j = 0; j < pc2.arrDates.length; j++) {
        for (let i = 0; i < pc2.depDates.length; i++) {
          if (valid2?.[i]?.[j]) {
            const depT = pc2.depDates[i];
            if (depT >= consolidatedFlybyMin - 1.0 && depT <= consolidatedFlybyMax + 1.0) {
              validArrDatesForSeq.push(pc2.arrDates[j]);
              break;
            }
          }
        }
      }

      if (validArrDatesForSeq.length > 0) {
        consolidatedArrMin = Math.min(...validArrDatesForSeq);
        consolidatedArrMax = Math.max(...validArrDatesForSeq);
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
  return { linkEndRangesMap, sequence3BodyRangesList: consolidatedList, porkchopsMap };
}

/**
 * Synchronous version for legacy compatibility, parsing direct porkchops.
 */
export function computeLinkEndDateRanges(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  porkchops: Record<string, PorkchopPlotData> = {}
): Record<string, LinkEndDateRanges> {
  const envs = computeTisserandEnvelopes(instances, links, bodies, mainBody);
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const result: Record<string, LinkEndDateRanges> = {};

  for (const link of links) {
    const srcInst = instMap.get(link.sourceInstanceId);
    const tgtInst = instMap.get(link.targetInstanceId);
    if (!srcInst || !tgtInst) continue;

    const pcData = porkchops[link.id];
    if (!pcData || !pcData.c3DepMatrix || pcData.c3DepMatrix.length === 0) continue;

    const srcEnv = envs[srcInst.id] || { minMs: 0, maxMs: 1e6 };
    const tgtEnv = envs[tgtInst.id] || { minMs: 0, maxMs: 1e6 };

    const { depDates, arrDates, c3DepMatrix, c3ArrMatrix, constraintValidMatrix, physicalValidMatrix } = pcData;
    const validMatrix = constraintValidMatrix || physicalValidMatrix || [];

    const validDepDates: number[] = [];
    const validArrDates: number[] = [];
    const depVinfAchieved: number[] = [];
    const arrVinfAchieved: number[] = [];

    const isSrcSource = !links.some(l => l.targetInstanceId === srcInst.id) || !!srcInst.isSourceOverride;
    const isTgtTarget = !links.some(l => l.sourceInstanceId === tgtInst.id);
    const minSrcVinfMs = isSrcSource ? 0 : srcEnv.minMs;
    const minTgtVinfMs = isTgtTarget ? 0 : tgtEnv.minMs;
    const maxSrcVinfMs = srcInst.computedMaxC3 !== undefined ? Math.sqrt(srcInst.computedMaxC3 * 1e6) : srcEnv.maxMs;
    const maxTgtVinfMs = tgtInst.computedMaxC3 !== undefined ? Math.sqrt(tgtInst.computedMaxC3 * 1e6) : tgtEnv.maxMs;

    for (let i = 0; i < depDates.length; i++) {
      for (let j = 0; j < arrDates.length; j++) {
        if (!validMatrix[i]?.[j]) continue;

        const c3Dep = c3DepMatrix[i][j];
        const c3Arr = c3ArrMatrix[i][j];
        if (!isFinite(c3Dep) || !isFinite(c3Arr)) continue;

        const vInfDepMag = Math.sqrt(Math.max(0, c3Dep) * 1e6);
        const vInfArrMag = Math.sqrt(Math.max(0, c3Arr) * 1e6);

        const passSrc = (srcInst.computedMinC3 === undefined || c3Dep >= srcInst.computedMinC3 - 0.05) &&
                         (srcInst.computedMaxC3 === undefined || c3Dep <= srcInst.computedMaxC3 + 0.05) &&
                         (vInfDepMag >= minSrcVinfMs - 1.0 && vInfDepMag <= maxSrcVinfMs + 10.0);

        const passTgt = (tgtInst.computedMinC3 === undefined || c3Arr >= tgtInst.computedMinC3 - 0.05) &&
                         (tgtInst.computedMaxC3 === undefined || c3Arr <= tgtInst.computedMaxC3 + 0.05) &&
                         (vInfArrMag >= minTgtVinfMs - 1.0 && vInfArrMag <= maxTgtVinfMs + 10.0);

        if (passSrc && passTgt) {
          validDepDates.push(depDates[i]);
          validArrDates.push(arrDates[j]);
          depVinfAchieved.push(vInfDepMag);
          arrVinfAchieved.push(vInfArrMag);
        }
      }
    }

    const hasValidDepRange = validDepDates.length > 0;
    const hasValidArrRange = validArrDates.length > 0;

    result[link.id] = {
      linkId: link.id,
      sourceInstanceId: link.sourceInstanceId,
      targetInstanceId: link.targetInstanceId,
      sourceBodyName: srcInst.bodyName,
      targetBodyName: tgtInst.bodyName,
      depDateMin: hasValidDepRange ? Math.min(...validDepDates) : NaN,
      depDateMax: hasValidDepRange ? Math.max(...validDepDates) : NaN,
      depVinfMin: depVinfAchieved.length > 0 ? Math.min(...depVinfAchieved) : 0,
      depVinfMax: depVinfAchieved.length > 0 ? Math.max(...depVinfAchieved) : 0,
      depTargetVinfRange: srcEnv,
      hasValidDepRange,
      arrDateMin: hasValidArrRange ? Math.min(...validArrDates) : NaN,
      arrDateMax: hasValidArrRange ? Math.max(...validArrDates) : NaN,
      arrVinfMin: arrVinfAchieved.length > 0 ? Math.min(...arrVinfAchieved) : 0,
      arrVinfMax: arrVinfAchieved.length > 0 ? Math.max(...arrVinfAchieved) : 0,
      arrTargetVinfRange: tgtEnv,
      hasValidArrRange
    };
  }

  return result;
}

/**
 * Synchronous version for 3-body sequences, parsing direct porkchops.
 */
export function compute3BodyConsolidatedRanges(
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  timeFormatMode: 'ksp' | 'earth' = 'ksp',
  porkchops: Record<string, PorkchopPlotData> = {}
): Sequence3BodyConsolidatedRange[] {
  const linkEndRanges = computeLinkEndDateRanges(instances, links, bodies, mainBody, timeFormatMode, porkchops);
  const subPaths = findAllSubPathsInGraph(links, instances);
  const sub3Paths = subPaths.filter(sp => sp?.pathInsts && sp.pathInsts.length === 3);

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

    const pc1 = porkchops[link1.id];
    const pc2 = porkchops[link2.id];

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

    if (hasFlybyOverlap && pc1 && pc2) {
      const validDepDatesForSeq: number[] = [];
      const valid1 = pc1.constraintValidMatrix || pc1.physicalValidMatrix;
      for (let i = 0; i < pc1.depDates.length; i++) {
        for (let j = 0; j < pc1.arrDates.length; j++) {
          if (valid1?.[i]?.[j]) {
            const arrT = pc1.arrDates[j];
            if (arrT >= consolidatedFlybyMin - 1.0 && arrT <= consolidatedFlybyMax + 1.0) {
              validDepDatesForSeq.push(pc1.depDates[i]);
              break;
            }
          }
        }
      }

      if (validDepDatesForSeq.length > 0) {
        consolidatedDepMin = Math.min(...validDepDatesForSeq);
        consolidatedDepMax = Math.max(...validDepDatesForSeq);
      } else {
        consolidatedDepMin = range1.depDateMin;
        consolidatedDepMax = range1.depDateMax;
      }

      const validArrDatesForSeq: number[] = [];
      const valid2 = pc2.constraintValidMatrix || pc2.physicalValidMatrix;
      for (let j = 0; j < pc2.arrDates.length; j++) {
        for (let i = 0; i < pc2.depDates.length; i++) {
          if (valid2?.[i]?.[j]) {
            const depT = pc2.depDates[i];
            if (depT >= consolidatedFlybyMin - 1.0 && depT <= consolidatedFlybyMax + 1.0) {
              validArrDatesForSeq.push(pc2.arrDates[j]);
              break;
            }
          }
        }
      }

      if (validArrDatesForSeq.length > 0) {
        consolidatedArrMin = Math.min(...validArrDatesForSeq);
        consolidatedArrMax = Math.max(...validArrDatesForSeq);
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

  return consolidatedList;
}
