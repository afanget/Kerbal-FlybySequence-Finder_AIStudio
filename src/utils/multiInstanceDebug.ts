/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SequencePorkchopData,
  PorkchopPlotData,
  DirectionalLink,
  CelestialBody,
  OrbitalBody,
  InstanceNode,
  Vector3D,
} from '../types';
import {
  getBodyStateAtUT,
  vecSub,
  vecMag,
  vecDot,
  vecScale,
} from '../physics/kepler';
import { solveLambert } from '../physics/lambert';
import {
  evaluateFlybyAtDate,
  evaluateHigherOrderSequenceTransferAddLastLeg,
  evaluateHigherOrderSequenceTransferAddFirstLeg,
  generateHigherOrderAddFirstLegFlybySamples,
  generateHigherOrderAddLastLegFlybySamples,
  computeFlybyPoweredDv,
  SequenceTransferResult,
} from '../physics/flyby';
import {
  extractFlybyDebugData,
  FlybyDebugPlotData,
  findClosestIndex,
} from './flybyDebugPlot';
import { getMinFlybyAlt } from '../data/solarSystems';

export interface PivotCandidateSample {
  sampleIndex: number;
  tFlyby: number;
  c3DepA: number; // Departure C3 from source (km^2/s^2)
  c3ArrPivot: number; // Inbound C3 to pivot body (km^2/s^2)
  c3DepPivot: number; // Outbound C3 from pivot body (km^2/s^2)
  c3ArrFinal: number; // Arrival C3 at final target (km^2/s^2)
  deflectionAngleDeg: number; // Deflection turn angle needed (deg)
  maxDeflectionAngleDeg: number; // Maximum deflection available at pivot (deg)
  pivotDv: number; // Powered Delta-V maneuver needed at pivot body (m/s)
  subSequenceDv: number; // Delta-V of the rest of the sequence (prior or suffix) (m/s)
  totalDv: number; // Total sequence powered Delta-V (m/s)
  otherFlybyDates: number[]; // Flyby dates of upstream/downstream bodies in the sub-chain
  isValid: boolean;
  isOptimal?: boolean;
}

export interface HigherOrderAlgorithmInfo {
  algorithmType: 'add_first_leg' | 'add_last_leg';
  algorithmName: string;
  subSequenceLabel: string;
  subSequenceType: 'suffix' | 'prefix';
  pivotBodyName: string;
  pivotInstanceId: string;
  pivotFlybyIndex: number; // 1-based index (e.g. 1 for Jool in Kerbin-Jool-Urlum-Grannus)
  samples: PivotCandidateSample[];
  selectedDate: number;
}

export interface MultiInstanceFlybyRow {
  flybyIndex: number; // 1-based index among flybys (1 to N-2)
  instanceIndex: number; // 0-based index in pathInsts (1 to N-2)
  instanceId: string;
  instanceName: string;
  bodyName: string;
  flybyDate: number; // UT timestamp of flyby
  prevBodyName: string;
  nextBodyName: string;
  prevFlybyOrDepDate: number;
  nextFlybyOrArrDate: number;
  c3Arr: number; // km^2/s^2
  c3Dep: number; // km^2/s^2
  deflectionNeededDeg: number; // Actual required turn angle (deg)
  deflectionMaxDeg: number; // Max deflection possible for min(c3Arr, c3Dep) (deg)
  dvMps: number; // Flyby powered Delta-V (m/s)
  isUnpowered: boolean;
  periapsisAltKm: number;
  minSafeAltKm: number;
  // Sub-3-instance debug data generator
  sub3DebugData: FlybyDebugPlotData | null;
  sub3Seq?: SequencePorkchopData | null;
}

export interface MultiInstanceDebugData {
  instanceCount: number;
  pathInsts: InstanceNode[];
  clickDepIndex: number;
  clickArrIndex: number;
  maxDepIndex: number;
  maxArrIndex: number;
  depDate: number;
  arrDate: number;
  totalFlightTime: number;
  totalDv: number;
  c3DepSource: Vector3D;
  c3ArrTarget: Vector3D;
  rows: MultiInstanceFlybyRow[];
  fullResult?: SequenceTransferResult;
  algorithmInfo?: HigherOrderAlgorithmInfo;
}

/**
 * Extracts candidate flyby samples and breakdown for the pivot body
 * in higher-order (N > 3) sequence transfers.
 */
export function extractHigherOrderAlgorithmInfo(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  sequencePorkchops: Record<string, SequencePorkchopData> = {},
  useSuffix: boolean = true,
  chosenFlybyDates: number[] = []
): HigherOrderAlgorithmInfo | null {
  const N = pathInsts.length;
  if (N <= 3) return null;

  if (useSuffix) {
    const suffixPath = pathInsts.slice(1, N);
    const pivotInst = pathInsts[1];

    const rawSamples = generateHigherOrderAddFirstLegFlybySamples(
      pathInsts,
      tDep,
      tArr,
      bodies,
      mainBody,
      porkchops,
      links,
      sequencePorkchops
    );

    if (!rawSamples || rawSamples.length === 0) return null;

    const optimalDate = chosenFlybyDates[0] ?? 0;
    let closestOptDiff = Infinity;
    let closestOptIdx = -1;

    const samples: PivotCandidateSample[] = rawSamples.map((s, idx) => {
      const sampleObj: PivotCandidateSample = {
        sampleIndex: idx + 1,
        tFlyby: s.tFlyby,
        c3DepA: vecMag(s.c3DepA),
        c3ArrPivot: vecMag(s.c3ArrB),
        c3DepPivot: vecMag(s.c3DepB),
        c3ArrFinal: vecMag(s.c3ArrFinal),
        deflectionAngleDeg: s.deflectionAngleDeg,
        maxDeflectionAngleDeg: s.maxDeflectionAngleDeg,
        pivotDv: s.currentDv,
        subSequenceDv: s.suffixCost,
        totalDv: s.totalDv,
        otherFlybyDates: s.suffixFlybyDates,
        isValid: s.isConstraintValid ?? s.isPhysicallyValid,
      };

      if (optimalDate > 0) {
        const diff = Math.abs(s.tFlyby - optimalDate);
        if (diff < closestOptDiff) {
          closestOptDiff = diff;
          closestOptIdx = idx;
        }
      }

      return sampleObj;
    });

    if (closestOptIdx >= 0 && closestOptIdx < samples.length) {
      samples[closestOptIdx].isOptimal = true;
    }

    return {
      algorithmType: 'add_first_leg',
      algorithmName: 'Adding First Leg (Suffix Subsequence)',
      subSequenceLabel: suffixPath.map(i => i.bodyName).join(' ➔ '),
      subSequenceType: 'suffix',
      pivotBodyName: pivotInst.bodyName,
      pivotInstanceId: pivotInst.id,
      pivotFlybyIndex: 1,
      samples,
      selectedDate: optimalDate || (samples[0]?.tFlyby ?? 0),
    };
  } else {
    const prefixPath = pathInsts.slice(0, N - 1);
    const pivotInst = pathInsts[N - 2];

    const rawSamples = generateHigherOrderAddLastLegFlybySamples(
      pathInsts,
      tDep,
      tArr,
      bodies,
      mainBody,
      porkchops,
      links,
      sequencePorkchops
    );

    if (!rawSamples || rawSamples.length === 0) return null;

    const optimalDate = chosenFlybyDates[N - 3] ?? 0;
    let closestOptDiff = Infinity;
    let closestOptIdx = -1;

    const samples: PivotCandidateSample[] = rawSamples.map((s, idx) => {
      const sampleObj: PivotCandidateSample = {
        sampleIndex: idx + 1,
        tFlyby: s.tFlyby,
        c3DepA: vecMag(s.c3DepA),
        c3ArrPivot: vecMag(s.c3ArrB),
        c3DepPivot: vecMag(s.c3DepB),
        c3ArrFinal: vecMag(s.c3ArrFinal),
        deflectionAngleDeg: s.deflectionAngleDeg,
        maxDeflectionAngleDeg: s.maxDeflectionAngleDeg,
        pivotDv: s.currentDv,
        subSequenceDv: s.priorCost,
        totalDv: s.totalDv,
        otherFlybyDates: s.priorFlybyDates,
        isValid: s.isValid,
      };

      if (optimalDate > 0) {
        const diff = Math.abs(s.tFlyby - optimalDate);
        if (diff < closestOptDiff) {
          closestOptDiff = diff;
          closestOptIdx = idx;
        }
      }

      return sampleObj;
    });

    if (closestOptIdx >= 0 && closestOptIdx < samples.length) {
      samples[closestOptIdx].isOptimal = true;
    }

    return {
      algorithmType: 'add_last_leg',
      algorithmName: 'Adding Last Leg (Prefix Subsequence)',
      subSequenceLabel: prefixPath.map(i => i.bodyName).join(' ➔ '),
      subSequenceType: 'prefix',
      pivotBodyName: pivotInst.bodyName,
      pivotInstanceId: pivotInst.id,
      pivotFlybyIndex: N - 2,
      samples,
      selectedDate: optimalDate || (samples[0]?.tFlyby ?? 0),
    };
  }
}

/**
 * Extracts full multi-instance flyby table data for a clicked sample (tDep, tArr)
 * in an N-instance sequence (N > 3).
 */
export function extractMultiInstanceDebugData(
  seqPorkchop: SequencePorkchopData,
  porkchops: Record<string, PorkchopPlotData>,
  links: DirectionalLink[],
  clickDepIndex: number,
  clickArrIndex: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  sequencePorkchops?: Record<string, SequencePorkchopData>
): MultiInstanceDebugData | null {
  if (!seqPorkchop || !seqPorkchop.depDates || !seqPorkchop.arrDates) return null;

  const maxDepIndex = Math.max(0, seqPorkchop.depDates.length - 1);
  const maxArrIndex = Math.max(0, seqPorkchop.arrDates.length - 1);

  const clampedDepIndex = Math.max(0, Math.min(maxDepIndex, clickDepIndex));
  const clampedArrIndex = Math.max(0, Math.min(maxArrIndex, clickArrIndex));

  const tDep = seqPorkchop.depDates[clampedDepIndex];
  const tArr = seqPorkchop.arrDates[clampedArrIndex];

  // Resolve path instances
  const pathInsts: InstanceNode[] = [
    seqPorkchop.sourceBody,
    ...seqPorkchop.flybys.map(f => f.instance),
    seqPorkchop.targetBody,
  ];

  const N = pathInsts.length;
  if (N <= 3) return null;

  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // Determine sub-chain strategy
  const suffixPath = pathInsts.slice(1, N);
  const suffixKey = suffixPath.map(i => i.id).join('-');
  const suffixSeqId = `seq-pc-${suffixKey}`;
  const hasSuffix = !!(sequencePorkchops && (sequencePorkchops[suffixSeqId] || sequencePorkchops[suffixKey]));

  const prefixPath = pathInsts.slice(0, N - 1);
  const prefixKey = prefixPath.map(i => i.id).join('-');
  const prefixSeqId = `seq-pc-${prefixKey}`;
  const hasPrefix = !!(sequencePorkchops && (sequencePorkchops[prefixSeqId] || sequencePorkchops[prefixKey]));

  // Default to suffix (evaluateHigherOrderSequenceTransferAddFirstLeg) when neither is pre-calculated
  const useSuffix = !(hasPrefix && !hasSuffix);

  let result: SequenceTransferResult = useSuffix ?
    evaluateHigherOrderSequenceTransferAddFirstLeg(
      pathInsts,
      tDep,
      tArr,
      bodies,
      mainBody,
      porkchops,
      links,
      sequencePorkchops || {}
    )!
   : evaluateHigherOrderSequenceTransferAddLastLeg(
      pathInsts,
      tDep,
      tArr,
      bodies,
      mainBody,
      porkchops,
      links,
      sequencePorkchops || {}
    )!;

  const rows: MultiInstanceFlybyRow[] = [];
  const flybyDates = (result?.flybyDates && result.flybyDates.length === N - 2) ? result.flybyDates : [];

  if (flybyDates.length === N - 2) {
    const fullDates: number[] = [tDep, ...flybyDates, tArr];

    for (let k = 1; k <= N - 2; k++) {
      const prevInst = pathInsts[k - 1];
      const currInst = pathInsts[k];
      const nextInst = pathInsts[k + 1];

      const currBody = bodyMap.get(currInst.bodyName)!;

      const tPrev = fullDates[k - 1];
      const tCurr = fullDates[k];
      const tNext = fullDates[k + 1];

      const mu = currBody.stdGravParam;
      const R = currBody.radius;
      const minAlt = getMinFlybyAlt(currBody);
      const rpMin = R + minAlt;

      // Find direct porkchops for leg 1 (prev -> curr) and leg 2 (curr -> next)
      const link1 = links.find(l => l.sourceInstanceId === prevInst.id && l.targetInstanceId === currInst.id);
      const link1Id = link1?.id || `link-${prevInst.id}-${currInst.id}`;
      const pc1 = porkchops[link1Id] || (link1 ? porkchops[link1.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === prevInst.bodyName && p.targetBody === currInst.bodyName);

      const link2 = links.find(l => l.sourceInstanceId === currInst.id && l.targetInstanceId === nextInst.id);
      const link2Id = link2?.id || `link-${currInst.id}-${nextInst.id}`;
      const pc2 = porkchops[link2Id] || (link2 ? porkchops[link2.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === currInst.bodyName && p.targetBody === nextInst.bodyName);

      let c3Arr : Vector3D =  { x: Infinity, y: Infinity, z: Infinity };
      let c3Dep : Vector3D = { x: Infinity, y: Infinity, z: Infinity };
      let vInfIn: Vector3D = { x: Infinity, y: Infinity, z: Infinity };
      let vInfOut: Vector3D = { x: Infinity, y: Infinity, z: Infinity };
      let hasValidLeg1 = false;
      let hasValidLeg2 = false;

      const bodyState = currBody ? getBodyStateAtUT(currBody, mainBody, tCurr) : { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

      if (pc1 && pc1.depDates && pc1.arrDates) {
        const i1 = findClosestIndex(pc1.depDates, tPrev);
        const j1 = findClosestIndex(pc1.arrDates, tCurr);
        const rawC3 = pc1.c3ArrMatrix?.[i1]?.[j1];
        const valid1 = pc1.constraintValidMatrix || pc1.physicalValidMatrix;
        if (rawC3 !== undefined && Number.isFinite(rawC3) && vecMag(rawC3) >= 0 && (!valid1 || valid1[i1]?.[j1])) {
          c3Arr = rawC3;
          hasValidLeg1 = true;
          if (pc1.vTransArrMatrix?.[i1]?.[j1] && vecMag(pc1.vTransArrMatrix[i1][j1]) > 1e-3) {
            vInfIn = vecSub(pc1.vTransArrMatrix[i1][j1], bodyState.vel);
          } else {
            const vMag = Math.sqrt(vecMag(c3Arr) * 1e6);
            vInfIn = { x: vMag, y: 0, z: 0 };
          }
        }
      }

      if (pc2 && pc2.depDates && pc2.arrDates) {
        const i2 = findClosestIndex(pc2.depDates, tCurr);
        const j2 = findClosestIndex(pc2.arrDates, tNext);
        const rawC3 = pc2.c3DepMatrix?.[i2]?.[j2];
        const valid2 = pc2.constraintValidMatrix || pc2.physicalValidMatrix;
        if (rawC3 !== undefined && Number.isFinite(rawC3) && vecMag(rawC3) >= 0 && (!valid2 || valid2[i2]?.[j2])) {
          c3Dep = rawC3;
          hasValidLeg2 = true;
          if (pc2.vTransDepMatrix?.[i2]?.[j2] && vecMag(pc2.vTransDepMatrix[i2][j2]) > 1e-3) {
            vInfOut = vecSub(pc2.vTransDepMatrix[i2][j2], bodyState.vel);
          } else {
            const vMag = Math.sqrt(vecMag(c3Dep) * 1e6);
            vInfOut = { x: vMag, y: 0, z: 0 };
          }
        }
      }

      const vInMag = hasValidLeg1 ? vecMag(vInfIn) : 0;
      const vOutMag = hasValidLeg2 ? vecMag(vInfOut) : 0;

      // Deflection needed
      let deflectionNeededDeg = 0;
      if (hasValidLeg1 && hasValidLeg2 && vInMag > 1e-3 && vOutMag > 1e-3) {
        const cosDelta = Math.max(-1, Math.min(1, vecDot(vInfIn, vInfOut) / (vInMag * vOutMag)));
        deflectionNeededDeg = (Math.acos(cosDelta) * 180) / Math.PI;
      }

      // Max deflection for min(arrC3, depC3)
      let deflectionMaxDeg = 0;
      let vMinMag = 0;
      if (hasValidLeg1 && hasValidLeg2 && Number.isFinite(c3Arr) && Number.isFinite(c3Dep)) {
        const minC3 = Math.max(0, Math.min(vecMag(c3Arr), vecMag(c3Dep)));
        vMinMag = Math.sqrt(minC3 * 1e6);
        const eMin = 1 + (rpMin * vMinMag * vMinMag) / Math.max(1, mu);
        const maxDefRad = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / eMin)));
        deflectionMaxDeg = (maxDefRad * 180) / Math.PI;
      }

      // Delta-V from result or computed from excess angle
      let dvMps = result?.flybyDvs?.[k - 1] ?? 0;
      if (!Number.isFinite(dvMps)) {
        dvMps = Infinity;
      }
      if (!result || (!Number.isFinite(dvMps) && hasValidLeg1 && hasValidLeg2)) {
        if (hasValidLeg1 && hasValidLeg2) {
          dvMps = computeFlybyPoweredDv(
            vInMag,
            vOutMag,
            deflectionNeededDeg,
            deflectionMaxDeg,
            mu,
            rpMin
          );
        }
      }

      // Periapsis altitude
      const sinHalf = Math.sin((deflectionNeededDeg * Math.PI) / 360);
      let rp = rpMin;
      if (sinHalf > 1e-6 && vMinMag > 1e-3) {
        rp = Math.max(rpMin, (mu / (vMinMag * vMinMag)) * (1 / sinHalf - 1));
      }
      const periapsisAltKm = (rp - R) / 1000;

      // Generate 3-instance debug data for this sub-system [prevInst, currInst, nextInst]
      let sub3DebugData: FlybyDebugPlotData | null = null;
      let sub3Seq: SequencePorkchopData | null = null;
      if (pc1 && pc2) {
        sub3Seq = {
          id: `seq-pc-${prevInst.id}-${currInst.id}-${nextInst.id}`,
          sequenceLabel: `${prevInst.bodyName} ➔ ${currInst.bodyName} ➔ ${nextInst.bodyName}`,
          isFullPath: false,
          instanceCount: 3,
          sourceBody: prevInst,
          targetBody: nextInst,
          depDates: pc1.depDates,
          arrDates: pc2.arrDates,
          flybys: [{
            instance: currInst,
            poweredDvMatrix: [],
            c3ArrMatrix: [],
            c3DepMatrix: [],
            dateMatrix: [],
          }],
          flightTimeMatrix: [],
          physicalValidMatrix: [],
          constraintValidMatrix: [],
          totalPoweredDvMatrix: [],
          c3DepMatrix: [],
          c3ArrMatrix: [],
          computedSamples: 0,
          totalSamples: 0,
        };

        const clickI_sub = findClosestIndex(pc1.depDates, tPrev);
        const clickJ_sub = findClosestIndex(pc2.arrDates, tNext);

        sub3DebugData = extractFlybyDebugData(
          sub3Seq,
          porkchops,
          links,
          clickI_sub,
          clickJ_sub,
          bodies,
          mainBody
        );
      }

      rows.push({
        flybyIndex: k,
        instanceIndex: k,
        instanceId: currInst.id,
        instanceName: currInst.label || currInst.bodyName,
        bodyName: currInst.bodyName,
        flybyDate: tCurr,
        prevBodyName: prevInst.bodyName,
        nextBodyName: nextInst.bodyName,
        prevFlybyOrDepDate: tPrev,
        nextFlybyOrArrDate: tNext,
        c3Arr: vecMag(c3Arr),
        c3Dep: vecMag(c3Dep),
        deflectionNeededDeg,
        deflectionMaxDeg,
        dvMps,
        isUnpowered: dvMps < 1.0,
        periapsisAltKm,
        minSafeAltKm: minAlt / 1000,
        sub3DebugData,
        sub3Seq,
      });
    }
  }

  const algorithmInfo = extractHigherOrderAlgorithmInfo(
    pathInsts,
    tDep,
    tArr,
    bodies,
    mainBody,
    porkchops,
    links,
    sequencePorkchops || {},
    useSuffix,
    flybyDates
  )!;

  return {
    instanceCount: N,
    pathInsts,
    clickDepIndex: clampedDepIndex,
    clickArrIndex: clampedArrIndex,
    maxDepIndex,
    maxArrIndex,
    depDate: tDep,
    arrDate: tArr,
    totalFlightTime: tArr - tDep,
    totalDv: result?.totalDv ?? rows.reduce((sum, r) => sum + r.dvMps, 0),
    c3DepSource: result?.c3DepA ?? (porkchops[`link-${pathInsts[0].id}-${pathInsts[1].id}`]?.c3DepMatrix?.[clampedDepIndex]?.[0]),
    c3ArrTarget: result?.c3ArrFinal ?? (porkchops[`link-${pathInsts[N - 2].id}-${pathInsts[N - 1].id}`]?.c3ArrMatrix?.[0]?.[clampedArrIndex]),
    rows,
    fullResult: result,
    algorithmInfo,
  };
}

/**
 * Re-evaluates all multi-instance flyby rows and transfer metrics for an arbitrary
 * array of custom dates: [tDep, tFlyby_1, ..., tFlyby_{N-2}, tArr] (length N).
 */
export function evaluateMultiInstanceForDates(
  pathInsts: InstanceNode[],
  customDates: number[],
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = []
): {
  rows: MultiInstanceFlybyRow[];
  totalDv: number;
  c3DepSource: Vector3D;
  c3ArrTarget: Vector3D;
  totalFlightTime: number;
} {
  const N = pathInsts.length;
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const tDep = customDates[0];
  const tArr = customDates[N - 1];
  const muCentral = mainBody.stdGravParam;

  const rows: MultiInstanceFlybyRow[] = [];

  for (let k = 1; k <= N - 2; k++) {
    const prevInst = pathInsts[k - 1];
    const currInst = pathInsts[k];
    const nextInst = pathInsts[k + 1];

    const prevBody = bodyMap.get(prevInst.bodyName)!;
    const currBody = bodyMap.get(currInst.bodyName)!;
    const nextBody = bodyMap.get(nextInst.bodyName)!;

    const tPrev = customDates[k - 1];
    const tCurr = customDates[k];
    const tNext = customDates[k + 1];

    // Direct link lookups
    const link1 = links.find(l => l.sourceInstanceId === prevInst.id && l.targetInstanceId === currInst.id);
    const link1Id = link1?.id || `link-${prevInst.id}-${currInst.id}`;
    const pc1 = porkchops[link1Id] || (link1 ? porkchops[link1.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === prevInst.bodyName && p.targetBody === currInst.bodyName);

    const link2 = links.find(l => l.sourceInstanceId === currInst.id && l.targetInstanceId === nextInst.id);
    const link2Id = link2?.id || `link-${currInst.id}-${nextInst.id}`;
    const pc2 = porkchops[link2Id] || (link2 ? porkchops[link2.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === currInst.bodyName && p.targetBody === nextInst.bodyName);

    const bodyState = currBody ? getBodyStateAtUT(currBody, mainBody, tCurr) : { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

    // Inbound transfer velocity vTransArr
    let vTransArr: Vector3D | undefined;
    if (pc1 && pc1.vTransArrMatrix && pc1.depDates && pc1.arrDates) {
      const i1 = findClosestIndex(pc1.depDates, tPrev);
      const j1 = findClosestIndex(pc1.arrDates, tCurr);
      const valid1 = pc1.constraintValidMatrix || pc1.physicalValidMatrix;
      if (Math.abs(pc1.depDates[i1] - tPrev) < 100 && Math.abs(pc1.arrDates[j1] - tCurr) < 100 && (!valid1 || valid1[i1]?.[j1])) {
        vTransArr = pc1.vTransArrMatrix[i1]?.[j1];
      }
    }
    if (!vTransArr || vecMag(vTransArr) < 1e-3) {
      const dt1 = tCurr - tPrev;
      if (dt1 > 0) {
        const stPrev = getBodyStateAtUT(prevBody, mainBody, tPrev);
        const lamb1 = solveLambert(stPrev.pos, bodyState.pos, dt1, muCentral, true);
        if (lamb1 && lamb1.isValid && lamb1.v2 && vecMag(lamb1.v2) > 1e-3) {
          vTransArr = lamb1.v2;
        }
      }
    }

    // Outbound transfer velocity vTransDep
    let vTransDep: Vector3D | undefined;
    if (pc2 && pc2.vTransDepMatrix && pc2.depDates && pc2.arrDates) {
      const i2 = findClosestIndex(pc2.depDates, tCurr);
      const j2 = findClosestIndex(pc2.arrDates, tNext);
      const valid2 = pc2.constraintValidMatrix || pc2.physicalValidMatrix;
      if (Math.abs(pc2.depDates[i2] - tCurr) < 100 && Math.abs(pc2.arrDates[j2] - tNext) < 100 && (!valid2 || valid2[i2]?.[j2])) {
        vTransDep = pc2.vTransDepMatrix[i2]?.[j2];
      }
    }
    if (!vTransDep || vecMag(vTransDep) < 1e-3) {
      const dt2 = tNext - tCurr;
      if (dt2 > 0) {
        const stNext = getBodyStateAtUT(nextBody, mainBody, tNext);
        const lamb2 = solveLambert(bodyState.pos, stNext.pos, dt2, muCentral, true);
        if (lamb2 && lamb2.isValid && lamb2.v1 && vecMag(lamb2.v1) > 1e-3) {
          vTransDep = lamb2.v1;
        }
      }
    }

    const vInfIn = vTransArr ? vecSub(vTransArr, bodyState.vel) : { x: 0, y: 0, z: 0 };
    const vInfOut = vTransDep ? vecSub(vTransDep, bodyState.vel) : { x: 0, y: 0, z: 0 };

    const c3Arr = (vecMag(vInfIn) ** 2) / 1e6;
    const c3Dep = (vecMag(vInfOut) ** 2) / 1e6;

    const flybyEval = evaluateFlybyAtDate(currBody, vInfIn, vInfOut, tCurr, currInst.minFlybyAltitude);

    // Sub-3 debug data
    let sub3DebugData: FlybyDebugPlotData | null = null;
    let sub3Seq: SequencePorkchopData | null = null;
    if (pc1 && pc2) {
      sub3Seq = {
        id: `seq-pc-${prevInst.id}-${currInst.id}-${nextInst.id}`,
        sequenceLabel: `${prevInst.bodyName} ➔ ${currInst.bodyName} ➔ ${nextInst.bodyName}`,
        isFullPath: false,
        instanceCount: 3,
        sourceBody: prevInst,
        targetBody: nextInst,
        depDates: pc1.depDates,
        arrDates: pc2.arrDates,
        flybys: [{
          instance: currInst,
          poweredDvMatrix: [],
          c3ArrMatrix: [],
          c3DepMatrix: [],
          dateMatrix: [],
        }],
        flightTimeMatrix: [],
        physicalValidMatrix: [],
        constraintValidMatrix: [],
        totalPoweredDvMatrix: [],
        c3DepMatrix: [],
        c3ArrMatrix: [],
        computedSamples: 0,
        totalSamples: 0,
      };

      const clickI_sub = findClosestIndex(pc1.depDates, tPrev);
      const clickJ_sub = findClosestIndex(pc2.arrDates, tNext);

      sub3DebugData = extractFlybyDebugData(
        sub3Seq,
        porkchops,
        links,
        clickI_sub,
        clickJ_sub,
        bodies,
        mainBody
      );
    }

    rows.push({
      flybyIndex: k,
      instanceIndex: k,
      instanceId: currInst.id,
      instanceName: currInst.label || currInst.bodyName,
      bodyName: currInst.bodyName,
      flybyDate: tCurr,
      prevBodyName: prevInst.bodyName,
      nextBodyName: nextInst.bodyName,
      prevFlybyOrDepDate: tPrev,
      nextFlybyOrArrDate: tNext,
      c3Arr: Number.isFinite(c3Arr) ? c3Arr : Infinity,
      c3Dep: Number.isFinite(c3Dep) ? c3Dep : Infinity,
      deflectionNeededDeg: flybyEval.deflectionAngleDeg,
      deflectionMaxDeg: flybyEval.maxDeflectionAngleDeg,
      dvMps: Number.isFinite(flybyEval.poweredDv) ? flybyEval.poweredDv : Infinity,
      isUnpowered: flybyEval.isUnpowered || flybyEval.poweredDv < 1.0,
      periapsisAltKm: flybyEval.periapsisAlt / 1000,
      minSafeAltKm: getMinFlybyAlt(currBody, currInst.minFlybyAltitude) / 1000,
      sub3DebugData,
      sub3Seq,
    });
  }

  // Calculate departure C3 from source body
  let c3DepSource : Vector3D = { x: Infinity, y: Infinity, z: Infinity };
  const srcBody = bodyMap.get(pathInsts[0].bodyName)!;
  const fb1Body = bodyMap.get(pathInsts[1].bodyName)!;
  const dt0 = customDates[1] - customDates[0];
  if (dt0 > 0) {
    const st0 = getBodyStateAtUT(srcBody, mainBody, customDates[0]);
    const st1 = getBodyStateAtUT(fb1Body, mainBody, customDates[1]);
    const lamb0 = solveLambert(st0.pos, st1.pos, dt0, muCentral, true);
    if (lamb0 && lamb0.isValid && lamb0.v1) {
      const vInf0 = vecSub(lamb0.v1, st0.vel);
      c3DepSource = vecScale(vInf0, vecMag(vInf0) / 1e6);
    }
  }

  // Calculate arrival C3 at target body
  let c3ArrTarget : Vector3D = { x: Infinity, y: Infinity, z: Infinity };
  const fbN2Body = bodyMap.get(pathInsts[N - 2].bodyName)!;
  const tgtBody = bodyMap.get(pathInsts[N - 1].bodyName)!;
  const dtLast = customDates[N - 1] - customDates[N - 2];
  if (dtLast > 0) {
    const stN2 = getBodyStateAtUT(fbN2Body, mainBody, customDates[N - 2]);
    const stN1 = getBodyStateAtUT(tgtBody, mainBody, customDates[N - 1]);
    const lambLast = solveLambert(stN2.pos, stN1.pos, dtLast, muCentral, true);
    if (lambLast && lambLast.isValid && lambLast.v2) {
      const vInfTarget = vecSub(lambLast.v2, stN1.vel);
      c3ArrTarget = vecScale(vInfTarget, vecMag(vInfTarget) / 1e6);
    }
  }

  const totalDv = rows.reduce((sum, r) => sum + (Number.isFinite(r.dvMps) ? r.dvMps : 0), 0);

  return {
    rows,
    totalDv,
    c3DepSource,
    c3ArrTarget,
    totalFlightTime: tArr - tDep,
  };
}

/**
 * Performs continuous dichotomic / bisection optimization on an intermediate flyby date
 * to locate the optimal date (including 0 m/s unpowered C3 zero-crossings) between its surrounding dates.
 */
export function optimizeFlybyDateDichotomic(
  pathInsts: InstanceNode[],
  currentDates: number[],
  flybyIndex: number, // 1 to N-2
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = []
): number {
  const tPrev = currentDates[flybyIndex - 1];
  const tNext = currentDates[flybyIndex + 1];
  if (tNext <= tPrev) return currentDates[flybyIndex];

  const minT = tPrev + 86400 * 0.5; // at least 0.5 day after previous date
  const maxT = tNext - 86400 * 0.5; // at least 0.5 day before next date
  if (maxT <= minT) return currentDates[flybyIndex];

  const evalAtT = (t: number) => {
    const dates = [...currentDates];
    dates[flybyIndex] = t;
    const res = evaluateMultiInstanceForDates(pathInsts, dates, bodies, mainBody, porkchops, links);
    const row = res.rows[flybyIndex - 1];
    return {
      t,
      dv: row ? row.dvMps : Infinity,
      c3Diff: row ? row.c3Arr - row.c3Dep : Infinity,
      totalDv: res.totalDv,
    };
  };

  // 1. Grid sample candidates
  const SAMPLES_COUNT = 60;
  const samples: { t: number; dv: number; c3Diff: number; totalDv: number }[] = [];
  for (let s = 0; s <= SAMPLES_COUNT; s++) {
    const t = minT + (s / SAMPLES_COUNT) * (maxT - minT);
    samples.push(evalAtT(t));
  }

  const candidateDates: number[] = [currentDates[flybyIndex]];

  // 2. Search for exact C3 zero-crossing (unpowered flyby intersection)
  for (let s = 0; s < samples.length - 1; s++) {
    const s1 = samples[s];
    const s2 = samples[s + 1];
    if (Number.isFinite(s1.c3Diff) && Number.isFinite(s2.c3Diff)) {
      if (s1.c3Diff * s2.c3Diff <= 0 && Math.abs(s1.c3Diff - s2.c3Diff) > 1e-9) {
        let a = s1.t;
        let b = s2.t;
        for (let iter = 0; iter < 25; iter++) {
          const mid = (a + b) / 2;
          const midEval = evalAtT(mid);
          if (Math.abs(midEval.c3Diff) < 1e-4 || Math.abs(b - a) < 10) {
            candidateDates.push(mid);
            break;
          }
          const aEval = evalAtT(a);
          if (aEval.c3Diff * midEval.c3Diff <= 0) {
            b = mid;
          } else {
            a = mid;
          }
        }
      }
    }
  }

  // 3. Search for local minima in Delta-V
  for (let s = 0; s < samples.length; s++) {
    const prev = s > 0 ? samples[s - 1].dv : Infinity;
    const next = s < samples.length - 1 ? samples[s + 1].dv : Infinity;
    if (samples[s].dv <= prev && samples[s].dv <= next && Number.isFinite(samples[s].dv)) {
      let a = s > 0 ? samples[s - 1].t : samples[0].t;
      let b = s < samples.length - 1 ? samples[s + 1].t : samples[samples.length - 1].t;
      for (let iter = 0; iter < 25; iter++) {
        const delta = (b - a) * 0.001;
        const mid = (a + b) / 2;
        const m1 = mid - delta;
        const m2 = mid + delta;
        const e1 = evalAtT(m1);
        const e2 = evalAtT(m2);

        if (e1.dv < 0.1 || e2.dv < 0.1) {
          candidateDates.push(e1.dv < e2.dv ? m1 : m2);
          break;
        }
        if (e1.dv < e2.dv) {
          b = m2;
        } else {
          a = m1;
        }
        if (b - a < 10) {
          candidateDates.push(mid);
          break;
        }
      }
    }
  }

  // 4. Select best candidate
  let bestT = currentDates[flybyIndex];
  let bestDv = evalAtT(bestT).totalDv;

  for (const cDate of candidateDates) {
    const ev = evalAtT(cDate);
    if (ev.totalDv < bestDv) {
      bestDv = ev.totalDv;
      bestT = cDate;
    }
    if (ev.dv < 0.1 && ev.totalDv <= bestDv + 1.0) {
      bestDv = ev.totalDv;
      bestT = cDate;
      break;
    }
  }

  return bestT;
}

/**
 * Optimizes all intermediate flyby dates in sequence using dichotomic search passes.
 */
export function optimizeAllFlybyDates(
  pathInsts: InstanceNode[],
  currentDates: number[],
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = []
): number[] {
  const N = pathInsts.length;
  if (N <= 3) return currentDates;

  const dates = [...currentDates];

  // 2 iterative refinement passes (forward and backward)
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k <= N - 2; k++) {
      dates[k] = optimizeFlybyDateDichotomic(pathInsts, dates, k, bodies, mainBody, porkchops, links);
    }
    for (let k = N - 2; k >= 1; k--) {
      dates[k] = optimizeFlybyDateDichotomic(pathInsts, dates, k, bodies, mainBody, porkchops, links);
    }
  }

  return dates;
}

/**
 * Estimates a reasonable step size for `<` and `>` date steppers at a flyby index.
 */
export function getFlybyDateSampleStep(
  pathInsts: InstanceNode[],
  flybyIndex: number,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = []
): number {
  const prevInst = pathInsts[flybyIndex - 1];
  const currInst = pathInsts[flybyIndex];
  if (!prevInst || !currInst) return 86400; // 1 day default

  const link = links.find(l => l.sourceInstanceId === prevInst.id && l.targetInstanceId === currInst.id);
  const pc = link ? porkchops[link.id] : Object.values(porkchops).find(p => p.sourceBody === prevInst.bodyName && p.targetBody === currInst.bodyName);

  if (pc && pc.arrDates && pc.arrDates.length >= 2) {
    const dt = Math.abs(pc.arrDates[pc.arrDates.length - 1] - pc.arrDates[0]) / pc.arrDates.length;
    if (dt > 100 && dt < 86400 * 30) {
      return dt;
    }
  }

  return 86400; // 1 day
}

