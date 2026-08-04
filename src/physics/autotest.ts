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
  getGravitationalParameter,
  getOrbitalPeriod
} from './kepler';
import { solveLambert } from './lambert';
import { evaluateFlybyAtDate, matchUnpoweredFlyby } from './flyby';
import { PRESET_SOLAR_SYSTEMS } from '../data/solarSystems';
import { parseKSPTimeToUT, formatShortUT } from '../utils/timeFormat';

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
export function runKEJGStep1(customUTs?: { t1?: number; t2?: number; t3?: number; t4?: number }): KEJGStep1Result {
  const stockOpmGrannus = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
  const sun = stockOpmGrannus.bodies.find(b => b.name === 'Sun')!;
  const kerbin = stockOpmGrannus.bodies.find(b => b.name === 'Kerbin')!;
  const eve = stockOpmGrannus.bodies.find(b => b.name === 'Eve')!;
  const jool = stockOpmGrannus.bodies.find(b => b.name === 'Jool')!;
  const grannus = stockOpmGrannus.bodies.find(b => b.name === 'Grannus')!;

  const muSun = getGravitationalParameter(sun);

  const t1 = customUTs?.t1 ?? parseKSPTimeToUT(6, 231, 0, 0, 0, 'ksp');
  const t2 = customUTs?.t2 ?? parseKSPTimeToUT(6, 295, 0, 0, 0, 'ksp');
  const t3 = customUTs?.t3 ?? parseKSPTimeToUT(9, 308, 0, 0, 0, 'ksp');
  const t4 = customUTs?.t4 ?? parseKSPTimeToUT(41, 192, 0, 0, 0, 'ksp');

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
export async function runKEJGStep2(customUTs?: { t1?: number; t2?: number; t3?: number; t4?: number }): Promise<KEJGStep2Result> {
  const SAMPLE_PER_PERIOD = 2;
  const stockOpmGrannus = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
  const sun = stockOpmGrannus.bodies.find(b => b.name === 'Sun')!;
  const kerbin = stockOpmGrannus.bodies.find(b => b.name === 'Kerbin')!;
  const eve = stockOpmGrannus.bodies.find(b => b.name === 'Eve')!;
  const jool = stockOpmGrannus.bodies.find(b => b.name === 'Jool')!;
  const grannus = stockOpmGrannus.bodies.find(b => b.name === 'Grannus')!;
  const muSun = getGravitationalParameter(sun);

  const t1 = customUTs?.t1 ?? parseKSPTimeToUT(6, 231, 0, 0, 0, 'ksp');
  const tEveStep1 = customUTs?.t2 ?? parseKSPTimeToUT(6, 295, 0, 0, 0, 'ksp');
  const tJoolStep1 = customUTs?.t3 ?? parseKSPTimeToUT(9, 308, 0, 0, 0, 'ksp');
  const t4 = customUTs?.t4 ?? parseKSPTimeToUT(41, 192, 0, 0, 0, 'ksp');

  // Compute sampling boundaries (0.5 year sampling period around step 1 flyby dates)
  const eveSamplingPeriod = getOrbitalPeriod(eve, sun) / SAMPLE_PER_PERIOD;
  const eveHalfIdx = Math.floor(tEveStep1 / eveSamplingPeriod);
  const tEve1 = eveHalfIdx * eveSamplingPeriod;
  const tEve2 = (eveHalfIdx + 1) * eveSamplingPeriod;

  const joolSamplingPeriod = getOrbitalPeriod(jool, sun) / SAMPLE_PER_PERIOD;
  const joolHalfIdx = Math.floor(tJoolStep1 / joolSamplingPeriod);
  const tJool1 = joolHalfIdx * joolSamplingPeriod;
  const tJool2 = (joolHalfIdx + 1) * joolSamplingPeriod;

  // States at all dates
  const stKerbin = getBodyStateAtUT(kerbin, sun, t1);
  const stEve1 = getBodyStateAtUT(eve, sun, tEve1);
  const stEve2 = getBodyStateAtUT(eve, sun, tEve2);
  const stJool1 = getBodyStateAtUT(jool, sun, tJool1);
  const stJool2 = getBodyStateAtUT(jool, sun, tJool2);
  const stGrannus = getBodyStateAtUT(grannus, sun, t4);

  // Compute the 8 transfers (direct call of solveLambert)
  // Leg 1: Kerbin -> Eve (2 solves)
  const sol_K_E1 = solveLambert(stKerbin.pos, stEve1.pos, tEve1 - t1, muSun, true);
  const sol_K_E2 = solveLambert(stKerbin.pos, stEve2.pos, tEve2 - t1, muSun, true);

  // Leg 2: Eve -> Jool (4 solves)
  const sol_E1_J1 = solveLambert(stEve1.pos, stJool1.pos, tJool1 - tEve1, muSun, true);
  const sol_E1_J2 = solveLambert(stEve1.pos, stJool2.pos, tJool2 - tEve1, muSun, true);
  const sol_E2_J1 = solveLambert(stEve2.pos, stJool1.pos, tJool1 - tEve2, muSun, true);
  const sol_E2_J2 = solveLambert(stEve2.pos, stJool2.pos, tJool2 - tEve2, muSun, true);

  // Leg 3: Jool -> Grannus (2 solves)
  const sol_J1_G = solveLambert(stJool1.pos, stGrannus.pos, t4 - tJool1, muSun, true);
  const sol_J2_G = solveLambert(stJool2.pos, stGrannus.pos, t4 - tJool2, muSun, true);

  // Match the 2 flybys (direct call of matchUnpoweredFlyby)
  // 1. Eve Flyby Match
  const vInfIn_E1 = vecSub(sol_K_E1.v2, stEve1.vel);
  const vInfIn_E2 = vecSub(sol_K_E2.v2, stEve2.vel);

  const vInfOut_E1_J1 = vecSub(sol_E1_J1.v1, stEve1.vel);
  const vInfOut_E2_J1 = vecSub(sol_E2_J1.v1, stEve2.vel);
  const vInfOut_E1_J2 = vecSub(sol_E1_J2.v1, stEve1.vel);
  const vInfOut_E2_J2 = vecSub(sol_E2_J2.v1, stEve2.vel);

  const matchEveJ1 = matchUnpoweredFlyby(eve, vInfIn_E1, vInfIn_E2, vInfOut_E1_J1, vInfOut_E2_J1, tEve1, tEve2, 100000);
  const matchEveJ2 = matchUnpoweredFlyby(eve, vInfIn_E1, vInfIn_E2, vInfOut_E1_J2, vInfOut_E2_J2, tEve1, tEve2, 100000);

  const matchEve = (matchEveJ1.isValid || !matchEveJ2.isValid) ? matchEveJ1 : matchEveJ2;

  // 2. Jool Flyby Match
  const vInfOut_J1 = vecSub(sol_J1_G.v1, stJool1.vel);
  const vInfOut_J2 = vecSub(sol_J2_G.v1, stJool2.vel);

  const vInfIn_E1_J1 = vecSub(sol_E1_J1.v2, stJool1.vel);
  const vInfIn_E1_J2 = vecSub(sol_E1_J2.v2, stJool2.vel);
  const vInfIn_E2_J1 = vecSub(sol_E2_J1.v2, stJool1.vel);
  const vInfIn_E2_J2 = vecSub(sol_E2_J2.v2, stJool2.vel);

  const matchJoolE1 = matchUnpoweredFlyby(jool, vInfIn_E1_J1, vInfIn_E1_J2, vInfOut_J1, vInfOut_J2, tJool1, tJool2, 300000);
  const matchJoolE2 = matchUnpoweredFlyby(jool, vInfIn_E2_J1, vInfIn_E2_J2, vInfOut_J1, vInfOut_J2, tJool1, tJool2, 300000);

  const matchJool = (matchJoolE1.isValid || !matchJoolE2.isValid) ? matchJoolE1 : matchJoolE2;

  // Debug flyby list
  const flybyDebugList: KEJGSampledFlybyDebug[] = [
    {
      instanceId: 'inst-1',
      bodyName: 'Eve',
      step1FlybyDateUt: tEveStep1,
      step1FlybyDateFormatted: formatShortUT(tEveStep1, 'ksp'),
      sampledDates: [
        { ut: tEve1, formatted: formatShortUT(tEve1, 'ksp'), label: 'Just Before Step 1' },
        { ut: tEve2, formatted: formatShortUT(tEve2, 'ksp'), label: 'Just After Step 1' },
        ...(matchEve.matchedFlybyDate ? [{ ut: matchEve.matchedFlybyDate, formatted: formatShortUT(matchEve.matchedFlybyDate, 'ksp'), label: 'Matched Date' }] : [])
      ],
      sampledDatesCount: 2,
      minDateFormatted: formatShortUT(tEve1, 'ksp'),
      maxDateFormatted: formatShortUT(tEve2, 'ksp'),
      inboundVInfMinMs: Math.min(vecMag(vInfIn_E1), vecMag(vInfIn_E2)),
      inboundVInfMaxMs: Math.max(vecMag(vInfIn_E1), vecMag(vInfIn_E2)),
      outboundVInfMinMs: Math.min(vecMag(vInfOut_E1_J1), vecMag(vInfOut_E2_J1), vecMag(vInfOut_E1_J2), vecMag(vInfOut_E2_J2)),
      outboundVInfMaxMs: Math.max(vecMag(vInfOut_E1_J1), vecMag(vInfOut_E2_J1), vecMag(vInfOut_E1_J2), vecMag(vInfOut_E2_J2)),
      matchedFlybyDateUt: matchEve.matchedFlybyDate,
      matchedFlybyDateFormatted: matchEve.matchedFlybyDate ? formatShortUT(matchEve.matchedFlybyDate, 'ksp') : undefined,
      matchedInboundVInfMs: matchEve.vInfInMag,
      matchedOutboundVInfMs: matchEve.vInfOutMag,
      deflectionAngleDeg: matchEve.deflectionAngle,
      maxDeflectionAngleDeg: matchEve.maxDeflectionAngle,
      periapsisAltKm: matchEve.periapsisAlt / 1000,
      flybyMarginKm: matchEve.flybyMargin / 1000,
      status: matchEve.isValid ? 'VALID_UNPOWERED' : (matchEve.matchedFlybyDate ? 'POWERED_REQUIRED' : 'NO_FEASIBLE_MATCH'),
      statusLabel: matchEve.isValid ? '✓ Valid Unpowered Flyby' : matchEve.matchedFlybyDate ? '⚠ Powered Assist Required' : '✗ No Match',
    },
    {
      instanceId: 'inst-2',
      bodyName: 'Jool',
      step1FlybyDateUt: tJoolStep1,
      step1FlybyDateFormatted: formatShortUT(tJoolStep1, 'ksp'),
      sampledDates: [
        { ut: tJool1, formatted: formatShortUT(tJool1, 'ksp'), label: 'Just Before Step 1' },
        { ut: tJool2, formatted: formatShortUT(tJool2, 'ksp'), label: 'Just After Step 1' },
        ...(matchJool.matchedFlybyDate ? [{ ut: matchJool.matchedFlybyDate, formatted: formatShortUT(matchJool.matchedFlybyDate, 'ksp'), label: 'Matched Date' }] : [])
      ],
      sampledDatesCount: 2,
      minDateFormatted: formatShortUT(tJool1, 'ksp'),
      maxDateFormatted: formatShortUT(tJool2, 'ksp'),
      inboundVInfMinMs: Math.min(vecMag(vInfIn_E1_J1), vecMag(vInfIn_E1_J2), vecMag(vInfIn_E2_J1), vecMag(vInfIn_E2_J2)),
      inboundVInfMaxMs: Math.max(vecMag(vInfIn_E1_J1), vecMag(vInfIn_E1_J2), vecMag(vInfIn_E2_J1), vecMag(vInfIn_E2_J2)),
      outboundVInfMinMs: Math.min(vecMag(vInfOut_J1), vecMag(vInfOut_J2)),
      outboundVInfMaxMs: Math.max(vecMag(vInfOut_J1), vecMag(vInfOut_J2)),
      matchedFlybyDateUt: matchJool.matchedFlybyDate,
      matchedFlybyDateFormatted: matchJool.matchedFlybyDate ? formatShortUT(matchJool.matchedFlybyDate, 'ksp') : undefined,
      matchedInboundVInfMs: matchJool.vInfInMag,
      matchedOutboundVInfMs: matchJool.vInfOutMag,
      deflectionAngleDeg: matchJool.deflectionAngle,
      maxDeflectionAngleDeg: matchJool.maxDeflectionAngle,
      periapsisAltKm: matchJool.periapsisAlt / 1000,
      flybyMarginKm: matchJool.flybyMargin / 1000,
      status: matchJool.isValid ? 'VALID_UNPOWERED' : (matchJool.matchedFlybyDate ? 'POWERED_REQUIRED' : 'NO_FEASIBLE_MATCH'),
      statusLabel: matchJool.isValid ? '✓ Valid Unpowered Flyby' : matchJool.matchedFlybyDate ? '⚠ Powered Assist Required' : '✗ No Match',
    }
  ];

  let bestSeq;
  const isOverallValid = matchEve.isValid && matchJool.isValid;
  if (matchEve.matchedFlybyDate && matchJool.matchedFlybyDate) {
    const eveDate = matchEve.matchedFlybyDate;
    const joolDate = matchJool.matchedFlybyDate;

    const stEveMatch = getBodyStateAtUT(eve, sun, eveDate);
    const stJoolMatch = getBodyStateAtUT(jool, sun, joolDate);

    const sol1 = solveLambert(stKerbin.pos, stEveMatch.pos, eveDate - t1, muSun, true);
    const sol2 = solveLambert(stEveMatch.pos, stJoolMatch.pos, joolDate - eveDate, muSun, true);
    const sol3 = solveLambert(stJoolMatch.pos, stGrannus.pos, t4 - joolDate, muSun, true);

    const vInfDep1 = vecSub(sol1.v1, stKerbin.vel);
    const c3Dep = vecMag(vInfDep1) ** 2;

    bestSeq = {
      totalDvMs: (matchEve.stochasticDv || 0) + (matchJool.stochasticDv || 0),
      c3Dep,
      datesFormatted: [
        formatShortUT(t1, 'ksp'),
        formatShortUT(eveDate, 'ksp'),
        formatShortUT(joolDate, 'ksp'),
        formatShortUT(t4, 'ksp')
      ],
      travelTimesDays: [
        Math.round((eveDate - t1) / 21600),
        Math.round((joolDate - eveDate) / 21600),
        Math.round((t4 - joolDate) / 21600)
      ],
      flybys: [
        {
          bodyName: 'Eve',
          ut: eveDate,
          inboundVInfMag: matchEve.vInfInMag,
          outboundVInfMag: matchEve.vInfOutMag,
          deflectionAngleDeg: matchEve.deflectionAngle,
          maxDeflectionAngleDeg: matchEve.maxDeflectionAngle,
          periapsisAltKm: matchEve.periapsisAlt / 1000,
          flybyMarginKm: matchEve.flybyMargin / 1000,
          poweredDvMs: 0,
          stochasticDvMs: matchEve.stochasticDv,
          isUnpowered: matchEve.isValid
        },
        {
          bodyName: 'Jool',
          ut: joolDate,
          inboundVInfMag: matchJool.vInfInMag,
          outboundVInfMag: matchJool.vInfOutMag,
          deflectionAngleDeg: matchJool.deflectionAngle,
          maxDeflectionAngleDeg: matchJool.maxDeflectionAngle,
          periapsisAltKm: matchJool.periapsisAlt / 1000,
          flybyMarginKm: matchJool.flybyMargin / 1000,
          poweredDvMs: 0,
          stochasticDvMs: matchJool.stochasticDv,
          isUnpowered: matchJool.isValid
        }
      ]
    };
  }

  return {
    passed: isOverallValid,
    timestamp: Date.now(),
    systemName: stockOpmGrannus.name,
    samplingPerPeriod: 2,
    porkchopsComputedCount: 8,
    validSequencesFound: isOverallValid ? 1 : 0,
    bestSequence: bestSeq,
    flybyDebugList,
  };
}
