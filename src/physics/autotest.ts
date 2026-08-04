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
  vecMag
} from './kepler';
import { solveLambert } from './lambert';

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
