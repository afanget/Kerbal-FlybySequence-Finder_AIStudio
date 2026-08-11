/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Vector3D, vecMag, vecDot, vecCross, vecScale, vecSub, vecAdd } from './kepler';

export interface LambertSolution {
  v1: Vector3D; // Departure velocity vector in m/s
  v2: Vector3D; // Arrival velocity vector in m/s
  semiMajorAxis: number;
  isValid: boolean;
}

/**
 * Universal Variable / Izzo Lambert Solver
 * Solves Lambert's Problem for boundary positions r1, r2 and transfer duration dt in field mu.
 * @param r1 Position vector at departure (meters)
 * @param r2 Position vector at arrival (meters)
 * @param dt Flight time (seconds)
 * @param mu Standard gravitational parameter of central body (m^3 / s^2)
 * @param prograde True for prograde (< 180 deg) transfer, false for retrograde
 */
export function solveLambert(
  r1: Vector3D,
  r2: Vector3D,
  dt: number,
  mu: number,
  prograde: boolean = true,
  minRadius?: number
): LambertSolution {
  const r1Mag = vecMag(r1);
  const r2Mag = vecMag(r2);

  if (r1Mag === 0 || r2Mag === 0 || dt <= 0 || mu <= 0) {
    return { v1: { x: 0, y: 0, z: 0 }, v2: { x: 0, y: 0, z: 0 }, semiMajorAxis: 0, isValid: false };
  }

  // Cross product to find orbital plane normal
  const cross12 = vecCross(r1, r2);
  const cosTrueAnomaly = vecDot(r1, r2) / (r1Mag * r2Mag);
  const clampedCos = Math.max(-1, Math.min(1, cosTrueAnomaly));

  let dTheta = Math.acos(clampedCos);

  // Determine direction
  if (prograde) {
    if (cross12.z < 0) {
      dTheta = 2 * Math.PI - dTheta;
    }
  } else {
    if (cross12.z >= 0) {
      dTheta = 2 * Math.PI - dTheta;
    }
  }

  // Chord length c
  const c = Math.sqrt(r1Mag * r1Mag + r2Mag * r2Mag - 2 * r1Mag * r2Mag * Math.cos(dTheta));
  const s = (r1Mag + r2Mag + c) / 2; // Semi-perimeter

  const lambdaSq = 1 - c / s;
  const lambda = Math.sqrt(Math.max(0, lambdaSq)) * (dTheta > Math.PI ? -1 : 1);

  // Solves for x = sqrt(1 - s/a) using bisection / secant method
  // Normalized time parameter T
  const T = Math.sqrt((2 * mu) / (s * s * s)) * dt;

  const x = solveLambertX(lambda, T);
  return constructLambertSolutionFromX(x, r1, r2, r1Mag, r2Mag, c, s, lambda, dTheta, mu, minRadius);
}

/**
 * Solves Lambert's Problem for all valid revolution counts (Nrev = 0, 1, 2, ... up to maxRev).
 */
export function solveLambertAllRevolutions(
  r1: Vector3D,
  r2: Vector3D,
  dt: number,
  mu: number,
  prograde: boolean = true,
  minRadius?: number,
  maxRev: number = 2
): LambertSolution[] {
  const solutions: LambertSolution[] = [];

  // Nrev = 0 solution
  const sol0 = solveLambert(r1, r2, dt, mu, prograde, minRadius);
  if (sol0.isValid) {
    solutions.push(sol0);
  }

  if (maxRev <= 0) return solutions;

  const r1Mag = vecMag(r1);
  const r2Mag = vecMag(r2);
  if (r1Mag === 0 || r2Mag === 0 || dt <= 0 || mu <= 0) return solutions;

  const cross12 = vecCross(r1, r2);
  const cosTrueAnomaly = vecDot(r1, r2) / (r1Mag * r2Mag);
  const clampedCos = Math.max(-1, Math.min(1, cosTrueAnomaly));

  let dTheta = Math.acos(clampedCos);
  if (prograde) {
    if (cross12.z < 0) dTheta = 2 * Math.PI - dTheta;
  } else {
    if (cross12.z >= 0) dTheta = 2 * Math.PI - dTheta;
  }

  const c = Math.sqrt(r1Mag * r1Mag + r2Mag * r2Mag - 2 * r1Mag * r2Mag * Math.cos(dTheta));
  const s = (r1Mag + r2Mag + c) / 2;
  const lambdaSq = 1 - c / s;
  const lambda = Math.sqrt(Math.max(0, lambdaSq)) * (dTheta > Math.PI ? -1 : 1);
  const Ttarget = Math.sqrt((2 * mu) / (s * s * s)) * dt;

  for (let Nrev = 1; Nrev <= maxRev; Nrev++) {
    const { xMin, Tmin } = findMinXForRev(lambda, Nrev);
    if (Ttarget < Tmin) {
      // No solution exists for this or higher revolution counts
      break;
    }

    // Left branch solution
    const x1 = solveBranch(-0.99999, xMin, Ttarget, lambda, Nrev);
    const sol1 = constructLambertSolutionFromX(x1, r1, r2, r1Mag, r2Mag, c, s, lambda, dTheta, mu, minRadius);
    if (sol1.isValid) {
      solutions.push(sol1);
    }

    // Right branch solution
    if (Math.abs(Ttarget - Tmin) > 1e-5) {
      const x2 = solveBranch(xMin, 0.99999, Ttarget, lambda, Nrev);
      const sol2 = constructLambertSolutionFromX(x2, r1, r2, r1Mag, r2Mag, c, s, lambda, dTheta, mu, minRadius);
      if (sol2.isValid) {
        solutions.push(sol2);
      }
    }
  }

  return solutions;
}

/**
 * Solves Lambert's Problem considering multi-revolution solutions and selects the best valid solution
 * minimizing total delta-V relative to optional reference velocity vectors.
 */
export function solveLambertBest(
  r1: Vector3D,
  r2: Vector3D,
  dt: number,
  mu: number,
  prograde: boolean = true,
  minRadius?: number,
  vDepRef?: Vector3D,
  vArrRef?: Vector3D,
  maxRev: number = 2
): LambertSolution {
  const allSols = solveLambertAllRevolutions(r1, r2, dt, mu, prograde, minRadius, maxRev);
  if (allSols.length === 0) {
    return { v1: { x: 0, y: 0, z: 0 }, v2: { x: 0, y: 0, z: 0 }, semiMajorAxis: 0, isValid: false };
  }

  let bestSol = allSols[0];
  let minDv = Infinity;

  for (const sol of allSols) {
    let dv: number;
    if (vDepRef && vArrRef) {
      dv = vecMag(vecSub(sol.v1, vDepRef)) + vecMag(vecSub(sol.v2, vArrRef));
    } else if (vDepRef) {
      dv = vecMag(vecSub(sol.v1, vDepRef));
    } else {
      dv = vecMag(sol.v1) + vecMag(sol.v2);
    }
    if (dv < minDv) {
      minDv = dv;
      bestSol = sol;
    }
  }

  return bestSol;
}

function constructLambertSolutionFromX(
  x: number,
  r1: Vector3D,
  r2: Vector3D,
  r1Mag: number,
  r2Mag: number,
  c: number,
  s: number,
  lambda: number,
  dTheta: number,
  mu: number,
  minRadius?: number
): LambertSolution {
  if (isNaN(x)) {
    return { v1: { x: 0, y: 0, z: 0 }, v2: { x: 0, y: 0, z: 0 }, semiMajorAxis: 0, isValid: false };
  }

  const a = s / (2 * (1 - x * x));

  // Compute f, g Lagrange coefficients
  const y = Math.sqrt(Math.max(0, 1 - lambda * lambda * (1 - x * x)));
  const gamma = Math.sqrt((mu * s) / 2);
  const rho = (r1Mag - r2Mag) / c;
  const sigma = Math.sqrt(Math.max(0, 1 - rho * rho));

  const vr1 = (gamma * (lambda * y - x) - gamma * rho * (lambda * y + x)) / r1Mag;
  const vr2 = -(gamma * (lambda * y - x) + gamma * rho * (lambda * y + x)) / r2Mag;
  const vt1 = (gamma * sigma * (y + lambda * x)) / r1Mag;
  const vt2 = (gamma * sigma * (y + lambda * x)) / r2Mag;

  // Unit vectors
  const iR1 = vecScale(r1, 1 / r1Mag);
  const iR2 = vecScale(r2, 1 / r2Mag);

  let iN = vecCross(iR1, iR2);
  const iNMag = vecMag(iN);
  if (iNMag === 0) {
    iN = { x: 0, y: 0, z: 1 };
  } else {
    iN = vecScale(iN, 1 / iNMag);
  }

  if (dTheta > Math.PI) {
    iN = vecScale(iN, -1);
  }

  const iT1 = vecCross(iN, iR1);
  const iT2 = vecCross(iN, iR2);

  const v1 = vecAdd(vecScale(iR1, vr1), vecScale(iT1, vt1));
  const v2 = vecAdd(vecScale(iR2, vr2), vecScale(iT2, vt2));

  let isValid = !isNaN(v1.x) && !isNaN(v2.x) && vecMag(v1) > 0;

  if (isValid && minRadius !== undefined && minRadius > 0) {
    if (r1Mag < minRadius || r2Mag < minRadius) {
      isValid = false;
    } else {
      const v1Mag = vecMag(v1);
      const hVec = vecCross(r1, v1);
      const h = vecMag(hVec);
      if (h === 0) {
        isValid = false;
      } else {
        const energy = (v1Mag * v1Mag) / 2 - mu / r1Mag;
        const eSq = Math.max(0, 1 + (2 * energy * h * h) / (mu * mu));
        const e = Math.sqrt(eSq);
        const p = (h * h) / mu;
        const rp = p / (1 + e);

        if (rp < minRadius) {
          const radialV1 = vecDot(r1, v1) / r1Mag;
          const radialV2 = vecDot(r2, v2) / r2Mag;
          if (radialV1 < 0 || radialV2 > 0 || dTheta > Math.PI - 1e-4) {
            isValid = false;
          }
        }
      }
    }
  }

  return {
    v1,
    v2,
    semiMajorAxis: a,
    isValid
  };
}

function computeLambertTimeMultiRev(x: number, lambda: number, Nrev: number): number {
  if (Nrev === 0) {
    return computeLambertTime(x, lambda);
  }
  const clampedX = Math.max(-0.999999, Math.min(0.999999, x));
  const a = 1 / (1 - clampedX * clampedX);
  const alpha = 2 * Math.acos(clampedX);
  const argBeta = Math.max(-1, Math.min(1, lambda * Math.sqrt(Math.max(0, 1 - clampedX * clampedX))));
  const beta = 2 * Math.asin(argBeta);
  return (a * Math.sqrt(a) * (alpha - Math.sin(alpha) - (beta - Math.sin(beta)) + 2 * Math.PI * Nrev)) / 2;
}

function findMinXForRev(lambda: number, Nrev: number): { xMin: number; Tmin: number } {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = -0.9999;
  let b = 0.9999;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = computeLambertTimeMultiRev(c, lambda, Nrev);
  let fd = computeLambertTimeMultiRev(d, lambda, Nrev);

  for (let i = 0; i < 30; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - phi * (b - a);
      fc = computeLambertTimeMultiRev(c, lambda, Nrev);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + phi * (b - a);
      fd = computeLambertTimeMultiRev(d, lambda, Nrev);
    }
  }

  const xMin = 0.5 * (a + b);
  const Tmin = computeLambertTimeMultiRev(xMin, lambda, Nrev);
  return { xMin, Tmin };
}

function solveBranch(a: number, b: number, Ttarget: number, lambda: number, Nrev: number): number {
  let xA = a;
  let xB = b;
  let fA = computeLambertTimeMultiRev(xA, lambda, Nrev) - Ttarget;
  let fB = computeLambertTimeMultiRev(xB, lambda, Nrev) - Ttarget;

  if (fA * fB > 0) return xB;

  let xMid = 0.5 * (xA + xB);
  for (let i = 0; i < 30; i++) {
    xMid = 0.5 * (xA + xB);
    const fMid = computeLambertTimeMultiRev(xMid, lambda, Nrev) - Ttarget;
    if (Math.abs(fMid) < 1e-7 || Math.abs(xB - xA) < 1e-8) break;
    if (fA * fMid <= 0) {
      xB = xMid;
      fB = fMid;
    } else {
      xA = xMid;
      fA = fMid;
    }
  }
  return xMid;
}

/**
 * Solves normalized Lambert x parameter equation T(x) = T_target
 */
function solveLambertX(lambda: number, T: number): number {
  if (T <= 0 || isNaN(T)) return 0;

  let xMin = -0.999999;
  let xMax = 10;
  let bracketCount = 0;

  // Ensure xMax bracket has T(xMax) <= T
  while (computeLambertTime(xMax, lambda) > T && xMax < 1e6 && bracketCount < 25) {
    xMax *= 2;
    bracketCount++;
  }

  const T_parabolic = (1 - Math.pow(lambda, 3)) / 3;
  let x = T < T_parabolic ? 1.5 : 0.0;

  for (let iter = 0; iter < 30; iter++) {
    const tVal = computeLambertTime(x, lambda);
    const err = tVal - T;

    if (Math.abs(err) < 1e-7) {
      return x;
    }

    if (tVal > T) {
      xMin = Math.max(xMin, x);
    } else {
      xMax = Math.min(xMax, x);
    }

    const dx = Math.max(1e-5, Math.abs(x) * 1e-5);
    const tValPlus = computeLambertTime(x + dx, lambda);
    const dt_dx = (tValPlus - tVal) / dx;

    let nextX = x;
    if (Math.abs(dt_dx) > 1e-12) {
      nextX = x - err / dt_dx;
    }

    if (nextX <= xMin || nextX >= xMax || isNaN(nextX)) {
      nextX = 0.5 * (xMin + xMax);
    }

    if (Math.abs(nextX - x) < 1e-9) {
      return nextX;
    }

    x = nextX;
  }
  return x;
}

function computeLambertTime(x: number, lambda: number): number {
  if (Math.abs(x - 1) < 1e-6) {
    return (1 - Math.pow(lambda, 3)) / 3;
  }
  const a = 1 / (1 - x * x);
  if (x < 1) {
    // Elliptic
    const alpha = 2 * Math.acos(Math.max(-1, Math.min(1, x)));
    const beta = 2 * Math.asin(Math.max(-1, Math.min(1, lambda * Math.sqrt(1 / a))));
    return (a * Math.sqrt(a) * (alpha - Math.sin(alpha) - (beta - Math.sin(beta)))) / 2;
  } else {
    // Hyperbolic
    const alpha = 2 * Math.acosh(x);
    const beta = 2 * Math.asinh(lambda * Math.sqrt(x * x - 1));
    return (-a * Math.sqrt(-a) * (Math.sinh(alpha) - alpha - (Math.sinh(beta) - beta))) / 2;
  }
}
