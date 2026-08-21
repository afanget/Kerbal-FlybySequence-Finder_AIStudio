/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CelestialBody, OrbitalBody, Vector3D } from '../types';

export interface StateVector {
  pos: Vector3D; // position in meters
  vel: Vector3D; // velocity in m/s
}

/**
 * Solves Kepler's equation for Eccentric Anomaly E given Mean Anomaly M and Eccentricity e.
 * M = E - e * sin(E)
 */
export function solveKeplerEquation(M: number, e: number): number {
  // Normalize M to [0, 2*pi)
  let m = M % (2 * Math.PI);
  if (m < 0) m += 2 * Math.PI;

  const eClamped = Math.min(0.999999, Math.max(0, e));

  // Initial guess
  let E = eClamped < 0.8 ? m : m + 0.85 * eClamped * Math.sign(Math.sin(m) || 1);

  // Newton-Raphson iteration
  for (let iter = 0; iter < 50; iter++) {
    const f = E - eClamped * Math.sin(E) - m;
    const fPrime = 1 - eClamped * Math.cos(E);
    if (Math.abs(fPrime) < 1e-12) break;
    let delta = f / fPrime;
    if (delta > 1) delta = 1;
    if (delta < -1) delta = -1;
    E -= delta;
    if (Math.abs(delta) < 1e-12) {
      break;
    }
  }

  return E;
}

/**
 * Solves Hyperbolic Kepler's equation for Hyperbolic Anomaly H given Mean Anomaly M and Eccentricity e > 1.
 * M = e * sinh(H) - H
 */
export function solveHyperbolicKeplerEquation(M: number, e: number): number {
  const effE = Math.max(1 + 1e-7, e);
  let H = M / (effE - 1);
  if (Math.abs(H) > 10) {
    H = Math.sign(M || 1) * Math.log((2 * Math.abs(M)) / effE + 1.8);
  }

  for (let iter = 0; iter < 50; iter++) {
    const f = effE * Math.sinh(H) - H - M;
    const fPrime = effE * Math.cosh(H) - 1;
    if (Math.abs(fPrime) < 1e-12) break;
    const delta = f / fPrime;
    H -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return H;
}

/**
 * Converts a CelestialBody definition into OrbitalElements
 */
export function bodyToOrbitalElements(body: OrbitalBody): OrbitalElements {
  return {
    semiMajorAxis: body.semiMajorAxis,
    eccentricity: body.eccentricity,
    inclination: (body.inclination * Math.PI) / 180,
    ascNodeLongitude: (body.ascNodeLongitude * Math.PI) / 180,
    argOfPeriapsis: (body.argOfPeriapsis * Math.PI) / 180,
    meanAnomalyEpoch: body.meanAnomalyEpoch,
    trueAnomalyEpoch: 0, // TODO
    epoch: body.epoch
  };
}

/**
 * Calculates 3D position and velocity state vector at time t from orbital elements and central mu.
 */
export function getStateFromOrbitalElements(
  elements: OrbitalElements,
  mu: number,
  t: number
): StateVector {
  const {
    semiMajorAxis: a,
    eccentricity: e,
    inclination: iRad,
    ascNodeLongitude: ascNodeRad,
    argOfPeriapsis: argPeriRad,
    meanAnomalyEpoch: M0,
    epoch
  } = elements;

  if (mu <= 0 || Math.abs(a) < 1e-6) {
    return { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
  }

  // Determine Perifocal Basis Vectors P and Q
  let P: Vector3D;
  let Q: Vector3D;

  if (elements.pVec && elements.qVec) {
    P = elements.pVec;
    Q = elements.qVec;
  } else {
    const cosNode = Math.cos(ascNodeRad);
    const sinNode = Math.sin(ascNodeRad);
    const cosInc = Math.cos(iRad);
    const sinInc = Math.sin(iRad);
    const cosArg = Math.cos(argPeriRad);
    const sinArg = Math.sin(argPeriRad);

    P = {
      x: cosNode * cosArg - sinNode * sinArg * cosInc,
      y: sinNode * cosArg + cosNode * sinArg * cosInc,
      z: sinArg * sinInc
    };

    Q = {
      x: -cosNode * sinArg - sinNode * cosArg * cosInc,
      y: -sinNode * sinArg + cosNode * cosArg * cosInc,
      z: cosArg * sinInc
    };
  }

  const dt = t - epoch;
  let xOrb = 0;
  let yOrb = 0;
  let vxOrb = 0;
  let vyOrb = 0;

  if (e < 0.99999) {
    // Elliptic orbit
    const absA = Math.abs(a);
    const n = Math.sqrt(mu / Math.pow(absA, 3));
    const M = M0 + n * dt;
    const E = solveKeplerEquation(M, e);

    xOrb = absA * (Math.cos(E) - e);
    yOrb = absA * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);

    const r = absA * (1 - e * Math.cos(E));
    const factor = Math.sqrt(mu * absA) / Math.max(1e-12, r);
    vxOrb = -factor * Math.sin(E);
    vyOrb = factor * Math.sqrt(Math.max(0, 1 - e * e)) * Math.cos(E);
  } else {
    // Hyperbolic or Parabolic orbit
    const effE = Math.max(1 + 1e-7, e);
    const absA = Math.abs(a);
    const n = Math.sqrt(mu / Math.pow(absA, 3));
    const M = M0 + n * dt;
    const H = solveHyperbolicKeplerEquation(M, effE);

    xOrb = absA * (effE - Math.cosh(H));
    yOrb = absA * Math.sqrt(Math.max(1e-12, effE * effE - 1)) * Math.sinh(H);

    const r = absA * (effE * Math.cosh(H) - 1);
    const factor = Math.sqrt(mu * absA) / Math.max(1e-12, r);
    vxOrb = -factor * Math.sinh(H);
    vyOrb = factor * Math.sqrt(Math.max(1e-12, effE * effE - 1)) * Math.cosh(H);
  }

  return {
    pos: {
      x: xOrb * P.x + yOrb * Q.x,
      y: xOrb * P.y + yOrb * Q.y,
      z: xOrb * P.z + yOrb * Q.z
    },
    vel: {
      x: vxOrb * P.x + vyOrb * Q.x,
      y: vxOrb * P.y + vyOrb * Q.y,
      z: vxOrb * P.z + vyOrb * Q.z
    }
  };
}

/**
 * Computes 3D position and velocity vectors of a body at given Universal Time (t).
 * Position is relative to parent central body in meters; velocity is in m/s.
 */
export function getBodyStateAtUT(body: OrbitalBody, mainBody: CelestialBody, ut: number): StateVector {
  const elements = bodyToOrbitalElements(body);
  return getStateFromOrbitalElements(elements, mainBody.stdGravParam, ut);
}

/**
 * Orbital period in seconds T = 2 * pi * sqrt(a^3 / mu)
 */
export function getOrbitalPeriod(body: OrbitalBody, mainBody: CelestialBody): number {
  const a = body.semiMajorAxis;
  return 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / mainBody.stdGravParam);
}

// Vector 3D algebra helpers
export function vecAdd(a: Vector3D, b: Vector3D): Vector3D {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vecSub(a: Vector3D, b: Vector3D): Vector3D {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vecScale(v: Vector3D, s: number): Vector3D {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vecDot(a: Vector3D, b: Vector3D): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vecCross(a: Vector3D, b: Vector3D): Vector3D {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

export function vecMag(v: Vector3D): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vecNorm(v: Vector3D): Vector3D {
  const m = vecMag(v);
  if (m === 0) return { x: 0, y: 0, z: 0 };
  return vecScale(v, 1 / m);
}

export function angleBetweenVecs(a: Vector3D, b: Vector3D): number {
  const ma = vecMag(a);
  const mb = vecMag(b);
  if (ma === 0 || mb === 0) return 0;
  const cosTheta = Math.max(-1, Math.min(1, vecDot(a, b) / (ma * mb)));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

export interface OrbitalElements {
  semiMajorAxis: number; // a
  eccentricity: number;   // e
  inclination: number;    // i (rad)
  ascNodeLongitude: number; // Omega (rad)
  argOfPeriapsis: number;   // omega (rad)
  meanAnomalyEpoch: number; // M0 (rad) at epoch t0
  trueAnomalyEpoch: number; // nu (rad) at epoch t0
  epoch: number;            // t0
  pVec?: Vector3D;          // Perifocal unit vector pointing to periapsis
  qVec?: Vector3D;          // Perifocal unit vector in orbital plane 90 deg ahead
}

/**
 * Converts position r0 and velocity v0 at time t0 into orbital elements
 */
export function stateToOrbitalElements(
  r0: Vector3D,
  v0: Vector3D,
  mu: number,
  t0: number
): OrbitalElements {
  const rMag = vecMag(r0);
  const vMag = vecMag(v0);

  if (rMag <= 0 || mu <= 0) {
    return {
      semiMajorAxis: 1e9,
      eccentricity: 0,
      inclination: 0,
      ascNodeLongitude: 0,
      argOfPeriapsis: 0,
      meanAnomalyEpoch: 0,
      trueAnomalyEpoch: 0,
      epoch: t0
    };
  }

  // Specific orbital energy
  const specEnergy = (vMag * vMag) / 2 - mu / rMag;
  const a = Math.abs(specEnergy) > 1e-12 ? -mu / (2 * specEnergy) : rMag;

  // Angular momentum vector h = r0 x v0
  const h = vecCross(r0, v0);
  const hMag = vecMag(h);
  const W = hMag > 1e-12 ? vecScale(h, 1 / hMag) : { x: 0, y: 0, z: 1 };

  // Eccentricity vector
  const r0dotV0 = vecDot(r0, v0);
  const eVec = {
    x: ((vMag * vMag - mu / rMag) * r0.x - r0dotV0 * v0.x) / mu,
    y: ((vMag * vMag - mu / rMag) * r0.y - r0dotV0 * v0.y) / mu,
    z: ((vMag * vMag - mu / rMag) * r0.z - r0dotV0 * v0.z) / mu
  };
  const e = vecMag(eVec);

  // Perifocal basis vectors P and Q
  let P = e > 1e-12 ? vecScale(eVec, 1 / e) : vecNorm(r0);
  if (vecMag(P) === 0) P = { x: 1, y: 0, z: 0 };
  let Q = vecCross(W, P);
  const qMag = vecMag(Q);
  if (qMag === 0) {
    Q = { x: 0, y: 1, z: 0 };
  } else {
    Q = vecScale(Q, 1 / qMag);
  }

  // True anomaly nu0 at epoch t0
  const x0 = vecDot(r0, P);
  const y0 = vecDot(r0, Q);
  let nu0 = Math.atan2(y0, x0);
  if (nu0 < 0) nu0 += 2 * Math.PI;

  // Mean anomaly M0
  let M0 = 0;
  if (e < 0.99999) {
    const absA = Math.abs(a);
    const cosE0 = Math.max(-1, Math.min(1, (x0 / absA) + e));
    const sinE0 = y0 / (absA * Math.sqrt(Math.max(1e-12, 1 - e * e)));
    const E0 = Math.atan2(sinE0, cosE0);
    M0 = E0 - e * Math.sin(E0);
    M0 = M0 % (2 * Math.PI);
    if (M0 < 0) M0 += 2 * Math.PI;
  } else {
    const absA = Math.abs(a);
    const sinhH0 = y0 / (absA * Math.sqrt(Math.max(1e-12, e * e - 1)));
    const H0 = Math.asinh(sinhH0);
    M0 = e * Math.sinh(H0) - H0;
  }

  // Standard Keplerian elements for UI display / compatibility
  const incRad = Math.acos(Math.max(-1, Math.min(1, W.z)));

  // Node vector n = k x h = (-hy, hx, 0)
  const nVec = { x: -h.y, y: h.x, z: 0 };
  const nMag = vecMag(nVec);

  let omegaNodeRad = 0;
  let argPeriRad = 0;

  if (nMag > 1e-12) {
    omegaNodeRad = Math.atan2(nVec.y, nVec.x);
    if (omegaNodeRad < 0) omegaNodeRad += 2 * Math.PI;

    const N = vecScale(nVec, 1 / nMag);
    argPeriRad = Math.atan2(-vecDot(Q, N), vecDot(P, N));
    if (argPeriRad < 0) argPeriRad += 2 * Math.PI;
  } else {
    if (W.z >= 0) {
      argPeriRad = Math.atan2(P.y, P.x);
    } else {
      argPeriRad = Math.atan2(-P.y, P.x);
    }
    if (argPeriRad < 0) argPeriRad += 2 * Math.PI;
  }

  return {
    semiMajorAxis: a,
    eccentricity: e,
    inclination: incRad,
    ascNodeLongitude: omegaNodeRad,
    argOfPeriapsis: argPeriRad,
    meanAnomalyEpoch: M0,
    trueAnomalyEpoch: nu0,
    epoch: t0,
    pVec: P,
    qVec: Q
  };
}

/**
 * Calculates 3D position vector at time t from orbital elements and central mu
 */
export function getPositionFromOrbitalElements(
  elements: OrbitalElements,
  mu: number,
  t: number
): Vector3D {
  return getStateFromOrbitalElements(elements, mu, t).pos;
}
