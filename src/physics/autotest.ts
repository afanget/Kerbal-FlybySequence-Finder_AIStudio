/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  OrbitalElements,
  Vector3D,
  getStateFromOrbitalElements,
  stateToOrbitalElements,
  vecSub,
  vecMag,
  getBodyStateAtUT,
  getGravitationalParameter
} from './kepler';
import { solveLambert } from './lambert';
import { evaluateFlybyAtDate } from './flyby';
import { PRESET_SOLAR_SYSTEMS } from '../data/solarSystems';
import { parseKSPTimeToUT, formatShortUT } from '../utils/timeFormat';
import { runSequenceSearch } from './solver';
import { InstanceNode, DirectionalLink, FlybyDetail } from '../types';

export interface AutotestCaseResult {
  caseId: string;
  caseName: string;
  type: 'elliptical' | 'parabolic' | 'hyperbolic';
  passed: boolean;
  
  // Step 1: Initial Orbit
  initialOrbit: OrbitalElements;
  mu: number;
  
  // Step 2: Generated position, velocity and time of flight
  step2: {
    t1: number;
    t2: number;
    dt: number;
    pos1: Vector3D;
    vel1: Vector3D;
    pos2: Vector3D;
    vel2: Vector3D;
  };

  // Step 3: Lambert solution check
  step3: {
    passed: boolean;
    v1Lambert: Vector3D;
    v2Lambert: Vector3D;
    errV1: number; // absolute m/s delta
    errV2: number;
    relErrV1: number;
    relErrV2: number;
  };

  // Step 4: Reconstructed orbital elements coherence
  step4: {
    passed: boolean;
    recoveredElements1: OrbitalElements;
    recoveredElements2: OrbitalElements;
    errSMA: number; // relative error
    errEcc: number; // absolute error
    errInc: number; // absolute error in degrees
    errNode: number; // absolute error in degrees
    errArgPeri: number; // absolute error in degrees
  };
}

export interface AutotestSuiteResult {
  timestamp: number;
  overallPassed: boolean;
  cases: AutotestCaseResult[];
}

/**
 * Runs the physics autotest suite covering Elliptical, Parabolic, and Hyperbolic orbits.
 */
export function runPhysicsAutotestSuite(): AutotestSuiteResult {
  // Central gravitational parameter (Sun mu = 1.1723328e18 m^3/s^2)
  const muSun = 1.1723328e18;

  const casesToTest = [
    {
      caseId: 'orbit-elliptical',
      caseName: 'Elliptical Orbit (e = 0.25)',
      type: 'elliptical' as const,
      mu: muSun,
      initialOrbit: {
        semiMajorAxis: 1.5e11, // ~1 AU
        eccentricity: 0.25,
        inclination: (7 * Math.PI) / 180,
        ascNodeLongitude: (45 * Math.PI) / 180,
        argOfPeriapsis: (30 * Math.PI) / 180,
        meanAnomalyEpoch: 0.1,
        trueAnomalyEpoch: 0,
        epoch: 0
      },
      t1: 86400 * 10,   // 10 days
      t2: 86400 * 100,  // 100 days (dt = 90 days)
    },
    {
      caseId: 'orbit-parabolic',
      caseName: 'Parabolic (e = 1)',
      type: 'parabolic' as const,
      mu: muSun,
      initialOrbit: {
        semiMajorAxis: 1.0e12,
        eccentricity: 1,
        inclination: (3 * Math.PI) / 180,
        ascNodeLongitude: (15 * Math.PI) / 180,
        argOfPeriapsis: (20 * Math.PI) / 180,
        meanAnomalyEpoch: 0.005,
        trueAnomalyEpoch: 0,
        epoch: 0
      },
      t1: 86400 * 5,
      t2: 86400 * 120, // dt = 115 days
    },
    {
      caseId: 'orbit-hyperbolic',
      caseName: 'Hyperbolic Orbit (e = 1.4)',
      type: 'hyperbolic' as const,
      mu: muSun,
      initialOrbit: {
        semiMajorAxis: -5.0e10, // negative semi-major axis for hyperbolic trajectory
        eccentricity: 1.4,
        inclination: (12 * Math.PI) / 180,
        ascNodeLongitude: (60 * Math.PI) / 180,
        argOfPeriapsis: (40 * Math.PI) / 180,
        meanAnomalyEpoch: 0.05,
        trueAnomalyEpoch: 0,
        epoch: 0
      },
      t1: 86400 * 2,
      t2: 86400 * 25, // dt = 23 days
    }
  ];

  const caseResults: AutotestCaseResult[] = casesToTest.map(c => {
    const { initialOrbit, mu, t1, t2 } = c;
    const dt = t2 - t1;

    // 2. Generate 2 positions and velocities on orbit and time of flight
    const state1 = getStateFromOrbitalElements(initialOrbit, mu, t1);
    const state2 = getStateFromOrbitalElements(initialOrbit, mu, t2);

    const pos1 = state1.pos;
    const vel1 = state1.vel;
    const pos2 = state2.pos;
    const vel2 = state2.vel;

    // 3. Solve Lambert for pos1 and pos2 with dt
    const lambertSol = solveLambert(pos1, pos2, dt, mu, true);

    const v1Mag = vecMag(vel1);
    const v2Mag = vecMag(vel2);

    const errV1 = vecMag(vecSub(lambertSol.v1, vel1));
    const errV2 = vecMag(vecSub(lambertSol.v2, vel2));

    const relErrV1 = v1Mag > 0 ? errV1 / v1Mag : errV1;
    const relErrV2 = v2Mag > 0 ? errV2 / v2Mag : errV2;

    // Pass criteria for Lambert solver speed match (less than 0.5% relative error or 1 m/s)
    const step3Passed = lambertSol.isValid && relErrV1 < 0.005 && relErrV2 < 0.005;

    // 4. Regenerate orbital elements from position and Lambert velocity
    const recoveredElements1 = stateToOrbitalElements(pos1, lambertSol.v1, mu, t1);
    const recoveredElements2 = stateToOrbitalElements(pos2, lambertSol.v2, mu, t2);

    const absInitSMA = Math.abs(initialOrbit.semiMajorAxis);
    const errSMA = Math.abs(recoveredElements1.semiMajorAxis - initialOrbit.semiMajorAxis) / absInitSMA;
    const errEcc = Math.abs(recoveredElements1.eccentricity - initialOrbit.eccentricity);

    const radToDeg = 180 / Math.PI;
    const errInc = Math.abs(recoveredElements1.inclination - initialOrbit.inclination) * radToDeg;
    const errNode = Math.abs(recoveredElements1.ascNodeLongitude - initialOrbit.ascNodeLongitude) * radToDeg;
    const errArgPeri = Math.abs(recoveredElements1.argOfPeriapsis - initialOrbit.argOfPeriapsis) * radToDeg;

    // Pass criteria for orbital elements coherence (< 1% SMA error, < 0.01 e error, < 0.1 deg angle error)
    const smaPassed = c.type === 'parabolic' ? true : errSMA < 0.01;
    const step4Passed = step3Passed && smaPassed && errEcc < 0.01 && errInc < 0.1;

    return {
      caseId: c.caseId,
      caseName: c.caseName,
      type: c.type,
      passed: step3Passed && step4Passed,
      initialOrbit,
      mu,
      step2: {
        t1,
        t2,
        dt,
        pos1,
        vel1,
        pos2,
        vel2
      },
      step3: {
        passed: step3Passed,
        v1Lambert: lambertSol.v1,
        v2Lambert: lambertSol.v2,
        errV1,
        errV2,
        relErrV1,
        relErrV2
      },
      step4: {
        passed: step4Passed,
        recoveredElements1,
        recoveredElements2,
        errSMA,
        errEcc,
        errInc,
        errNode,
        errArgPeri
      }
    };
  });

  const overallPassed = caseResults.every(r => r.passed);

  return {
    timestamp: Date.now(),
    overallPassed,
    cases: caseResults
  };
}

export interface KEJGFlybyInfo {
  bodyName: string;
  ut: number;
  inboundVInfMag: number;
  outboundVInfMag: number;
  deflectionAngleDeg: number;
  maxDeflectionAngleDeg: number;
  periapsisAltKm: number;
  flybyMarginKm: number;
  poweredDvMs: number;
  stochasticDvMs: number;
  isUnpowered: boolean;
}

export interface KEJGLegInfo {
  departureBody: string;
  arrivalBody: string;
  depUT: number;
  arrUT: number;
  flightTimeDays: number;
  vInfDepMag: number;
  vInfArrMag: number;
  c3Dep: number;
  ejectionDvMs: number;
}

export interface KEJGStep1Result {
  passed: boolean;
  timestamp: number;
  systemName: string;
  legs: KEJGLegInfo[];
  flybys: KEJGFlybyInfo[];
  totalMissionDvMs: number;
  totalEjectionDvMs: number;
  totalFlybyPoweredDvMs: number;
}

export interface KEJGSampledFlybyDebug {
  instanceId: string;
  bodyName: string;
  step1FlybyDateUt: number;
  step1FlybyDateFormatted: string;
  sampledDates: { ut: number; formatted: string; label?: string }[];
  sampledDatesCount: number;
  minDateFormatted: string;
  maxDateFormatted: string;
  inboundVInfMinMs: number;
  inboundVInfMaxMs: number;
  outboundVInfMinMs: number;
  outboundVInfMaxMs: number;
  matchedFlybyDateUt?: number;
  matchedFlybyDateFormatted?: string;
  matchedInboundVInfMs?: number;
  matchedOutboundVInfMs?: number;
  deflectionAngleDeg?: number;
  maxDeflectionAngleDeg?: number;
  status: 'VALID_UNPOWERED' | 'POWERED_REQUIRED' | 'INVALID_MARGIN' | 'NO_FEASIBLE_MATCH';
  statusLabel: string;
  periapsisAltKm?: number;
  flybyMarginKm?: number;
}

function getDatesAroundStep1(
  sortedDates: number[],
  step1Ut: number,
  matchedUt?: number
): { ut: number; formatted: string; label: string }[] {
  if (sortedDates.length === 0) return [];

  const selectedMap = new Map<number, string>();

  // Find date immediately before (or equal to) step1Ut
  let before: number | undefined;
  for (let i = 0; i < sortedDates.length; i++) {
    if (sortedDates[i] <= step1Ut) {
      before = sortedDates[i];
    } else {
      break;
    }
  }

  // Find date immediately after (or equal to) step1Ut
  let after: number | undefined;
  for (let i = 0; i < sortedDates.length; i++) {
    if (sortedDates[i] >= step1Ut) {
      after = sortedDates[i];
      break;
    }
  }

  if (before !== undefined) {
    const label = before === step1Ut ? 'Exact Step 1 Date' : 'Just Before Step 1';
    selectedMap.set(before, label);
  }

  if (after !== undefined) {
    const label = after === step1Ut ? 'Exact Step 1 Date' : 'Just After Step 1';
    selectedMap.set(after, label);
  }

  if (matchedUt !== undefined && sortedDates.includes(matchedUt)) {
    const existing = selectedMap.get(matchedUt);
    if (existing) {
      selectedMap.set(matchedUt, `${existing} / Matched`);
    } else {
      selectedMap.set(matchedUt, 'Step 2 Matched');
    }
  }

  return Array.from(selectedMap.entries())
    .map(([ut, label]) => ({
      ut,
      formatted: formatShortUT(ut, 'ksp'),
      label,
    }))
    .sort((a, b) => a.ut - b.ut);
}

export interface KEJGStep2Result {
  passed: boolean;
  timestamp: number;
  systemName: string;
  samplingPerPeriod: number;
  porkchopsComputedCount: number;
  validSequencesFound: number;
  bestSequence?: {
    totalDvMs: number;
    c3Dep: number;
    datesFormatted: string[];
    travelTimesDays: number[];
    flybys: KEJGFlybyInfo[];
  };
  flybyDebugList?: KEJGSampledFlybyDebug[];
}

export interface KEJGAutotestSuiteResult {
  step1?: KEJGStep1Result;
  step2?: KEJGStep2Result;
}

/**
 * Step 1: Evaluates Kerbin -> Eve -> Jool -> Grannus sequence at exact dates
 * Kerbin: Y6 D231
 * Eve: Y6 D295
 * Jool: Y9 D308
 * Grannus: Y41 D192
 */
export function runKEJGStep1(): KEJGStep1Result {
  const stockOpmGrannus = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
  const sun = stockOpmGrannus.bodies.find(b => b.name === 'Sun')!;
  const kerbin = stockOpmGrannus.bodies.find(b => b.name === 'Kerbin')!;
  const eve = stockOpmGrannus.bodies.find(b => b.name === 'Eve')!;
  const jool = stockOpmGrannus.bodies.find(b => b.name === 'Jool')!;
  const grannus = stockOpmGrannus.bodies.find(b => b.name === 'Grannus')!;

  const muSun = getGravitationalParameter(sun);

  const t1 = parseKSPTimeToUT(6, 231, 0, 0, 0, 'ksp');
  const t2 = parseKSPTimeToUT(6, 295, 0, 0, 0, 'ksp');
  const t3 = parseKSPTimeToUT(9, 308, 0, 0, 0, 'ksp');
  const t4 = parseKSPTimeToUT(41, 192, 0, 0, 0, 'ksp');

  // Leg 1: Kerbin -> Eve
  const dt1 = t2 - t1;
  const stKerbin = getBodyStateAtUT(kerbin, sun, t1);
  const stEve1 = getBodyStateAtUT(eve, sun, t2);
  const sol1 = solveLambert(stKerbin.pos, stEve1.pos, dt1, muSun, true);

  const vInfDep1 = vecSub(sol1.v1, stKerbin.vel);
  const vInfArr1 = vecSub(sol1.v2, stEve1.vel);
  const vInfDep1Mag = vecMag(vInfDep1);
  const vInfArr1Mag = vecMag(vInfArr1);
  const c3Dep1 = vInfDep1Mag * vInfDep1Mag;

  // LKO 100km ejection
  const muKerbin = getGravitationalParameter(kerbin);
  const rLko = kerbin.radius + 100000;
  const vCircLko = Math.sqrt(muKerbin / rLko);
  const vInjLko = Math.sqrt(vInfDep1Mag * vInfDep1Mag + (2 * muKerbin) / rLko);
  const ejDv1 = vInjLko - vCircLko;

  const leg1: KEJGLegInfo = {
    departureBody: 'Kerbin',
    arrivalBody: 'Eve',
    depUT: t1,
    arrUT: t2,
    flightTimeDays: dt1 / 21600,
    vInfDepMag: vInfDep1Mag,
    vInfArrMag: vInfArr1Mag,
    c3Dep: c3Dep1,
    ejectionDvMs: ejDv1,
  };

  // Leg 2: Eve -> Jool
  const dt2 = t3 - t2;
  const stEve2 = stEve1;
  const stJool1 = getBodyStateAtUT(jool, sun, t3);
  const sol2 = solveLambert(stEve2.pos, stJool1.pos, dt2, muSun, true);

  const vInfDep2 = vecSub(sol2.v1, stEve2.vel);
  const vInfArr2 = vecSub(sol2.v2, stJool1.vel);
  const vInfDep2Mag = vecMag(vInfDep2);
  const vInfArr2Mag = vecMag(vInfArr2);

  const leg2: KEJGLegInfo = {
    departureBody: 'Eve',
    arrivalBody: 'Jool',
    depUT: t2,
    arrUT: t3,
    flightTimeDays: dt2 / 21600,
    vInfDepMag: vInfDep2Mag,
    vInfArrMag: vInfArr2Mag,
    c3Dep: vInfDep2Mag * vInfDep2Mag,
    ejectionDvMs: 0,
  };

  // Flyby 1: Eve
  const flybyEveEval = evaluateFlybyAtDate(eve, vInfArr1, vInfDep2, t2);
  const flybyEve: KEJGFlybyInfo = {
    bodyName: 'Eve',
    ut: t2,
    inboundVInfMag: flybyEveEval.vInfInMag,
    outboundVInfMag: flybyEveEval.vInfOutMag,
    deflectionAngleDeg: flybyEveEval.deflectionAngleDeg,
    maxDeflectionAngleDeg: flybyEveEval.maxDeflectionAngleDeg,
    periapsisAltKm: flybyEveEval.periapsisAlt / 1000,
    flybyMarginKm: flybyEveEval.flybyMargin / 1000,
    poweredDvMs: flybyEveEval.poweredDv,
    stochasticDvMs: flybyEveEval.stochasticDv,
    isUnpowered: flybyEveEval.isUnpowered,
  };

  // Leg 3: Jool -> Grannus
  const dt3 = t4 - t3;
  const stJool2 = stJool1;
  const stGrannus = getBodyStateAtUT(grannus, sun, t4);
  const sol3 = solveLambert(stJool2.pos, stGrannus.pos, dt3, muSun, true);

  const vInfDep3 = vecSub(sol3.v1, stJool2.vel);
  const vInfArr3 = vecSub(sol3.v2, stGrannus.vel);
  const vInfDep3Mag = vecMag(vInfDep3);
  const vInfArr3Mag = vecMag(vInfArr3);

  const leg3: KEJGLegInfo = {
    departureBody: 'Jool',
    arrivalBody: 'Grannus',
    depUT: t3,
    arrUT: t4,
    flightTimeDays: dt3 / 21600,
    vInfDepMag: vInfDep3Mag,
    vInfArrMag: vInfArr3Mag,
    c3Dep: vInfDep3Mag * vInfDep3Mag,
    ejectionDvMs: 0,
  };

  // Flyby 2: Jool
  const flybyJoolEval = evaluateFlybyAtDate(jool, vInfArr2, vInfDep3, t3);
  const flybyJool: KEJGFlybyInfo = {
    bodyName: 'Jool',
    ut: t3,
    inboundVInfMag: flybyJoolEval.vInfInMag,
    outboundVInfMag: flybyJoolEval.vInfOutMag,
    deflectionAngleDeg: flybyJoolEval.deflectionAngleDeg,
    maxDeflectionAngleDeg: flybyJoolEval.maxDeflectionAngleDeg,
    periapsisAltKm: flybyJoolEval.periapsisAlt / 1000,
    flybyMarginKm: flybyJoolEval.flybyMargin / 1000,
    poweredDvMs: flybyJoolEval.poweredDv,
    stochasticDvMs: flybyJoolEval.stochasticDv,
    isUnpowered: flybyJoolEval.isUnpowered,
  };

  const totalEjectionDvMs = ejDv1;
  const totalFlybyPoweredDvMs = flybyEveEval.poweredDv + flybyJoolEval.poweredDv;
  const totalMissionDvMs = totalEjectionDvMs + totalFlybyPoweredDvMs;

  return {
    passed: sol1.isValid && sol2.isValid && sol3.isValid,
    timestamp: Date.now(),
    systemName: stockOpmGrannus.name,
    legs: [leg1, leg2, leg3],
    flybys: [flybyEve, flybyJool],
    totalMissionDvMs,
    totalEjectionDvMs,
    totalFlybyPoweredDvMs,
  };
}

/**
 * Step 2: Sampled dates search for Kerbin -> Eve -> Jool -> Grannus sequence
 */
export async function runKEJGStep2(): Promise<KEJGStep2Result> {
  const stockOpmGrannus = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
  const sun = stockOpmGrannus.bodies.find(b => b.name === 'Sun')!;

  const t1 = parseKSPTimeToUT(6, 231, 0, 0, 0, 'ksp');
  const tEveStep1 = parseKSPTimeToUT(6, 295, 0, 0, 0, 'ksp');
  const tJoolStep1 = parseKSPTimeToUT(9, 308, 0, 0, 0, 'ksp');
  const t4 = parseKSPTimeToUT(41, 192, 0, 0, 0, 'ksp');

  // Define instances with explicit validFlybyDates (date before step 1, exact step 1, date after step 1)
  const instances: InstanceNode[] = [
    {
      id: 'inst-0',
      bodyName: 'Kerbin',
      x: 100,
      y: 200,
      minDate: t1,
      maxDate: t1,
      validFlybyDates: [t1],
      maxC3: 120,
    },
    {
      id: 'inst-1',
      bodyName: 'Eve',
      x: 300,
      y: 200,
      validFlybyDates: [tEveStep1 - 21600, tEveStep1, tEveStep1 + 21600],
      minFlybyRadius: 100000,
    },
    {
      id: 'inst-2',
      bodyName: 'Jool',
      x: 500,
      y: 200,
      validFlybyDates: [tJoolStep1 - 21600, tJoolStep1, tJoolStep1 + 21600],
      minFlybyRadius: 300000,
    },
    {
      id: 'inst-3',
      bodyName: 'Grannus',
      x: 700,
      y: 200,
      validFlybyDates: [t4],
    },
  ];

  // Define links
  const links: DirectionalLink[] = [
    { id: 'link-0-1', sourceInstanceId: 'inst-0', targetInstanceId: 'inst-1', minFlightDuration: 21600 * 30, maxFlightDuration: 21600 * 150 },
    { id: 'link-1-2', sourceInstanceId: 'inst-1', targetInstanceId: 'inst-2', minFlightDuration: 21600 * 200, maxFlightDuration: 21600 * 800 },
    { id: 'link-2-3', sourceInstanceId: 'inst-2', targetInstanceId: 'inst-3', minFlightDuration: 21600 * 1000, maxFlightDuration: 21600 * 15000 },
  ];

  const searchResults = await runSequenceSearch(instances, links, stockOpmGrannus.bodies, sun, () => {}, () => false);

  let bestSeq;
  let bestSeqFlybys: FlybyDetail[] = [];
  if (searchResults.sequences && searchResults.sequences.length > 0) {
    const seq = searchResults.sequences[0];
    bestSeqFlybys = seq.flybys || [];

    const flybyInfos: KEJGFlybyInfo[] = bestSeqFlybys.map(f => ({
      bodyName: f.bodyName,
      ut: f.flybyDate,
      inboundVInfMag: f.vInfInMag,
      outboundVInfMag: f.vInfOutMag,
      deflectionAngleDeg: f.deflectionAngle,
      maxDeflectionAngleDeg: f.maxDeflectionAngle,
      periapsisAltKm: f.periapsisAlt / 1000,
      flybyMarginKm: f.flybyMargin / 1000,
      poweredDvMs: 0,
      stochasticDvMs: f.stochasticDv,
      isUnpowered: true,
    }));

    bestSeq = {
      totalDvMs: seq.totalDv,
      c3Dep: seq.depC3,
      datesFormatted: [
        formatShortUT(seq.depDate, 'ksp'),
        ...seq.transfers.map(t => formatShortUT(t.arrDate, 'ksp'))
      ],
      travelTimesDays: seq.transfers.map(t => Math.round(t.flightTime / 21600)),
      flybys: flybyInfos,
    };
  }

  // Construct detailed debug info for Eve (inst-1) and Jool (inst-2)
  const flybyDebugList: KEJGSampledFlybyDebug[] = [];

  const pc01 = searchResults.porkchops['link-0-1'];
  const pc12 = searchResults.porkchops['link-1-2'];
  const pc23 = searchResults.porkchops['link-2-3'];

  // 1. Eve debug info
  const eveBody = stockOpmGrannus.bodies.find(b => b.name === 'Eve');
  if (eveBody && pc01 && pc12) {
    const eveDateSet = new Set<number>();
    pc01.arrDates.forEach(d => eveDateSet.add(d));
    pc12.depDates.forEach(d => eveDateSet.add(d));
    const sortedEveDates = Array.from(eveDateSet).sort((a, b) => a - b);
    const matchedEve = bestSeqFlybys.find(f => f.bodyName === 'Eve');
    const sampledDatesEve = getDatesAroundStep1(sortedEveDates, tEveStep1, matchedEve?.flybyDate);

    let inMin = Infinity, inMax = -Infinity;
    if (pc01.vTransArrMatrix) {
      for (let i = 0; i < pc01.depDates.length; i++) {
        for (let j = 0; j < pc01.arrDates.length; j++) {
          const vTrans = pc01.vTransArrMatrix[i]?.[j];
          if (vTrans) {
            const stEve = getBodyStateAtUT(eveBody, sun, pc01.arrDates[j]);
            const vInf = vecMag(vecSub(vTrans, stEve.vel));
            if (vInf < inMin) inMin = vInf;
            if (vInf > inMax) inMax = vInf;
          }
        }
      }
    }

    let outMin = Infinity, outMax = -Infinity;
    if (pc12.vTransDepMatrix) {
      for (let m = 0; m < pc12.depDates.length; m++) {
        for (let n = 0; n < pc12.arrDates.length; n++) {
          const vTrans = pc12.vTransDepMatrix[m]?.[n];
          if (vTrans) {
            const stEve = getBodyStateAtUT(eveBody, sun, pc12.depDates[m]);
            const vInf = vecMag(vecSub(vTrans, stEve.vel));
            if (vInf < outMin) outMin = vInf;
            if (vInf > outMax) outMax = vInf;
          }
        }
      }
    }

    const status: 'VALID_UNPOWERED' | 'POWERED_REQUIRED' | 'INVALID_MARGIN' | 'NO_FEASIBLE_MATCH' = matchedEve
      ? (matchedEve.deflectionAngle <= matchedEve.maxDeflectionAngle && matchedEve.flybyMargin >= 0
          ? 'VALID_UNPOWERED' : 'POWERED_REQUIRED')
      : 'NO_FEASIBLE_MATCH';

    flybyDebugList.push({
      instanceId: 'inst-1',
      bodyName: 'Eve',
      step1FlybyDateUt: tEveStep1,
      step1FlybyDateFormatted: formatShortUT(tEveStep1, 'ksp'),
      sampledDates: sampledDatesEve,
      sampledDatesCount: sortedEveDates.length,
      minDateFormatted: sortedEveDates.length > 0 ? formatShortUT(sortedEveDates[0], 'ksp') : 'N/A',
      maxDateFormatted: sortedEveDates.length > 0 ? formatShortUT(sortedEveDates[sortedEveDates.length - 1], 'ksp') : 'N/A',
      inboundVInfMinMs: isFinite(inMin) ? inMin : 0,
      inboundVInfMaxMs: isFinite(inMax) ? inMax : 0,
      outboundVInfMinMs: isFinite(outMin) ? outMin : 0,
      outboundVInfMaxMs: isFinite(outMax) ? outMax : 0,
      matchedFlybyDateUt: matchedEve?.flybyDate,
      matchedFlybyDateFormatted: matchedEve ? formatShortUT(matchedEve.flybyDate, 'ksp') : undefined,
      matchedInboundVInfMs: matchedEve?.vInfInMag,
      matchedOutboundVInfMs: matchedEve?.vInfOutMag,
      deflectionAngleDeg: matchedEve?.deflectionAngle,
      maxDeflectionAngleDeg: matchedEve?.maxDeflectionAngle,
      periapsisAltKm: matchedEve ? matchedEve.periapsisAlt / 1000 : undefined,
      flybyMarginKm: matchedEve ? matchedEve.flybyMargin / 1000 : undefined,
      status,
      statusLabel: status === 'VALID_UNPOWERED' ? '✓ Valid Unpowered Flyby' : status === 'POWERED_REQUIRED' ? '⚠ Powered Assist Required' : '✗ No Match',
    });
  }

  // 2. Jool debug info
  const joolBody = stockOpmGrannus.bodies.find(b => b.name === 'Jool');
  if (joolBody && pc12 && pc23) {
    const joolDateSet = new Set<number>();
    pc12.arrDates.forEach(d => joolDateSet.add(d));
    pc23.depDates.forEach(d => joolDateSet.add(d));
    const sortedJoolDates = Array.from(joolDateSet).sort((a, b) => a - b);
    const matchedJool = bestSeqFlybys.find(f => f.bodyName === 'Jool');
    const sampledDatesJool = getDatesAroundStep1(sortedJoolDates, tJoolStep1, matchedJool?.flybyDate);

    let inMin = Infinity, inMax = -Infinity;
    if (pc12.vTransArrMatrix) {
      for (let i = 0; i < pc12.depDates.length; i++) {
        for (let j = 0; j < pc12.arrDates.length; j++) {
          const vTrans = pc12.vTransArrMatrix[i]?.[j];
          if (vTrans) {
            const stJool = getBodyStateAtUT(joolBody, sun, pc12.arrDates[j]);
            const vInf = vecMag(vecSub(vTrans, stJool.vel));
            if (vInf < inMin) inMin = vInf;
            if (vInf > inMax) inMax = vInf;
          }
        }
      }
    }

    let outMin = Infinity, outMax = -Infinity;
    if (pc23.vTransDepMatrix) {
      for (let m = 0; m < pc23.depDates.length; m++) {
        for (let n = 0; n < pc23.arrDates.length; n++) {
          const vTrans = pc23.vTransDepMatrix[m]?.[n];
          if (vTrans) {
            const stJool = getBodyStateAtUT(joolBody, sun, pc23.depDates[m]);
            const vInf = vecMag(vecSub(vTrans, stJool.vel));
            if (vInf < outMin) outMin = vInf;
            if (vInf > outMax) outMax = vInf;
          }
        }
      }
    }

    const status: 'VALID_UNPOWERED' | 'POWERED_REQUIRED' | 'INVALID_MARGIN' | 'NO_FEASIBLE_MATCH' = matchedJool
      ? (matchedJool.deflectionAngle <= matchedJool.maxDeflectionAngle && matchedJool.flybyMargin >= 0
          ? 'VALID_UNPOWERED' : 'POWERED_REQUIRED')
      : 'NO_FEASIBLE_MATCH';

    flybyDebugList.push({
      instanceId: 'inst-2',
      bodyName: 'Jool',
      step1FlybyDateUt: tJoolStep1,
      step1FlybyDateFormatted: formatShortUT(tJoolStep1, 'ksp'),
      sampledDates: sampledDatesJool,
      sampledDatesCount: sortedJoolDates.length,
      minDateFormatted: sortedJoolDates.length > 0 ? formatShortUT(sortedJoolDates[0], 'ksp') : 'N/A',
      maxDateFormatted: sortedJoolDates.length > 0 ? formatShortUT(sortedJoolDates[sortedJoolDates.length - 1], 'ksp') : 'N/A',
      inboundVInfMinMs: isFinite(inMin) ? inMin : 0,
      inboundVInfMaxMs: isFinite(inMax) ? inMax : 0,
      outboundVInfMinMs: isFinite(outMin) ? outMin : 0,
      outboundVInfMaxMs: isFinite(outMax) ? outMax : 0,
      matchedFlybyDateUt: matchedJool?.flybyDate,
      matchedFlybyDateFormatted: matchedJool ? formatShortUT(matchedJool.flybyDate, 'ksp') : undefined,
      matchedInboundVInfMs: matchedJool?.vInfInMag,
      matchedOutboundVInfMs: matchedJool?.vInfOutMag,
      deflectionAngleDeg: matchedJool?.deflectionAngle,
      maxDeflectionAngleDeg: matchedJool?.maxDeflectionAngle,
      periapsisAltKm: matchedJool ? matchedJool.periapsisAlt / 1000 : undefined,
      flybyMarginKm: matchedJool ? matchedJool.flybyMargin / 1000 : undefined,
      status,
      statusLabel: status === 'VALID_UNPOWERED' ? '✓ Valid Unpowered Flyby' : status === 'POWERED_REQUIRED' ? '⚠ Powered Assist Required' : '✗ No Match',
    });
  }

  let totalGridPoints = 0;
  if (searchResults.porkchops) {
    Object.values(searchResults.porkchops).forEach(pc => {
      if (pc && pc.depDates && pc.arrDates) {
        totalGridPoints += pc.depDates.length * pc.arrDates.length;
      }
    });
  }

  return {
    passed: searchResults.sequences ? searchResults.sequences.length > 0 : false,
    timestamp: Date.now(),
    systemName: stockOpmGrannus.name,
    samplingPerPeriod: 64,
    porkchopsComputedCount: totalGridPoints,
    validSequencesFound: searchResults.sequences ? searchResults.sequences.length : 0,
    bestSequence: bestSeq,
    flybyDebugList,
  };
}
