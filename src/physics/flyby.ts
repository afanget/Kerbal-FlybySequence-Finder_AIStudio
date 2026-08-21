/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { getMinFlybyAlt, getMinFlybyRadius } from '../data/solarSystems';
import { CelestialBody, OrbitalBody, FlybyDetail, FlyableSequenceResult, PorkchopPlotData, DirectionalLink, InstanceNode, SequenceProfilingStats, SequenceBlockTiming, SequencePorkchopData, SequenceTransferData, Vector3D } from '../types';
import { vecSub, vecMag, vecDot, getBodyStateAtUT, vecAdd, vecScale } from './kepler';
import { solveLambert } from './lambert';

export interface FlybyFeasibility {
  isValid: boolean; // Is flyby achievable without atmospheric impact?
  matchedFlybyDate?: number; // UT timestamp of matched unpowered flyby date
  periapsisAlt: number; // Periapsis altitude above surface (m)
  flybyMargin: number; // Periapsis altitude minus atmosphere/safe height (m)
  deflectionAngle: number; // Required deflection angle (degrees)
  maxDeflectionAngle: number; // Maximum deflection angle at min periapsis (degrees)
  stochasticDv: number; // Trajectory correction delta-V (m/s) post-flyby due to position and speed errors pre-flyby
  vInfInMag: number; // m/s
  vInfOutMag: number; // m/s
}

export interface FlybyEvaluationResult {
  isValid: boolean;
  isUnpowered: boolean;
  vInfInMag: number;
  vInfOutMag: number;
  deflectionAngleDeg: number;
  maxDeflectionAngleDeg: number;
  periapsisAlt: number; // meters
  flybyMargin: number;  // meters
  poweredDv: number;    // m/s required at periapsis if powered (0 if unpowered)
  stochasticDv: number; // m/s
}

export const MAX_DC3_UNPOWERED_FLYBY = 100 * 100; // m²/s² (if C3 difference is within 100 m/s equivalent, flyby is considered unpowered)
export const FACTOR_RP_NO_DEFLECTION = 100;
export const MIN_LEG_TIME_SECONDS = 3600;
export const MIN_TOTAL_SEQUENCE_TIME_SECONDS = 7200;
export const DATE_PRECISION_BISECTION_SECONDS = 864; // 1% of a day (864 seconds)
export const MAX_BISECTION_ITERATIONS = 30;
export const FREE_FLYBY_MAX_DV_MPS = 1.0;
export const KM_S_TO_M_S = 1000;
export const KM2_S2_TO_M2_S2 = KM_S_TO_M_S*KM_S_TO_M_S;
export const EPSILON_EXCESS_ANGLE = 1e-5;
export const FEASIBILITY_ANGLE_MARGIN_DEG = 0.01;
export const MAX_ALLOWED_FLYBY_DV_MPS = 1e6;

/**
 * Calculates powered delta-V required at flyby periapsis given inbound/outbound speed and turning angles.
 */
export function computeFlybyPoweredDv(
  vInfInMag: number,
  vInfOutMag: number,
  deflectionAngleDeg: number,
  maxDeflectionAngleDeg: number,
  mu: number,
  rpMin: number
): number {
  if (vInfInMag <= 0 || vInfOutMag <= 0) return Infinity;

  const deltaC3 = Math.abs(vInfInMag * vInfInMag - vInfOutMag * vInfOutMag);
  const isVInfMatched = deltaC3 < MAX_DC3_UNPOWERED_FLYBY || Math.abs(vInfInMag - vInfOutMag) < 1.0;
  const isDeflectionFeasible = deflectionAngleDeg <= maxDeflectionAngleDeg + FEASIBILITY_ANGLE_MARGIN_DEG;

  if (isVInfMatched && isDeflectionFeasible) {
    return 0;
  }

  const vpIn = Math.sqrt(vInfInMag * vInfInMag + (2 * mu) / rpMin);
  const vpOut = Math.sqrt(vInfOutMag * vInfOutMag + (2 * mu) / rpMin);

  const excessAngleDeg = Math.max(0, deflectionAngleDeg - maxDeflectionAngleDeg);
  const excessAngleRad = (excessAngleDeg * Math.PI) / 180;

  if (excessAngleRad > EPSILON_EXCESS_ANGLE) {
    return Math.sqrt(vpIn * vpIn + vpOut * vpOut - 2 * vpIn * vpOut * Math.cos(excessAngleRad));
  }

  return Math.abs(vpOut - vpIn);
}

/**
 * Unified evaluation for both unpowered and powered flybys at a specific body and date.
 */
export function evaluateFlybyAtDate(
  body: CelestialBody,
  vInfIn: Vector3D,
  vInfOut: Vector3D,
  date: number,
  minFlybyAltOverride?: number,
  stochasticAltError?: number,
  stochasticVelError?: number
): FlybyEvaluationResult {
  const mu = body.stdGravParam;
  const minAlt = getMinFlybyAlt(body, minFlybyAltOverride);
  const rpMin = body.radius + minAlt;

  const vInMag = vecMag(vInfIn);
  const vOutMag = vecMag(vInfOut);

  if (vInMag <= 0 || vOutMag <= 0) {
    return {
      isValid: false,
      isUnpowered: false,
      vInfInMag: vInMag,
      vInfOutMag: vOutMag,
      deflectionAngleDeg: 0,
      maxDeflectionAngleDeg: 0,
      periapsisAlt: 0,
      flybyMargin: 0,
      poweredDv: 0,
      stochasticDv: 0,
    };
  }

  // Deflection angle between inbound and outbound v_infinity vectors
  const cosDelta = Math.max(-1, Math.min(1, vecDot(vInfIn, vInfOut) / (vInMag * vOutMag)));
  const deflectionRad = Math.acos(cosDelta);
  const deflectionAngleDeg = (deflectionRad * 180) / Math.PI;

  // Hyperbolic eccentricities at minimum periapsis rpMin
  const e1Min = 1 + (rpMin * vInMag * vInMag) / Math.max(1, mu);
  const e2Min = 1 + (rpMin * vOutMag * vOutMag) / Math.max(1, mu);

  const maxDeflection1Rad = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / e1Min)));
  const maxDeflection2Rad = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / e2Min)));
  const maxDeflectionTotalRad = (maxDeflection1Rad + maxDeflection2Rad) / 2;
  const maxDeflectionAngleDeg = (maxDeflectionTotalRad * 180) / Math.PI;

  // Determine periapsis radius rp
  let rp = rpMin;
  const deltaC3 = Math.abs(vInMag * vInMag - vOutMag * vOutMag); // m²/s²
  const isVInfMatched = deltaC3 < MAX_DC3_UNPOWERED_FLYBY || Math.abs(vInMag - vOutMag) < 1.0;

  if (isVInfMatched && deflectionRad <= maxDeflectionTotalRad + 1e-4) {
    const sinHalf = Math.sin(deflectionRad / 2);
    const avgVInfSq = (vInMag * vInMag + vOutMag * vOutMag) / 2;
    if (sinHalf > 1e-6) {
      rp = (mu / avgVInfSq) * (1 / sinHalf - 1);
    } else {
      rp = rpMin * FACTOR_RP_NO_DEFLECTION;
    }
  }

  rp = Math.max(rpMin, rp);
  const periapsisAlt = rp - body.radius;
  const flybyMargin = periapsisAlt - minAlt;

  // Powered delta-V required at periapsis
  const poweredDv = computeFlybyPoweredDv(
    vInMag,
    vOutMag,
    deflectionAngleDeg,
    maxDeflectionAngleDeg,
    mu,
    rp
  );

  const isUnpowered = isVInfMatched && poweredDv < 0.1 && flybyMargin >= -1e-3;

  const { stochasticDv: baseStochasticDv } = calculateStochasticDvCore(
    body,
    periapsisAlt,
    vInMag,
    vOutMag,
    stochasticAltError,
    stochasticVelError
  );

  const stochasticDv = baseStochasticDv + Math.sqrt(deltaC3);

  return {
    isValid: flybyMargin >= -1e-3,
    isUnpowered,
    vInfInMag: vInMag,
    vInfOutMag: vOutMag,
    deflectionAngleDeg,
    maxDeflectionAngleDeg,
    periapsisAlt,
    flybyMargin,
    poweredDv,
    stochasticDv,
  };
}

export const DEFAULT_STOCHASTIC_ALT_ERROR = 10000; // 10 km in meters
export const DEFAULT_STOCHASTIC_VEL_ERROR = 1.0;   // 1 m/s

/**
 * Computes maximum achievable turning angle (in degrees) at a given periapsis radius and v_infinity speed.
 */
export function computeMaxDeflectionAngle(
  rPeri: number,
  vInfMag: number,
  mu: number
): number {
  if (rPeri <= 0 || vInfMag <= 0 || mu <= 0 || !Number.isFinite(rPeri) || !Number.isFinite(vInfMag) || !Number.isFinite(mu)) return 0;
  const e = 1 + (rPeri * vInfMag * vInfMag) / mu;
  if (!Number.isFinite(e) || e <= 1) return 0;
  const sinHalf = Math.max(-1, Math.min(1, 1 / e));
  const angleDeg = 2 * Math.asin(sinHalf) * (180 / Math.PI);
  return Number.isFinite(angleDeg) ? angleDeg : 0;
}

/**
 * Computes required periapsis radius from a deflection angle at a given mean v_infinity speed.
 */
export function computePeriapsisRadiusFromDeflection(
  deflectionAngleDeg: number,
  meanVInfMag: number,
  mu: number,
  rPeriMin: number
): number {
  if (!Number.isFinite(deflectionAngleDeg) || !Number.isFinite(meanVInfMag) || deflectionAngleDeg <= 0 || meanVInfMag <= 0 || mu <= 0 || rPeriMin <= 0) {
    return rPeriMin;
  }
  const deflectionRad = (deflectionAngleDeg * Math.PI) / 180;
  const sinHalf = Math.sin(deflectionRad / 2);
  if (sinHalf <= 1e-6) {
    return rPeriMin * FACTOR_RP_NO_DEFLECTION;
  }
  const denom = meanVInfMag * meanVInfMag;
  if (denom <= 1e-6) return rPeriMin;
  const rp = (mu / denom) * (1 / sinHalf - 1);
  return Number.isFinite(rp) ? Math.max(rPeriMin, rp) : rPeriMin;
}

/**
 * Computes total stochastic delta-V for a flyby including position/velocity error perturbations and C3 mismatch.
 */
export function computeFlybyStochasticDv(
  body: CelestialBody,
  periapsisAlt: number,
  vInfInMag: number,
  vInfOutMag: number,
  stochasticAltError?: number,
  stochasticVelError?: number
): number {
  const safeVIn = Number.isFinite(vInfInMag) && vInfInMag > 0 ? vInfInMag : 0;
  const safeVOut = Number.isFinite(vInfOutMag) && vInfOutMag > 0 ? vInfOutMag : 0;
  const safeAlt = Number.isFinite(periapsisAlt) ? periapsisAlt : 0;
  const { stochasticDv: baseStochDv } = calculateStochasticDvCore(
    body,
    safeAlt,
    safeVIn,
    safeVOut,
    stochasticAltError,
    stochasticVelError
  );
  const deltaC3 = Math.abs(safeVIn * safeVIn - safeVOut * safeVOut);
  const stochDv = baseStochDv + Math.sqrt(deltaC3);
  return Number.isFinite(stochDv) ? stochDv : 0;
}

export interface StochasticDvResult {
  stochasticDv: number;
  eNom: number;
  ePert: number;
  deflectionRadNom: number;
  deflectionRadPert: number;
  deltaTurnRad: number;
  rpNom: number;
  rpPert: number;
}

/**
 * Core mathematical calculation for stochastic delta-v perturbation dynamics.
 */
export function calculateStochasticDvCore(
  body: CelestialBody | undefined,
  periapsisAlt: number,
  vInfInMag: number,
  vInfOutMag: number,
  stochasticAltError?: number,
  stochasticVelError?: number
): StochasticDvResult {
  const altErr = stochasticAltError ?? DEFAULT_STOCHASTIC_ALT_ERROR;
  const velErr = stochasticVelError ?? DEFAULT_STOCHASTIC_VEL_ERROR;

  if (!body || vInfInMag <= 0 || vInfOutMag <= 0) {
    return {
      stochasticDv: 0,
      eNom: 1,
      ePert: 1,
      deflectionRadNom: 0,
      deflectionRadPert: 0,
      deltaTurnRad: 0,
      rpNom: 0,
      rpPert: 0
    };
  }

  const mu = body.stdGravParam;
  const rpNom = body.radius + periapsisAlt;

  const eNom = 1 + (rpNom * vInfInMag * vInfInMag) / Math.max(1, mu);
  const deflectionRadNom = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / eNom)));

  const rpPert = rpNom - altErr;
  const vInfInPert = Math.max(0.1, vInfInMag - velErr);

  const ePert = 1 + (rpPert * vInfInPert * vInfInPert) / Math.max(1, mu);
  const deflectionRadPert = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / ePert)));

  const vInfOutPert = vInfOutMag * (vInfInPert / vInfInMag);
  const deltaTurnRad = deflectionRadPert - deflectionRadNom;

  const stochasticDv = Math.sqrt(
    Math.max(
      0,
      vInfOutPert * vInfOutPert +
        vInfOutMag * vInfOutMag -
        2 * vInfOutPert * vInfOutMag * Math.cos(deltaTurnRad)
    )
  );

  return {
    stochasticDv,
    eNom,
    ePert,
    deflectionRadNom,
    deflectionRadPert,
    deltaTurnRad,
    rpNom,
    rpPert
  };
}

/**
 * Recomputes stochastic delta-V for an existing flyby given new position/velocity error parameters.
 */
export function computeStochasticDvForFlyby(
  f: FlybyDetail,
  body: CelestialBody,
  stochasticAltError?: number,
  stochasticVelError?: number
): number {
  return calculateStochasticDvCore(
    body,
    f.periapsisAlt,
    f.vInfInMag,
    f.vInfOutMag,
    stochasticAltError,
    stochasticVelError
  ).stochasticDv;
}

export interface StochasticDvDebugInfo {
  bodyName: string;
  mu: number;
  radiusKm: number;
  periapsisAltKm: number;
  stochasticAltErrorKm: number;
  stochasticVelErrorMs: number;
  vInfInMagMs: number;
  vInfOutMagMs: number;
  eNom: number;
  ePert: number;
  deflectionDegNom: number;
  deflectionDegPert: number;
  deltaTurnDeg: number;
  stochasticDvMs: number;
}

export function debugStochasticDvCalculation(
  f: FlybyDetail,
  body: CelestialBody,
  stochasticAltError?: number,
  stochasticVelError?: number
): StochasticDvDebugInfo {
  const altErr = stochasticAltError ?? DEFAULT_STOCHASTIC_ALT_ERROR;
  const velErr = stochasticVelError ?? DEFAULT_STOCHASTIC_VEL_ERROR;
  const mu = body.stdGravParam;
  const R = body.radius;

  const core = calculateStochasticDvCore(
    body,
    f.periapsisAlt,
    f.vInfInMag,
    f.vInfOutMag,
    altErr,
    velErr
  );

  return {
    bodyName: f.bodyName,
    mu,
    radiusKm: R / 1000,
    periapsisAltKm: f.periapsisAlt / 1000,
    stochasticAltErrorKm: altErr / 1000,
    stochasticVelErrorMs: velErr,
    vInfInMagMs: f.vInfInMag,
    vInfOutMagMs: f.vInfOutMag,
    eNom: core.eNom,
    ePert: core.ePert,
    deflectionDegNom: (core.deflectionRadNom * 180) / Math.PI,
    deflectionDegPert: (core.deflectionRadPert * 180) / Math.PI,
    deltaTurnDeg: (core.deltaTurnRad * 180) / Math.PI,
    stochasticDvMs: core.stochasticDv
  };
}

/**
  * Matches inbound and outbound v_infinity magnitudes for an unpowered flyby via linear regression
  * directly from porkchop v_infinity vectors without repeating Lambert solves.
  */
export function matchUnpoweredFlyby(
  body: CelestialBody,
  vecVInfIn1: Vector3D,
  vecInfIn2: Vector3D,
  vecVInfOut1: Vector3D,
  vecInfOut2: Vector3D,
  t1: number,
  t2: number,
  minFlybyAlt?: number,
  stochasticAltError?: number,
  stochasticVelError?: number
): FlybyFeasibility {
  // 1. Calculate central body gravitational parameter, radius, and initial v_infinity magnitudes.
  const mu = body.stdGravParam;
  const R = body.radius;
  const minAlt = getMinFlybyAlt(body, minFlybyAlt);
  const rpMin = R + minAlt;

  const vIn1 = vecMag(vecVInfIn1);
  const vIn2 = vecMag(vecInfIn2);

  const vOut1 = vecMag(vecVInfOut1);
  const vOut2 = vecMag(vecInfOut2);

  // 2. Reject early if inbound or outbound v_infinity magnitude is non-positive.
  if (vIn1 <= 0 || vOut1 <= 0) {
    return {
      isValid: false,
      periapsisAlt: 0,
      flybyMargin: -minAlt,
      deflectionAngle: 0,
      maxDeflectionAngle: 0,
      stochasticDv: 0,
      vInfInMag: vIn1,
      vInfOutMag: vOut1
    };
  }
  
  const deltaC3_1 = Math.abs(vIn1 * vIn1 - vOut1 * vOut1);

  // If abs(C3arr - C3dep) < maxdC3inUnpoweredFlyby m²/s², vinf are considered matching directly at t1
  // without needing to solve linear regression across [t1, t2]
  let tMatch = t1;
  let vMatch = (vIn1 + vOut1) / 2;
  let vecVInfInMatch = vecVInfIn1;
  let vecVInfOutMatch = vecVInfOut1;
  let deltaC3ForStochastic = 0;

  if (deltaC3_1 >= MAX_DC3_UNPOWERED_FLYBY) {
    // Perform linear regression on v_infinity magnitudes to find crossing date (tMatch)
    const dt = t2 - t1;
    if (dt > 0) {
      const mIn = (vIn2 - vIn1) / dt;
      const mOut = (vOut2 - vOut1) / dt;
      const denom = mIn - mOut;

      if (Math.abs(denom) < 1e-12) {
        if (Math.abs(vIn1 - vOut1) < 150.0) {
          tMatch = t1;
          vMatch = (vIn1 + vOut1) / 2;
        } else {
          return {
            isValid: false,
            periapsisAlt: 0,
            flybyMargin: -minAlt,
            deflectionAngle: 0,
            maxDeflectionAngle: 0,
            stochasticDv: 0,
            vInfInMag: vIn1,
            vInfOutMag: vOut1
          };
        }
      } else {
        const deltaT = (vOut1 - vIn1) / denom;
        const alpha = deltaT / dt;

        if (alpha < 0 || alpha > 1) {
          return {
            isValid: false,
            periapsisAlt: 0,
            flybyMargin: -minAlt,
            deflectionAngle: 0,
            maxDeflectionAngle: 0,
            stochasticDv: 0,
            vInfInMag: vIn1,
            vInfOutMag: vOut1
          };
        } else {
          tMatch = t1 + deltaT;
          vMatch = vIn1 + mIn * deltaT;
        }
      }
    } else {
      if (Math.abs(vIn1 - vOut1) > 150.0) {
        return {
          isValid: false,
          periapsisAlt: 0,
          flybyMargin: -minAlt,
          deflectionAngle: 0,
          maxDeflectionAngle: 0,
          stochasticDv: 0,
          vInfInMag: vIn1,
          vInfOutMag: vOut1
        };
      }
      vMatch = (vIn1 + vOut1) / 2;
    }

    const dtReg = t2 - t1;
    const frac = (dtReg > 0) ? (tMatch - t1) / dtReg : 0;

    vecVInfInMatch = {
      x: vecVInfIn1.x + frac * (vecInfIn2.x - vecVInfIn1.x),
      y: vecVInfIn1.y + frac * (vecInfIn2.y - vecVInfIn1.y),
      z: vecVInfIn1.z + frac * (vecInfIn2.z - vecVInfIn1.z)
    };

    vecVInfOutMatch = {
      x: vecVInfOut1.x + frac * (vecInfOut2.x - vecVInfOut1.x),
      y: vecVInfOut1.y + frac * (vecInfOut2.y - vecVInfOut1.y),
      z: vecVInfOut1.z + frac * (vecInfOut2.z - vecVInfOut1.z)
    };

    deltaC3ForStochastic = Math.abs(vecMag(vecVInfInMatch) ** 2 - vecMag(vecVInfOutMatch) ** 2);
  }

  const vInMatchMag = vecMag(vecVInfInMatch);
  const vOutMatchMag = vecMag(vecVInfOutMatch);

  const cosDelta = (vInMatchMag > 1e-12 && vOutMatchMag > 1e-12)
    ? Math.max(-1, Math.min(1, vecDot(vecVInfInMatch, vecVInfOutMatch) / (vInMatchMag * vOutMatchMag)))
    : 1.0;
  const deflectionAngleRad = Math.acos(cosDelta);
  const deflectionAngleDeg = (deflectionAngleRad * 180) / Math.PI;

  // Check maximum deflection angle constraint at minimum periapsis altitude.
  const eMin = 1 + (rpMin * vMatch * vMatch) / Math.max(1, mu);
  const maxDeflectionRad = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / eMin)));
  const maxDeflectionDeg = (maxDeflectionRad * 180) / Math.PI;

  if (deflectionAngleRad > maxDeflectionRad + 1e-4) {
    return {
      isValid: false,
      periapsisAlt: 0,
      flybyMargin: -minAlt,
      deflectionAngle: deflectionAngleDeg,
      maxDeflectionAngle: maxDeflectionDeg,
      stochasticDv: 0,
      vInfInMag: vMatch,
      vInfOutMag: vMatch
    };
  }

  // Calculate required periapsis altitude and check against minimum altitude limits.
  const sinHalfDelta = Math.sin(deflectionAngleRad / 2);
  let rpRequired = rpMin;
  if (sinHalfDelta > 1e-6) {
    rpRequired = (mu / (vMatch * vMatch)) * (1 / sinHalfDelta - 1);
  } else {
    rpRequired = rpMin * FACTOR_RP_NO_DEFLECTION;
  }

  const periapsisAlt = rpRequired - R;
  const flybyMargin = periapsisAlt - minAlt;

  if (flybyMargin < -1e-3) {
    return {
      isValid: false,
      periapsisAlt,
      flybyMargin,
      deflectionAngle: deflectionAngleDeg,
      maxDeflectionAngle: maxDeflectionDeg,
      stochasticDv: 0,
      vInfInMag: vMatch,
      vInfOutMag: vMatch
    };
  }

  // Calculate stochastic Delta-V for the flyby, increased by sqrt(abs(delta-C3))
  const { stochasticDv: baseStochasticDv } = calculateStochasticDvCore(
    body,
    periapsisAlt,
    vMatch,
    vMatch,
    stochasticAltError,
    stochasticVelError
  );
  const stochasticDv = baseStochasticDv + Math.sqrt(deltaC3ForStochastic);

  return {
    isValid: true,
    matchedFlybyDate: tMatch,
    periapsisAlt,
    flybyMargin,
    deflectionAngle: deflectionAngleDeg,
    maxDeflectionAngle: maxDeflectionDeg,
    stochasticDv,
    vInfInMag: vMatch,
    vInfOutMag: vMatch
  };
}

export interface SequentialFlybyVectorData {
  date: number;
  bodyVel: Vector3D;
  vTransIn: Vector3D;
  vTransOut: Vector3D;
  vInfIn: Vector3D;
  vInfOut: Vector3D;
}

export interface SequentialFlybyDebugInfo {
  flybyIndex: number;
  bodyName: string;
  flybyDate: number;
  flybyDateSampling: number;
  matchedFlybyDate?: number;
  vTransIn: Vector3D;
  vTransOut: Vector3D;
  vBodyVel: Vector3D;
  vInfInVec: Vector3D;
  vInfOutVec: Vector3D;
  vInfIn2Vec: Vector3D;
  vInfOut2Vec: Vector3D;
  vInfInMag: number;
  vInfOutMag: number;
  deflectionAngleDeg: number;
  maxDeflectionDeg: number;
  periapsisAltKm: number;
  flybyMarginKm: number;
  isValid: boolean;
  stochasticDvMs: number;
  t1Data: SequentialFlybyVectorData;
  t2Data: SequentialFlybyVectorData;
  tMatchData: SequentialFlybyVectorData;
}

/**
 * Sequentially recomputes flybys for each intermediate body in a flyby sequence,
 * returning full vector and physics debug information.
 */
export function recomputeFlybyDetailsSequentially(
  seq: FlyableSequenceResult,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  stochasticAltError: number,
  stochasticVelError: number,
  flybyBodyDateSampling = 86400,
  porkchops?: Record<string, PorkchopPlotData>,
  links?: DirectionalLink[],
  instances?: InstanceNode[]
): SequentialFlybyDebugInfo[] {
  const debugInfos: SequentialFlybyDebugInfo[] = [];
  const bodyMap = new Map<string, OrbitalBody>(bodies.map(b => [b.name, b]));

  if (!seq.transfers || seq.transfers.length === 0) return debugInfos;

  // Flybys occur at intermediate bodies (index 1 to bodyNames.length - 2)
  for (let k = 1; k < seq.bodyNames.length - 1; k++) {
    const bodyName = seq.bodyNames[k];
    const flybyBody = bodyMap.get(bodyName)!;

    const trIn = seq.transfers[k - 1];
    const trOut = seq.transfers[k];

    if (!trIn || !trOut) continue;

    const tPrev = trIn.arrDate;
    const stPrev1 = getBodyStateAtUT(flybyBody, mainBody, tPrev);

    const vTransIn1: Vector3D = trIn.vTransArr;
    const vTransOut1: Vector3D = trOut.vTransDep;

    const vInfIn1 = vecSub(vTransIn1, stPrev1.vel);
    const vInfOut1 = vecSub(vTransOut1, stPrev1.vel);

    // Identify instance & links for this flyby
    const instFlybyId = seq.instanceIds?.[k];
    const instSrcId = seq.instanceIds?.[k - 1];
    const instTgtId = seq.instanceIds?.[k + 1];

    const flybyInst = instances?.find(i => i.id === instFlybyId);

    const linkPrev = links?.find(l => l.sourceInstanceId === instSrcId && l.targetInstanceId === instFlybyId);
    const linkCurr = links?.find(l => l.sourceInstanceId === instFlybyId && l.targetInstanceId === instTgtId);

    const pcPrev = linkPrev && porkchops ? porkchops[linkPrev.id] : undefined;
    const pcCurr = linkCurr && porkchops ? porkchops[linkCurr.id] : undefined;

    let t1 = tPrev;
    let t2 = tPrev;
    let stPrev2 = stPrev1;
    let vTransIn2 = vTransIn1;
    let vTransOut2 = vTransOut1;
    let vInfIn2 = vInfIn1;
    let vInfOut2 = vInfOut1;

    if (pcPrev && pcCurr) {
      const jPrev = pcPrev.arrDates.indexOf(tPrev);
      const iCurr = pcCurr.depDates.indexOf(tPrev);

      if (jPrev !== -1 && jPrev < pcPrev.arrDates.length - 1 && iCurr !== -1 && iCurr < pcCurr.depDates.length - 1) {
        const t2Candidate = Math.min(pcPrev.arrDates[jPrev + 1], pcCurr.depDates[iCurr + 1]);
        const dt = t2Candidate - tPrev;
        if (dt > 0) {
          t2 = t2Candidate;
          stPrev2 = getBodyStateAtUT(flybyBody, mainBody, t2);
          const iPrevDep = pcPrev.depDates.indexOf(trIn.depDate);
          const jNextArr = pcCurr.arrDates.indexOf(trOut.arrDate);

          const vTransIn2Raw = pcPrev.vTransArrMatrix?.[iPrevDep]?.[jPrev + 1];
          const vTransOut2Raw = pcCurr.vTransDepMatrix?.[iCurr + 1]?.[jNextArr];

          if (vTransIn2Raw) {
            vTransIn2 = vTransIn2Raw;
            vInfIn2 = vecSub(vTransIn2, stPrev2.vel);
          } else {
            vTransIn2 = { x: vInfIn2.x + stPrev2.vel.x, y: vInfIn2.y + stPrev2.vel.y, z: vInfIn2.z + stPrev2.vel.z };
          }

          if (vTransOut2Raw) {
            vTransOut2 = vTransOut2Raw;
            vInfOut2 = vecSub(vTransOut2, stPrev2.vel);
          } else {
            vTransOut2 = { x: vInfOut2.x + stPrev2.vel.x, y: vInfOut2.y + stPrev2.vel.y, z: vInfOut2.z + stPrev2.vel.z };
          }
        }
      }
    }

    const minFlybyAlt = flybyInst?.minFlybyAltitude;

    const flybyFeas = matchUnpoweredFlyby(
      flybyBody,
      vInfIn1,
      vInfIn2,
      vInfOut1,
      vInfOut2,
      t1,
      t2,
      minFlybyAlt,
      stochasticAltError,
      stochasticVelError
    );

    const tMatch = flybyFeas.matchedFlybyDate ?? t1;
    const stMatch = getBodyStateAtUT(flybyBody, mainBody, tMatch);
    const dtSample = t2 - t1;
    const fracMatch = dtSample > 0 ? (tMatch - t1) / dtSample : 0;

    const vInfInMatch: Vector3D = {
      x: vInfIn1.x + fracMatch * (vInfIn2.x - vInfIn1.x),
      y: vInfIn1.y + fracMatch * (vInfIn2.y - vInfIn1.y),
      z: vInfIn1.z + fracMatch * (vInfIn2.z - vInfIn1.z)
    };
    const vInfOutMatch: Vector3D = {
      x: vInfOut1.x + fracMatch * (vInfOut2.x - vInfOut1.x),
      y: vInfOut1.y + fracMatch * (vInfOut2.y - vInfOut1.y),
      z: vInfOut1.z + fracMatch * (vInfOut2.z - vInfOut1.z)
    };

    const vTransInMatch: Vector3D = {
      x: vInfInMatch.x + stMatch.vel.x,
      y: vInfInMatch.y + stMatch.vel.y,
      z: vInfInMatch.z + stMatch.vel.z
    };
    const vTransOutMatch: Vector3D = {
      x: vInfOutMatch.x + stMatch.vel.x,
      y: vInfOutMatch.y + stMatch.vel.y,
      z: vInfOutMatch.z + stMatch.vel.z
    };

    const t1Data: SequentialFlybyVectorData = {
      date: t1,
      bodyVel: stPrev1.vel,
      vTransIn: vTransIn1,
      vTransOut: vTransOut1,
      vInfIn: vInfIn1,
      vInfOut: vInfOut1,
    };

    const t2Data: SequentialFlybyVectorData = {
      date: t2,
      bodyVel: stPrev2.vel,
      vTransIn: vTransIn2,
      vTransOut: vTransOut2,
      vInfIn: vInfIn2,
      vInfOut: vInfOut2,
    };

    const tMatchData: SequentialFlybyVectorData = {
      date: tMatch,
      bodyVel: stMatch.vel,
      vTransIn: vTransInMatch,
      vTransOut: vTransOutMatch,
      vInfIn: vInfInMatch,
      vInfOut: vInfOutMatch,
    };

    debugInfos.push({
      flybyIndex: k,
      bodyName,
      flybyDate: t1,
      flybyDateSampling: Math.abs(t2 - t1) || flybyBodyDateSampling,
      matchedFlybyDate: flybyFeas.matchedFlybyDate,
      vTransIn: vTransIn1,
      vTransOut: vTransOut1,
      vBodyVel: stPrev1.vel,
      vInfInVec: vInfIn1,
      vInfOutVec: vInfOut1,
      vInfIn2Vec: vInfIn2,
      vInfOut2Vec: vInfOut2,
      vInfInMag: flybyFeas.vInfInMag,
      vInfOutMag: flybyFeas.vInfOutMag,
      deflectionAngleDeg: flybyFeas.deflectionAngle,
      maxDeflectionDeg: flybyFeas.maxDeflectionAngle,
      periapsisAltKm: flybyFeas.periapsisAlt / 1000,
      flybyMarginKm: flybyFeas.flybyMargin / 1000,
      isValid: flybyFeas.isValid,
      stochasticDvMs: flybyFeas.stochasticDv,
      t1Data,
      t2Data,
      tMatchData,
    });
  }

  return debugInfos;
}

export interface SequenceTransferResult {
  c3DepA: Vector3D;
  c3ArrB?: Vector3D;
  c3DepB?: Vector3D;
  c3ArrC?: Vector3D;
  c3DepC?: Vector3D;
  c3ArrFinal: Vector3D;
  totalDv: number;
  flybyDvs: number[];
  flybyDates: number[];
  flybyC3Arrs?: Vector3D[];
  flybyC3Deps?: Vector3D[];
  isPhysicallyValid?: boolean;
  isConstraintValid?: boolean;
}

/**
 * High-resolution profiler accumulating execution time across different logical blocks
 * inside evaluateSequenceTransferFromDirectPorkchops.
 */
export class SequenceTransferProfiler {
  matrixLookupMs = 0;
  candidatePoolingMs = 0;
  samplingAndPhysicsMs = 0;
  localMinimaSearchMs = 0;
  continuousOptimizationMs = 0;
  totalMethodMs = 0;
  callsCount = 0;

  reset() {
    this.matrixLookupMs = 0;
    this.candidatePoolingMs = 0;
    this.samplingAndPhysicsMs = 0;
    this.localMinimaSearchMs = 0;
    this.continuousOptimizationMs = 0;
    this.totalMethodMs = 0;
    this.callsCount = 0;
  }

  getStats(totalComputationTimeMs?: number, pointsEvaluated?: number): SequenceProfilingStats {
    const methodTotal = this.totalMethodMs || (
      this.matrixLookupMs +
      this.candidatePoolingMs +
      this.samplingAndPhysicsMs +
      this.localMinimaSearchMs +
      this.continuousOptimizationMs
    );
    const overallTotal = totalComputationTimeMs !== undefined && totalComputationTimeMs > 0 ? totalComputationTimeMs : methodTotal;
    const calls = Math.max(1, this.callsCount);

    const makeBlock = (id: string, name: string, desc: string, timeMs: number): SequenceBlockTiming => ({
      id,
      name,
      description: desc,
      timeMs: Math.round(timeMs * 100) / 100,
      callCount: this.callsCount,
      avgTimeUs: Math.round((timeMs * 1000 / calls) * 10) / 10,
      percentage: overallTotal > 0 ? Math.round((timeMs / overallTotal) * 1000) / 10 : 0,
    });

    const blocks: SequenceBlockTiming[] = [
      makeBlock(
        'matrix_lookup',
        '1. Matrix & Grid Index Lookup',
        'Direct link extraction, closest departure row and arrival column matching',
        this.matrixLookupMs
      ),
      makeBlock(
        'candidate_pooling',
        '2. Candidate Flyby Date Pooling',
        'Extracting & sorting candidate flyby dates across direct porkchops',
        this.candidatePoolingMs
      ),
      makeBlock(
        'sampling_physics',
        '3. Ephemeris & Flyby Physics',
        'Computing body orbits, v_inf vectors, deflection angles & powered flyby Δv',
        this.samplingAndPhysicsMs
      ),
      makeBlock(
        'local_minima',
        '4. Local Minima Detection',
        'Scanning sampled Δv curves to find optimal candidate flyby basins',
        this.localMinimaSearchMs
      ),
      makeBlock(
        'continuous_opt',
        '5. Continuous Optimization',
        'Bisection search & continuous flyby date refinement with interpolation',
        this.continuousOptimizationMs
      ),
    ];

    return {
      totalComputationTimeMs: Math.round(overallTotal * 100) / 100,
      methodTimeMs: Math.round(methodTotal * 100) / 100,
      callsCount: this.callsCount,
      pointsEvaluated: pointsEvaluated ?? this.callsCount,
      blocks,
      matrixLookupMs: Math.round(this.matrixLookupMs * 100) / 100,
      candidatePoolingMs: Math.round(this.candidatePoolingMs * 100) / 100,
      samplingAndPhysicsMs: Math.round(this.samplingAndPhysicsMs * 100) / 100,
      localMinimaSearchMs: Math.round(this.localMinimaSearchMs * 100) / 100,
      continuousOptimizationMs: Math.round(this.continuousOptimizationMs * 100) / 100,
    };
  }
}

/**
 * Fast binary search helper for finding closest timestamp in sorted date array.
 */
export function findClosestDateIndex(dates: number[], target: number): number {
  const len = dates.length;
  if (len === 0) return -1;
  if (len === 1) return 0;

  let low = 0;
  let high = len - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const val = dates[mid];
    if (val === target) return mid;
    if (val < target) low = mid + 1;
    else high = mid - 1;
  }

  let bestIdx = -1;
  let bestDiff = Infinity;

  for (let idx = Math.max(0, high - 1); idx <= Math.min(len - 1, low + 1); idx++) {
    const diff = Math.abs(dates[idx] - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

export interface DirectPorkchopFlybySample {
  j0: number;
  tFlyby: number;
  c3DepA: Vector3D;
  c3ArrB: Vector3D;
  c3DepB: Vector3D;
  c3ArrFinal: Vector3D;
  deflectionAngleDeg: number;
  maxDeflectionAngleDeg: number;
  dv: number;
  isValid: boolean;
  isPhysicallyValid?: boolean;
}

/**
 * Generates the array of candidate flyby samples across the matching date grid for a 3-instance (single flyby) transfer.
 */
export function generateDirectPorkchopFlybySamples(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  profiler?: SequenceTransferProfiler
): DirectPorkchopFlybySample[] | null {
  if (!pathInsts || !Array.isArray(pathInsts) || pathInsts.length !== 3) return null;
  const N = 3;

  // Hard Physical constraint: Total flight time must be at least 2 legs of MIN_LEG_TIME_SECONDS
  if (tArr - tDep < MIN_TOTAL_SEQUENCE_TIME_SECONDS) return null;

  const t0 = profiler ? performance.now() : 0;
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // Find direct link porkchops for each leg
  const legPorkchops: PorkchopPlotData[] = [];
  for (let k = 0; k < N - 1; k++) {
    const srcInst = pathInsts[k];
    const tgtInst = pathInsts[k + 1];
    const link = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === tgtInst.id);
    const linkId = link?.id || `link-${srcInst.id}-${tgtInst.id}`;
    const pc = (link && porkchops[link.id]) || porkchops[linkId] || Object.values(porkchops).find(p => p.sourceBody === srcInst.bodyName && p.targetBody === tgtInst.bodyName);
    if (!pc || !pc.c3DepMatrix || pc.c3DepMatrix.length === 0) {
      if (profiler) profiler.matrixLookupMs += (performance.now() - t0);
      return null;
    }
    legPorkchops.push(pc);
  }

  const P0 = legPorkchops[0];
  const P_last = legPorkchops[legPorkchops.length - 1];

  // Nearest departure row in P0
  let i0 = findClosestDateIndex(P0.depDates, tDep);
  if (i0 < 0) i0 = 0;

  // Nearest arrival col in P_last
  let j_last = findClosestDateIndex(P_last.arrDates, tArr);
  if (j_last < 0) j_last = 0;

  if (profiler) {
    profiler.matrixLookupMs += (performance.now() - t0);
  }

  const P1 = legPorkchops[1];
  const flybyInst = pathInsts[1];
  const flybyBody = bodyMap.get(flybyInst.bodyName)!;
  const minFlybyAltitude = getMinFlybyAlt(flybyBody, flybyInst.minFlybyAltitude);

  const samples: DirectPorkchopFlybySample[] = [];
  const t2 = profiler ? performance.now() : 0;

  // Collect candidate flyby dates across both connecting legs
  const flybyDatesSet = new Set<number>([...P0.arrDates, ...P1.depDates]);
  const sortedFlybyDates = Array.from(flybyDatesSet).sort((a, b) => a - b);

  for (let k = 0; k < sortedFlybyDates.length; k++) {
    const tFlyby = sortedFlybyDates[k];
    const j0 = findClosestDateIndex(P0.arrDates, tFlyby);
    const i1 = findClosestDateIndex(P1.depDates, tFlyby);

    // Hard physical time ordering check
    const dt0 = tFlyby - tDep;
    const dt1 = tArr - tFlyby;
    const isChronologicallyPossible = dt0 >= MIN_LEG_TIME_SECONDS && dt1 >= MIN_LEG_TIME_SECONDS;

    const isP0Phys = P0.physicalValidMatrix ? (P0.physicalValidMatrix[i0]?.[j0] ?? false) : true;
    const isP1Phys = P1.physicalValidMatrix ? (P1.physicalValidMatrix[i1]?.[j_last] ?? false) : true;

    const c3Dep0 = P0.c3DepMatrix?.[i0]?.[j0] ?? 0;
    const c3Arr0 = P0.c3ArrMatrix?.[i0]?.[j0] ?? 0;
    const c3Dep1 = P1.c3DepMatrix?.[i1]?.[j_last] ?? 0;
    const c3Arr1 = P1.c3ArrMatrix?.[i1]?.[j_last] ?? 0;

    const vTransArr0 = P0.vTransArrMatrix?.[i0]?.[j0];
    const vTransDep1 = P1.vTransDepMatrix?.[i1]?.[j_last];

    if (!isChronologicallyPossible || !isP0Phys || !isP1Phys || !vTransArr0 || !vTransDep1 || vecMag(vTransArr0) < 1e-3 || vecMag(vTransDep1) < 1e-3) {
      samples.push({
        j0,
        tFlyby,
        c3DepA: c3Dep0,
        c3ArrB: c3Arr0,
        c3DepB: c3Dep1,
        c3ArrFinal: c3Arr1,
        deflectionAngleDeg: 0,
        maxDeflectionAngleDeg: 0,
        dv: Infinity,
        isValid: false,
        isPhysicallyValid: false,
      });
      continue;
    }

    const stBody = getBodyStateAtUT(flybyBody, mainBody, tFlyby);
    const vInfIn = vecSub(vTransArr0, stBody.vel);
    const vInfOut = vecSub(vTransDep1, stBody.vel);

    const flybyEval = evaluateFlybyAtDate(flybyBody, vInfIn, vInfOut, tFlyby, minFlybyAltitude);
    const dvFinite = Number.isFinite(flybyEval.poweredDv);
    const isPhysValid = isChronologicallyPossible && isP0Phys && isP1Phys && flybyEval.isValid;

    samples.push({
      j0,
      tFlyby,
      c3DepA: c3Dep0,
      c3ArrB: c3Arr0,
      c3DepB: c3Dep1,
      c3ArrFinal: c3Arr1,
      deflectionAngleDeg: flybyEval.deflectionAngleDeg,
      maxDeflectionAngleDeg: flybyEval.maxDeflectionAngleDeg,
      dv: dvFinite ? flybyEval.poweredDv : Infinity,
      isValid: isPhysValid && dvFinite && flybyEval.poweredDv < MAX_ALLOWED_FLYBY_DV_MPS,
      isPhysicallyValid: isPhysValid,
    });
  }

  if (profiler) {
    profiler.candidatePoolingMs += 0;
    profiler.samplingAndPhysicsMs += (performance.now() - t2);
  }

  return samples;
}

/**
 * Evaluates sequence transfer for a pair of departure/arrival dates using precomputed direct transfer porkchops.
 * NO Lambert calculations — parses direct transfer porkchop matrices and evaluates flybys with continuous optimization.
 * Instrumented across 5 distinct execution blocks for live profiling and time tracking.
 */
export function evaluateSequenceTransferFromDirectPorkchops(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  profiler?: SequenceTransferProfiler
): SequenceTransferResult | null {
  const methodStart = profiler ? performance.now() : 0;
  if (profiler) profiler.callsCount++;

  const samples = generateDirectPorkchopFlybySamples(
    pathInsts,
    tDep,
    tArr,
    bodies,
    mainBody,
    porkchops,
    links,
    profiler
  );

  if (!samples || samples.length === 0) {
    if (profiler) profiler.totalMethodMs += (performance.now() - methodStart);
    return null;
  }

  const validSamples = samples.filter(s => s.isValid && (s.isPhysicallyValid !== false));
  if (validSamples.length === 0) {
    if (profiler) profiler.totalMethodMs += (performance.now() - methodStart);
    return {
      c3DepA: { x: Infinity, y: Infinity, z: Infinity },
      c3ArrB: { x: Infinity, y: Infinity, z: Infinity },
      c3DepB: { x: Infinity, y: Infinity, z: Infinity },
      c3ArrFinal: { x: Infinity, y: Infinity, z: Infinity },
      totalDv: Infinity,
      flybyDvs: [Infinity],
      flybyDates: [0],
      flybyC3Arrs: [ { x: 0, y: 0, z: 0 } ],
      flybyC3Deps: [ { x: 0, y: 0, z: 0 } ],
      isPhysicallyValid: false,
      isConstraintValid: false,
    };
  }

  const flybyInst = pathInsts[1];
  const flybyBody : CelestialBody = bodies.find(b => b.name === flybyInst.bodyName)!;
  const minFlybyRadius = getMinFlybyRadius(flybyBody, flybyInst.minFlybyAltitude);
  const muFlyby = flybyBody.stdGravParam;

  // --- BLOCK 4: Local Minima & Zero-Crossing Detection ---
  const t6 = profiler ? performance.now() : 0;

  const M = samples.length;
  const localMinIndices: number[] = [];
  const rootDates: number[] = [];

  for (let k = 0; k < M; k++) {
    if (!samples[k].isValid) continue;

    // Check zero-crossing of C3 (unpowered flyby intersection)
    if (k < M - 1 && samples[k + 1].isValid) {
      const d1 = vecMag(samples[k].c3ArrB) - vecMag(samples[k].c3DepB);
      const d2 = vecMag(samples[k + 1].c3ArrB) - vecMag(samples[k + 1].c3DepB);
      if (d1 * d2 <= 0 && Math.abs(d1 - d2) > 1e-9) {
        const alpha = Math.abs(d1) / (Math.abs(d1) + Math.abs(d2));
        const tRoot = samples[k].tFlyby + alpha * (samples[k + 1].tFlyby - samples[k].tFlyby);
        rootDates.push(tRoot);
      }
    }

    if (k > 0 && k < M - 1) {
      if (samples[k - 1].dv >= samples[k].dv && samples[k + 1].dv >= samples[k].dv) {
        localMinIndices.push(k);
      }
    } else if (k === 0) {
      if (M >= 2 && samples[1].dv >= samples[0].dv) {
        localMinIndices.push(0);
      } else if (M === 1) {
        localMinIndices.push(0);
      }
    } else if (k === M - 1) {
      if (M >= 2 && samples[M - 2].dv >= samples[M - 1].dv) {
        localMinIndices.push(M - 1);
      }
    }
  }

  // Fallback: if no strict local minimum, use global minimum sample
  if (localMinIndices.length === 0 && rootDates.length === 0) {
    let minK = 0;
    let minVal = Infinity;
    for (let k = 0; k < M; k++) {
      if (samples[k].isValid && samples[k].dv < minVal) {
        minVal = samples[k].dv;
        minK = k;
      }
    }
    localMinIndices.push(minK);
  }

  if (profiler) {
    profiler.localMinimaSearchMs += (performance.now() - t6);
  }

  // --- BLOCK 5: Continuous Optimization ---
  const t8 = profiler ? performance.now() : 0;

  const interp = (v1: number, v2: number, alpha: number) => v1 + alpha * (v2 - v1);

  // Continuous evaluator using linear interpolation of sample curves and unified flyby physics
  const evalExtrapolatedAtDate = (t: number) => {
    let s = 0;
    while (s < M - 2 && samples[s + 1].tFlyby <= t) {
      s++;
    }

    const p1 = samples[s];
    const p2 = samples[Math.min(M - 1, s + 1)];
    const dt = p2.tFlyby - p1.tFlyby;
    const alpha = dt > 0 ? Math.max(0, Math.min(1, (t - p1.tFlyby) / dt)) : 0;

    const c3DepA = vecAdd(vecScale(p1.c3DepA, 1-alpha), vecScale(p2.c3DepA, alpha));
    const c3ArrB = vecAdd(vecScale(p1.c3ArrB, 1-alpha), vecScale(p2.c3ArrB, alpha));
    const c3DepB = vecAdd(vecScale(p1.c3DepB, 1-alpha), vecScale(p2.c3DepB, alpha));
    const c3ArrFinal = vecAdd(vecScale(p1.c3ArrFinal, 1-alpha), vecScale(p2.c3ArrFinal, alpha));
    const deflectionAngleDeg = interp(p1.deflectionAngleDeg, p2.deflectionAngleDeg, alpha);
    const maxDeflectionAngleDeg = interp(p1.maxDeflectionAngleDeg, p2.maxDeflectionAngleDeg, alpha);

    let totalDv = Infinity;
    if (Number.isFinite(vecMag(c3ArrB)) && Number.isFinite(vecMag(c3DepB))) {
      const vInfInMag = Math.sqrt(vecMag(c3ArrB) * KM2_S2_TO_M2_S2);
      const vInfOutMag = Math.sqrt(vecMag(c3DepB) * KM2_S2_TO_M2_S2);
      totalDv = computeFlybyPoweredDv(
        vInfInMag,
        vInfOutMag,
        deflectionAngleDeg,
        maxDeflectionAngleDeg,
        muFlyby,
        minFlybyRadius
      );
    }

    return {
      c3DepA: c3DepA,
      c3ArrB: c3ArrB,
      c3DepB: c3DepB,
      c3ArrFinal: c3ArrFinal,
      totalDv: Number.isFinite(totalDv) ? totalDv : Infinity,
      flybyDvs: [Number.isFinite(totalDv) ? totalDv : Infinity],
      flybyDates: [t],
      flybyC3Arrs: [c3ArrB],
      flybyC3Deps: [c3DepB],
    };
  };

  let bestResult: SequenceTransferResult | null = null;
  let bestOverallDv = Infinity;

  const finalizeResult = (res: SequenceTransferResult | null): SequenceTransferResult | null => {
    if (!res) return null;
    const isFreeFlyby = Number.isFinite(res.totalDv) && res.totalDv <= FREE_FLYBY_MAX_DV_MPS;
    return {
      ...res,
      isPhysicallyValid: true,
      isConstraintValid: isFreeFlyby,
    };
  };

  // Seed with discrete valid samples first
  for (const s of validSamples) {
    if (s.dv < bestOverallDv) {
      bestOverallDv = s.dv;
      bestResult = {
        c3DepA: s.c3DepA,
        c3ArrB: s.c3ArrB,
        c3DepB: s.c3DepB,
        c3ArrFinal: s.c3ArrFinal,
        totalDv: s.dv,
        flybyDvs: [s.dv],
        flybyDates: [s.tFlyby],
        flybyC3Arrs: [s.c3ArrB],
        flybyC3Deps: [s.c3DepB],
      };
    }
  }

  // If already zero-cost / unpowered, return immediately
  if (bestOverallDv <= FREE_FLYBY_MAX_DV_MPS && bestResult) {
    if (profiler) {
      profiler.continuousOptimizationMs += (performance.now() - t8);
      profiler.totalMethodMs += (performance.now() - methodStart);
    }
    return finalizeResult(bestResult);
  }

  // First, test exact C3 zero-crossings
  for (const tRoot of rootDates) {
    const res = evalExtrapolatedAtDate(tRoot);
    if (res.totalDv < bestOverallDv) {
      bestOverallDv = res.totalDv;
      bestResult = res;
    }
    if (res.totalDv <= FREE_FLYBY_MAX_DV_MPS) {
      if (profiler) {
        profiler.continuousOptimizationMs += (performance.now() - t8);
        profiler.totalMethodMs += (performance.now() - methodStart);
      }
      return finalizeResult(res);
    }
  }

  // Step 5: Dichotomic (bisection) search for each local minimum
  for (const candIndex of localMinIndices) {
    let a = candIndex > 0 ? samples[candIndex - 1].tFlyby : samples[0].tFlyby;
    let b = candIndex < M - 1 ? samples[candIndex + 1].tFlyby : samples[M - 1].tFlyby;

    let currentBest = evalExtrapolatedAtDate((a + b) / 2);

    let iter = 0;
    while (b - a > DATE_PRECISION_BISECTION_SECONDS && iter < MAX_BISECTION_ITERATIONS) {
      iter++;
      const delta = (b - a) * 0.001;
      const mid = (a + b) / 2;
      const m1 = mid - delta;
      const m2 = mid + delta;

      const res1 = evalExtrapolatedAtDate(m1);
      const res2 = evalExtrapolatedAtDate(m2);

      if (res1.totalDv < currentBest.totalDv) currentBest = res1;
      if (res2.totalDv < currentBest.totalDv) currentBest = res2;

      // Stop early if unpowered free flyby found
      if (res1.totalDv <= FREE_FLYBY_MAX_DV_MPS || res2.totalDv <= FREE_FLYBY_MAX_DV_MPS) {
        break;
      }

      if (res1.totalDv < res2.totalDv) {
        b = m2;
      } else {
        a = m1;
      }
    }

    if (currentBest.totalDv <= FREE_FLYBY_MAX_DV_MPS) {
      if (profiler) {
        profiler.continuousOptimizationMs += (performance.now() - t8);
        profiler.totalMethodMs += (performance.now() - methodStart);
      }
      return finalizeResult(currentBest);
    }

    if (currentBest.totalDv < bestOverallDv) {
      bestOverallDv = currentBest.totalDv;
      bestResult = currentBest;
    }
  }

  if (profiler) {
    profiler.continuousOptimizationMs += (performance.now() - t8);
    profiler.totalMethodMs += (performance.now() - methodStart);
  }
  return finalizeResult(bestResult);
}

export interface HigherOrderFlybySample {
  j0: number;
  tFlyby: number;
  c3DepA: Vector3D;
  c3ArrB: Vector3D;
  c3DepB: Vector3D;
  c3ArrFinal: Vector3D;
  deflectionAngleDeg: number;
  maxDeflectionAngleDeg: number;
  currentDv: number;
  priorCost: number;
  totalDv: number;
  priorFlybyDates: number[];
  priorFlybyDvs: number[];
  priorFlybyC3Arrs?: Vector3D[];
  priorFlybyC3Deps?: Vector3D[];
  isValid: boolean;
  isPhysicallyValid?: boolean;
}

/**
 * Generates the array of candidate flyby samples across the matching date grid for AddLastLeg (N > 3).
 */
export function generateHigherOrderAddLastLegFlybySamples(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  sequencePorkchops: Record<string, SequencePorkchopData> = {},
  profiler?: SequenceTransferProfiler
): HigherOrderFlybySample[] | null {
  if (!pathInsts || !Array.isArray(pathInsts) || pathInsts.length < 4) return null;
  const N = pathInsts.length;

  // Hard Physical constraint: Total flight time must be at least (N-1) legs of 3600s
  if (tArr - tDep < 3600 * (N - 1)) return null;

  const t0 = profiler ? performance.now() : 0;
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // Find the (N-1)-bodies sub-sequence
  const subPath = pathInsts.slice(0, N - 1);
  const subSeqKey = subPath.map(i => i.id).join('-');
  const subSeqId = `seq-pc-${subSeqKey}`;
  const subSeq = sequencePorkchops[subSeqId] || sequencePorkchops[subSeqKey] || Object.values(sequencePorkchops).find(
    s => s.id === subSeqId || s.id === subSeqKey || [s.sourceBody.id, ...s.flybys.map(f => f.instance.id), s.targetBody.id].join('-') === subSeqKey
  );

  if (!subSeq || !subSeq.depDates || !subSeq.arrDates || subSeq.depDates.length === 0 || subSeq.arrDates.length === 0) {
    if (profiler) profiler.matrixLookupMs += (performance.now() - t0);
    return null;
  }

  // Find direct link porkchop for the final leg: Inst_{N-2} -> Inst_{N-1}
  const fbInst = pathInsts[N - 2];
  const tgtInst = pathInsts[N - 1];
  const linkLast = links.find(l => l.sourceInstanceId === fbInst.id && l.targetInstanceId === tgtInst.id);
  const linkLastId = linkLast?.id || `link-${fbInst.id}-${tgtInst.id}`;
  const P_last = porkchops[linkLastId] || (linkLast ? porkchops[linkLast.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === fbInst.bodyName && p.targetBody === tgtInst.bodyName);

  if (!P_last || !P_last.c3DepMatrix || P_last.c3DepMatrix.length === 0) {
    if (profiler) profiler.matrixLookupMs += (performance.now() - t0);
    return null;
  }

  // Find direct link porkchop for the inbound leg to fbInst: Inst_{N-3} -> Inst_{N-2}
  const prevInst = pathInsts[N - 3];
  const linkPrev = links.find(l => l.sourceInstanceId === prevInst.id && l.targetInstanceId === fbInst.id);
  const linkPrevId = linkPrev?.id || `link-${prevInst.id}-${fbInst.id}`;
  const P_prevLeg = porkchops[linkPrevId] || (linkPrev ? porkchops[linkPrev.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === prevInst.bodyName && p.targetBody === fbInst.bodyName);

  // Nearest departure row in subSeq (Inst_0 departure)
  let i0 = findClosestDateIndex(subSeq.depDates, tDep);
  if (i0 < 0) i0 = 0;

  // Nearest arrival col in P_last (Inst_{N-1} arrival)
  let j_last = findClosestDateIndex(P_last.arrDates, tArr);
  if (j_last < 0) j_last = 0;

  const flybyBody = bodyMap.get(fbInst.bodyName)!;
  const minFlybyAltitude = getMinFlybyAlt(flybyBody, fbInst.minFlybyAltitude);

  if (profiler) {
    profiler.matrixLookupMs += (performance.now() - t0);
  }

  const samples: HigherOrderFlybySample[] = [];

  // --- BLOCK 2 & 3: Candidate Sampling & Ephemeris / Physics ---
  const t2 = profiler ? performance.now() : 0;

  const isDirectGridMatch = subSeq.arrDates.length === P_last.depDates.length &&
    subSeq.arrDates.every((val, idx) => val === P_last.depDates[idx]);

  if (!isDirectGridMatch) {
    throw new Error(`Mismatched flyby grid dates between subSeq.arrDates (${subSeq.arrDates.length}) and P_last.depDates (${P_last.depDates.length})`);
  }

  const numCandidates = subSeq.arrDates.length;
  for (let k = 0; k < numCandidates; k++) {
    const tFlyby = subSeq.arrDates[k];
    const j0 = k;
    const i1 = k;

    // Hard physical time ordering check
    const dtLast = tArr - tFlyby;
    const dtTotal = tArr - tDep;
    const isChronologicallyPossible = dtLast >= 3600 && dtTotal >= 3600 * (N - 1) && (tFlyby - tDep) >= 3600 * (N - 2);

    const isSubSeqPhys = subSeq.physicalValidMatrix ? (subSeq.physicalValidMatrix[i0]?.[j0] ?? false) : true;
    const isPLastPhys = P_last.physicalValidMatrix ? (P_last.physicalValidMatrix[i1]?.[j_last] ?? false) : true;

    const c3DepA = subSeq.c3DepMatrix?.[i0]?.[j0] ?? 0;
    const rawC3ArrIn = subSeq.c3ArrMatrix?.[i0]?.[j0] ?? 0;
    const priorCost = subSeq.totalPoweredDvMatrix?.[i0]?.[j0] ?? 0;

    const c3DepOut = P_last.c3DepMatrix?.[i1]?.[j_last] ?? 0;
    const c3ArrFinal = P_last.c3ArrMatrix?.[i1]?.[j_last] ?? 0;
    const vTransDep = P_last.vTransDepMatrix?.[i1]?.[j_last];

    // Extract prior flyby dates, DVs, and C3s
    const priorFlybyDates: number[] = subSeq.flybys && subSeq.flybys.length > 0
      ? subSeq.flybys.map(fb => fb.dateMatrix?.[i0]?.[j0] || 0)
      : [];

    const priorFlybyDvs: number[] = subSeq.flybys && subSeq.flybys.length > 0
      ? subSeq.flybys.map(fb => fb.poweredDvMatrix?.[i0]?.[j0] || 0)
      : [];

    const priorFlybyC3Arrs: Vector3D[] = subSeq.flybys && subSeq.flybys.length > 0
      ? subSeq.flybys.map(fb => fb.c3ArrMatrix?.[i0]?.[j0] || 0)
      : [];

    const priorFlybyC3Deps: Vector3D[] = subSeq.flybys && subSeq.flybys.length > 0
      ? subSeq.flybys.map(fb => fb.c3DepMatrix?.[i0]?.[j0] || 0)
      : [];

    // Obtain inbound velocity vector vTransArr entering flybyBody
    let vTransArr: Vector3D | undefined;
    let c3ArrIn: Vector3D | undefined = rawC3ArrIn;
    if (P_prevLeg && P_prevLeg.vTransArrMatrix) {
      const prevFbDate = priorFlybyDates[priorFlybyDates.length - 1] || 0;
      const i_prev = prevFbDate ? findClosestDateIndex(P_prevLeg.depDates, prevFbDate) : 0;
      const j_prev = k;
      if (i_prev >= 0 && j_prev >= 0) {
        const vt = P_prevLeg.vTransArrMatrix[i_prev]?.[j_prev];
        if (vt && vecMag(vt) > 1e-3 && Number.isFinite(P_prevLeg.c3ArrMatrix?.[i_prev]?.[j_prev])) {
          vTransArr = vt;
          c3ArrIn = P_prevLeg.c3ArrMatrix[i_prev][j_prev];
        }
      }
    }

    if (!vTransArr) {
      const prevFbDate = priorFlybyDates[priorFlybyDates.length - 1] || 0;
      const dtPrev = tFlyby - prevFbDate;
      if (dtPrev > 0) {
        const prevBody = bodyMap.get(prevInst.bodyName)!;
        const stPrev = getBodyStateAtUT(prevBody, mainBody, prevFbDate);
        const stFlyby = getBodyStateAtUT(flybyBody, mainBody, tFlyby);
        const muCentral = mainBody.stdGravParam;
        const lambRes = solveLambert(stPrev.pos, stFlyby.pos, dtPrev, muCentral, true);
        if (lambRes && lambRes.isValid && lambRes.v2 && vecMag(lambRes.v2) > 1e-3) {
          vTransArr = lambRes.v2;
          const vInfIn = vecSub(lambRes.v2, stFlyby.vel);
          c3ArrIn = vecScale(vInfIn, vecMag(vInfIn) / 1e6);
        }
      }
    }

    if (!isChronologicallyPossible || !isSubSeqPhys || !isPLastPhys || !vTransArr || !vTransDep || vecMag(vTransArr) < 1e-3 || vecMag(vTransDep) < 1e-3) {
      samples.push({
        j0,
        tFlyby,
        c3DepA,
        c3ArrB: c3ArrIn ?? 0,
        c3DepB: c3DepOut,
        c3ArrFinal,
        deflectionAngleDeg: 0,
        maxDeflectionAngleDeg: 0,
        currentDv: Infinity,
        priorCost,
        totalDv: Infinity,
        priorFlybyDates,
        priorFlybyDvs,
        priorFlybyC3Arrs,
        priorFlybyC3Deps,
        isValid: false,
        isPhysicallyValid: false,
      });
      continue;
    }

    const stBody = getBodyStateAtUT(flybyBody, mainBody, tFlyby);
    const vInfIn = vecSub(vTransArr, stBody.vel);
    const vInfOut = vecSub(vTransDep, stBody.vel);
    const flybyEval = evaluateFlybyAtDate(flybyBody, vInfIn, vInfOut, tFlyby, minFlybyAltitude);

    const c3ArrInSmooth = c3ArrIn ?? ((vecMag(vInfIn) ** 2) / 1e6);
    const c3DepOutSmooth = c3DepOut ?? ((vecMag(vInfOut) ** 2) / 1e6);

    const dvFinite = Number.isFinite(flybyEval.poweredDv);
    const totalDv = dvFinite && Number.isFinite(priorCost) ? priorCost + flybyEval.poweredDv : Infinity;
    const isPhysValid = isChronologicallyPossible && isSubSeqPhys && isPLastPhys && flybyEval.isValid;

    samples.push({
      j0,
      tFlyby,
      c3DepA,
      c3ArrB: c3ArrInSmooth,
      c3DepB: c3DepOutSmooth,
      c3ArrFinal,
      deflectionAngleDeg: flybyEval.deflectionAngleDeg,
      maxDeflectionAngleDeg: flybyEval.maxDeflectionAngleDeg,
      currentDv: dvFinite ? flybyEval.poweredDv : Infinity,
      priorCost,
      totalDv,
      priorFlybyDates,
      priorFlybyDvs,
      priorFlybyC3Arrs,
      priorFlybyC3Deps,
      isValid: isPhysValid && dvFinite && Number.isFinite(totalDv) && totalDv < 1e6,
      isPhysicallyValid: isPhysValid,
    });
  }

  if (profiler) {
    profiler.candidatePoolingMs += 0;
    profiler.samplingAndPhysicsMs += (performance.now() - t2);
  }

  return samples;
}

/**
 * Evaluates sequence transfer for higher-order sequences (N > 3) by adding a LAST leg (Inst_{N-2} -> Inst_{N-1})
 * to an existing (N-1)-bodies prefix sequence ([Inst_0, ..., Inst_{N-2}]).
 * The transfer cost and arrival C3 at the last flyby body are retrieved from the prefix SequenceTransferData.
 * Continuous optimization and bisection are performed at the last flyby body.
 */
export function evaluateHigherOrderSequenceTransferAddLastLeg(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  sequencePorkchops: Record<string, SequencePorkchopData> = {},
  profiler?: SequenceTransferProfiler
): SequenceTransferResult | null {
  const methodStart = profiler ? performance.now() : 0;
  if (profiler) profiler.callsCount++;

  const samples = generateHigherOrderAddLastLegFlybySamples(
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

  if (!samples || samples.length === 0) {
    if (profiler) profiler.totalMethodMs += (performance.now() - methodStart);
    return null;
  }

  const N = pathInsts.length;
  const validSamples = samples.filter(s => s.isValid && (s.isPhysicallyValid !== false));
  if (validSamples.length === 0) {
    if (profiler) profiler.totalMethodMs += (performance.now() - methodStart);
    return {
      c3DepA: { x: Infinity, y: Infinity, z: Infinity },
      c3ArrFinal: { x: Infinity, y: Infinity, z: Infinity },
      totalDv: Infinity,
      flybyDvs: Array(N - 2).fill(Infinity),
      flybyDates: Array(N - 2).fill(0),
      isPhysicallyValid: false,
      isConstraintValid: false,
    };
  }

  const fbInst = pathInsts[N - 2];
  const flybyBody = bodies.find(b => b.name === fbInst.bodyName)!;
  const minFlybyRadius = getMinFlybyRadius(flybyBody, fbInst.minFlybyAltitude);
  const muFlyby = flybyBody.stdGravParam;

  // --- BLOCK 4: Local Minima & Zero-Crossing Detection ---
  const t6 = profiler ? performance.now() : 0;

  const M = samples.length;
  const localMinIndices: number[] = [];
  const rootDates: number[] = [];

  for (let k = 0; k < M; k++) {
    if (!samples[k].isValid) continue;

    // Check zero-crossing of C3 (unpowered flyby intersection)
    if (k < M - 1 && samples[k + 1].isValid) {
      const d1 = vecMag(samples[k].c3ArrB) - vecMag(samples[k].c3DepB);
      const d2 = vecMag(samples[k + 1].c3ArrB) - vecMag(samples[k + 1].c3DepB);
      if (d1 * d2 <= 0 && Math.abs(d1 - d2) > 1e-9) {
        const alpha = Math.abs(d1) / (Math.abs(d1) + Math.abs(d2));
        const tRoot = samples[k].tFlyby + alpha * (samples[k + 1].tFlyby - samples[k].tFlyby);
        rootDates.push(tRoot);
      }
    }

    if (k > 0 && k < M - 1) {
      if (samples[k - 1].totalDv >= samples[k].totalDv && samples[k + 1].totalDv >= samples[k].totalDv) {
        localMinIndices.push(k);
      }
    } else if (k === 0) {
      if (M >= 2 && samples[1].totalDv >= samples[0].totalDv) {
        localMinIndices.push(0);
      } else if (M === 1) {
        localMinIndices.push(0);
      }
    } else if (k === M - 1) {
      if (M >= 2 && samples[M - 2].totalDv >= samples[M - 1].totalDv) {
        localMinIndices.push(M - 1);
      }
    }
  }

  if (localMinIndices.length === 0 && rootDates.length === 0) {
    let minK = 0;
    let minVal = Infinity;
    for (let k = 0; k < M; k++) {
      if (samples[k].isValid && samples[k].totalDv < minVal) {
        minVal = samples[k].totalDv;
        minK = k;
      }
    }
    localMinIndices.push(minK);
  }

  if (profiler) {
    profiler.localMinimaSearchMs += (performance.now() - t6);
  }

  // --- BLOCK 5: Continuous Optimization ---
  const t8 = profiler ? performance.now() : 0;

  const interp = (v1: number, v2: number, alpha: number) => v1 + alpha * (v2 - v1);

  const evalExtrapolatedAtDate = (t: number) => {
    let s = 0;
    while (s < M - 2 && samples[s + 1].tFlyby <= t) {
      s++;
    }

    const p1 = samples[s];
    const p2 = samples[Math.min(M - 1, s + 1)];
    const dt = p2.tFlyby - p1.tFlyby;
    const alpha = dt > 0 ? Math.max(0, Math.min(1, (t - p1.tFlyby) / dt)) : 0;

    const c3DepA = vecAdd(vecScale(p1.c3DepA, 1-alpha), vecScale(p2.c3DepA, alpha));
    const c3ArrB = vecAdd(vecScale(p1.c3ArrB, 1-alpha), vecScale(p2.c3ArrB, alpha));
    const c3DepB = vecAdd(vecScale(p1.c3DepB, 1-alpha), vecScale(p2.c3DepB, alpha));
    const c3ArrFinal = vecAdd(vecScale(p1.c3ArrFinal, 1-alpha), vecScale(p2.c3ArrFinal, alpha));
    const priorCost = interp(p1.priorCost, p2.priorCost, alpha);
    const deflectionAngleDeg = interp(p1.deflectionAngleDeg, p2.deflectionAngleDeg, alpha);
    const maxDeflectionAngleDeg = interp(p1.maxDeflectionAngleDeg, p2.maxDeflectionAngleDeg, alpha);

    let currentFlybyDv = Infinity;
    if (Number.isFinite(vecMag(c3ArrB)) && Number.isFinite(vecMag(c3DepB))) {
      const vInfInMag = Math.sqrt(vecMag(c3ArrB) * KM2_S2_TO_M2_S2);
      const vInfOutMag = Math.sqrt(vecMag(c3DepB) * KM2_S2_TO_M2_S2);
      currentFlybyDv = computeFlybyPoweredDv(
        vInfInMag,
        vInfOutMag,
        deflectionAngleDeg,
        maxDeflectionAngleDeg,
        muFlyby,
        minFlybyRadius
      );
    }

    const safePriorCost = Number.isFinite(priorCost) ? priorCost : Infinity;
    const safeCurrentDv = Number.isFinite(currentFlybyDv) ? currentFlybyDv : Infinity;
    const totalDv = safePriorCost + safeCurrentDv;

    const interpPriorFlybyDates = p1.priorFlybyDates.map((d1, idx) => {
      const d2 = p2.priorFlybyDates[idx] ?? d1;
      const res = interp(d1, d2, alpha);
      return Number.isFinite(res) ? res : d1;
    });
    const interpPriorFlybyDvs = p1.priorFlybyDvs.map((dv1, idx) => {
      const dv2 = p2.priorFlybyDvs[idx] ?? dv1;
      const res = interp(dv1, dv2, alpha);
      return Number.isFinite(res) ? res : dv1;
    });

    const interpPriorFlybyC3Arrs = (p1.priorFlybyC3Arrs || []).map((c1, idx) => {
      const c2 = (p2.priorFlybyC3Arrs || [])[idx] ?? c1;
      const res = vecAdd(vecScale(c1, 1-alpha), vecScale(c2, alpha));
      return res;
    });
    const interpPriorFlybyC3Deps = (p1.priorFlybyC3Deps || []).map((c1, idx) => {
      const c2 = (p2.priorFlybyC3Deps || [])[idx] ?? c1;
      const res = vecAdd(vecScale(c1, 1-alpha), vecScale(c2, alpha));
      return res;
    });

    return {
      c3DepA: c3DepA,
      c3ArrB: c3ArrB,
      c3DepB: c3DepB,
      c3ArrFinal: c3ArrFinal,
      totalDv: Number.isFinite(totalDv) ? totalDv : Infinity,
      flybyDvs: [...interpPriorFlybyDvs, safeCurrentDv],
      flybyDates: [...interpPriorFlybyDates, t],
      flybyC3Arrs: [...interpPriorFlybyC3Arrs, c3ArrB],
      flybyC3Deps: [...interpPriorFlybyC3Deps, c3DepB],
    };
  };

  let bestResult: SequenceTransferResult | null = null;
  let bestOverallDv = Infinity;

  const finalizeResult = (res: SequenceTransferResult | null): SequenceTransferResult | null => {
    if (!res) return null;
    const isFreeFlyby = Number.isFinite(res.totalDv) && res.totalDv <= 1.0;
    return {
      ...res,
      isPhysicallyValid: true,
      isConstraintValid: isFreeFlyby,
    };
  };

  // First, test exact C3 zero-crossings
  for (const tRoot of rootDates) {
    const res = evalExtrapolatedAtDate(tRoot);
    if (res.totalDv < bestOverallDv) {
      bestOverallDv = res.totalDv;
      bestResult = res;
    }
    if (res.flybyDvs[res.flybyDvs.length - 1] <= 1.0) {
      if (profiler) {
        profiler.continuousOptimizationMs += (performance.now() - t8);
        profiler.totalMethodMs += (performance.now() - methodStart);
      }
      return finalizeResult(res);
    }
  }

  for (const candIndex of localMinIndices) {
    let a = candIndex > 0 ? samples[candIndex - 1].tFlyby : samples[0].tFlyby;
    let b = candIndex < M - 1 ? samples[candIndex + 1].tFlyby : samples[M - 1].tFlyby;

    const datePrecision = 864;
    let currentBest = evalExtrapolatedAtDate((a + b) / 2);

    let iter = 0;
    while (b - a > datePrecision && iter < 30) {
      iter++;
      const delta = (b - a) * 0.001;
      const mid = (a + b) / 2;
      const m1 = mid - delta;
      const m2 = mid + delta;

      const res1 = evalExtrapolatedAtDate(m1);
      const res2 = evalExtrapolatedAtDate(m2);

      if (res1.totalDv < currentBest.totalDv) currentBest = res1;
      if (res2.totalDv < currentBest.totalDv) currentBest = res2;

      if (res1.flybyDvs[res1.flybyDvs.length - 1] <= 1.0 || res2.flybyDvs[res2.flybyDvs.length - 1] <= 1.0) {
        break;
      }

      if (res1.totalDv < res2.totalDv) {
        b = m2;
      } else {
        a = m1;
      }
    }

    if (currentBest.flybyDvs[currentBest.flybyDvs.length - 1] <= 1.0) {
      if (profiler) {
        profiler.continuousOptimizationMs += (performance.now() - t8);
        profiler.totalMethodMs += (performance.now() - methodStart);
      }
      return finalizeResult(currentBest);
    }

    if (currentBest.totalDv < bestOverallDv) {
      bestOverallDv = currentBest.totalDv;
      bestResult = currentBest;
    }
  }

  if (profiler) {
    profiler.continuousOptimizationMs += (performance.now() - t8);
    profiler.totalMethodMs += (performance.now() - methodStart);
  }
  return finalizeResult(bestResult);
}

export interface HigherOrderFirstLegFlybySample {
  j_first: number;
  i_suffix: number;
  tFlyby: number;
  c3DepA: Vector3D;
  c3ArrB: Vector3D;
  c3DepB: Vector3D;
  c3ArrFinal: Vector3D;
  deflectionAngleDeg: number;
  maxDeflectionAngleDeg: number;
  currentDv: number;
  suffixCost: number;
  totalDv: number;
  suffixFlybyDates: number[];
  suffixFlybyDvs: number[];
  suffixFlybyC3Arrs?: Vector3D[];
  suffixFlybyC3Deps?: Vector3D[];
  isPhysicallyValid: boolean;
  isConstraintValid: boolean;
}

/**
 * Generates the array of candidate flyby samples across the matching date grid for AddFirstLeg (N > 3).
 */
export function generateHigherOrderAddFirstLegFlybySamples(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  sequencePorkchops: Record<string, SequencePorkchopData> = {},
  profiler?: SequenceTransferProfiler
): HigherOrderFirstLegFlybySample[] | null {
  if (!pathInsts || !Array.isArray(pathInsts) || pathInsts.length < 4) return null;
  const N = pathInsts.length;

  // Hard Physical constraint: Total flight time must be at least (N-1) legs of 3600s
  if (tArr - tDep < 3600 * (N - 1)) return null;

  const t0 = profiler ? performance.now() : 0;
  const bodyMap = new Map<string, OrbitalBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  // Find the (N-1)-bodies suffix sub-sequence: Inst_1 -> ... -> Inst_{N-1}
  const suffixPath = pathInsts.slice(1, N);
  const suffixKey = suffixPath.map(i => i.id).join('-');
  const suffixSeqId = `seq-pc-${suffixKey}`;
  const suffixSeq = sequencePorkchops[suffixSeqId] || sequencePorkchops[suffixKey] || Object.values(sequencePorkchops).find(
    s => s.id === suffixSeqId || s.id === suffixKey || [s.sourceBody.id, ...s.flybys.map(f => f.instance.id), s.targetBody.id].join('-') === suffixKey
  );

  if (!suffixSeq || !suffixSeq.depDates || !suffixSeq.arrDates || suffixSeq.depDates.length === 0 || suffixSeq.arrDates.length === 0) {
    if (profiler) profiler.matrixLookupMs += (performance.now() - t0);
    return null;
  }

  // Find direct link porkchop for the initial leg: Inst_0 -> Inst_1
  const srcInst = pathInsts[0];
  const fbInst = pathInsts[1];
  const linkFirst = links.find(l => l.sourceInstanceId === srcInst.id && l.targetInstanceId === fbInst.id);
  const linkFirstId = linkFirst?.id || `link-${srcInst.id}-${fbInst.id}`;
  const P_first = porkchops[linkFirstId] || (linkFirst ? porkchops[linkFirst.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === srcInst.bodyName && p.targetBody === fbInst.bodyName);

  if (!P_first || !P_first.c3ArrMatrix || P_first.c3ArrMatrix.length === 0) {
    if (profiler) profiler.matrixLookupMs += (performance.now() - t0);
    return null;
  }

  // Find direct link porkchop for the outbound leg from fbInst: Inst_1 -> Inst_2
  const nextInst = pathInsts[2];
  const linkNext = links.find(l => l.sourceInstanceId === fbInst.id && l.targetInstanceId === nextInst.id);
  const linkNextId = linkNext?.id || `link-${fbInst.id}-${nextInst.id}`;
  const P_nextLeg = porkchops[linkNextId] || (linkNext ? porkchops[linkNext.id] : undefined) || Object.values(porkchops).find(p => p.sourceBody === fbInst.bodyName && p.targetBody === nextInst.bodyName);

  // Nearest departure row in P_first (Inst_0 departure)
  let i_first = findClosestDateIndex(P_first.depDates, tDep);
  if (i_first < 0) i_first = 0;

  // Nearest arrival col in suffixSeq (Inst_{N-1} arrival)
  let j_suffix = findClosestDateIndex(suffixSeq.arrDates, tArr);
  if (j_suffix < 0) j_suffix = 0;

  const flybyBody = bodyMap.get(fbInst.bodyName)!;
  const minFlybyAltitude = getMinFlybyAlt(flybyBody, fbInst.minFlybyAltitude);

  if (profiler) {
    profiler.matrixLookupMs += (performance.now() - t0);
  }

  const samples: HigherOrderFirstLegFlybySample[] = [];

  // --- BLOCK 2 & 3: Candidate Sampling & Ephemeris / Physics ---
  const t2 = profiler ? performance.now() : 0;

  const isDirectGridMatch = P_first.arrDates.length === suffixSeq.depDates.length &&
    P_first.arrDates.every((val, idx) => val === suffixSeq.depDates[idx]);

  if (!isDirectGridMatch) {
    throw new Error(`Mismatched flyby grid dates between P_first.arrDates (${P_first.arrDates.length}) and suffixSeq.depDates (${suffixSeq.depDates.length})`);
  }

  const numCandidates = P_first.arrDates.length;
  for (let k = 0; k < numCandidates; k++) {
    const tFlyby = P_first.arrDates[k];
    const j0 = k;
    const i1 = k;

    // Hard physical time ordering check
    const dtFirst = tFlyby - tDep;
    const dtTotal = tArr - tDep;
    const isChronologicallyPossible = dtFirst >= 3600 && dtTotal >= 3600 * (N - 1) && (tArr - tFlyby) >= 3600 * (N - 2);

    const isPFirstPhys = P_first.physicalValidMatrix ? (P_first.physicalValidMatrix[i_first]?.[j0] ?? false) : true;
    const isPFirstConstraint = P_first.constraintValidMatrix ? (P_first.constraintValidMatrix[i_first]?.[j0] ?? false) : isPFirstPhys;
    const isSuffixPhys = suffixSeq.physicalValidMatrix ? (suffixSeq.physicalValidMatrix[i1]?.[j_suffix] ?? false) : true;
    const isSuffixConstraint = suffixSeq.constraintValidMatrix ? (suffixSeq.constraintValidMatrix[i1]?.[j_suffix] ?? false) : isSuffixPhys;

    const c3DepA = P_first.c3DepMatrix?.[i_first]?.[j0] ?? 0;
    const c3ArrIn = P_first.c3ArrMatrix?.[i_first]?.[j0] ?? 0;
    const vTransArr: Vector3D | undefined = P_first.vTransArrMatrix?.[i_first]?.[j0];

    const rawC3DepOut = suffixSeq.c3DepMatrix?.[i1]?.[j_suffix] ?? 0;
    const c3ArrFinal = suffixSeq.c3ArrMatrix?.[i1]?.[j_suffix] ?? 0;
    const suffixCost = suffixSeq.totalPoweredDvMatrix?.[i1]?.[j_suffix] ?? 0;

    // Extract suffix flyby dates, DVs, and C3s (for Inst_2, ..., Inst_{N-2})
    const suffixFlybyDates: number[] = suffixSeq.flybys && suffixSeq.flybys.length > 0
      ? suffixSeq.flybys.map(fb => fb.dateMatrix?.[i1]?.[j_suffix] || 0)
      : [];

    const suffixFlybyDvs: number[] = suffixSeq.flybys && suffixSeq.flybys.length > 0
      ? suffixSeq.flybys.map(fb => fb.poweredDvMatrix?.[i1]?.[j_suffix] || 0)
      : [];

    const suffixFlybyC3Arrs: Vector3D[] = suffixSeq.flybys && suffixSeq.flybys.length > 0
      ? suffixSeq.flybys.map(fb => fb.c3ArrMatrix?.[i1]?.[j_suffix] || 0)
      : [];

    const suffixFlybyC3Deps: Vector3D[] = suffixSeq.flybys && suffixSeq.flybys.length > 0
      ? suffixSeq.flybys.map(fb => fb.c3DepMatrix?.[i1]?.[j_suffix] || 0)
      : [];

    // Obtain outbound velocity vector vTransDep exiting flybyBody (Inst_1)
    let vTransDep: Vector3D | undefined;
    let c3DepOut: Vector3D | undefined = rawC3DepOut;
    if (P_nextLeg && P_nextLeg.vTransDepMatrix) {
      const nextFbDate = suffixFlybyDates[0] || (suffixSeq.arrDates[j_suffix] || 0);
      const i_next = k; // Direct index on P_nextLeg.depDates (same instance)
      const j_next = nextFbDate ? findClosestDateIndex(P_nextLeg.arrDates, nextFbDate) : 0;
      if (i_next >= 0 && j_next >= 0) {
        const vt = P_nextLeg.vTransDepMatrix[i_next]?.[j_next];
        if (vt && vecMag(vt) > 1e-3 && Number.isFinite(P_nextLeg.c3DepMatrix?.[i_next]?.[j_next])) {
          vTransDep = vt;
          c3DepOut = P_nextLeg.c3DepMatrix[i_next][j_next];
        }
      }
    }

    if (!vTransDep) {
      const nextFbDate = suffixFlybyDates[0] || (suffixSeq.arrDates[j_suffix] || 0);
      const dtNext = nextFbDate - tFlyby;
      if (dtNext > 0) {
        const nextBody = bodyMap.get(nextInst.bodyName)!;
        const stFlyby = getBodyStateAtUT(flybyBody, mainBody, tFlyby);
        const stNext = getBodyStateAtUT(nextBody, mainBody, nextFbDate);
        const muCentral = mainBody.stdGravParam;
        const lambRes = solveLambert(stFlyby.pos, stNext.pos, dtNext, muCentral, true);
        if (lambRes && lambRes.isValid && lambRes.v1 && vecMag(lambRes.v1) > 1e-3) {
          vTransDep = lambRes.v1;
          const vInfOut = vecSub(lambRes.v1, stFlyby.vel);
          c3DepOut = vecScale(vInfOut, vecMag(vInfOut) / 1e6);
        }
      }
    }

    if (!isChronologicallyPossible || !isPFirstPhys || !isSuffixPhys || !vTransArr || !vTransDep || vecMag(vTransArr) < 1e-3 || vecMag(vTransDep) < 1e-3) {
      samples.push({
        j_first: j0,
        i_suffix: i1,
        tFlyby,
        c3DepA,
        c3ArrB: c3ArrIn,
        c3DepB: c3DepOut ?? 0,
        c3ArrFinal,
        deflectionAngleDeg: 0,
        maxDeflectionAngleDeg: 0,
        currentDv: Infinity,
        suffixCost,
        totalDv: Infinity,
        suffixFlybyDates,
        suffixFlybyDvs,
        suffixFlybyC3Arrs,
        suffixFlybyC3Deps,
        isPhysicallyValid: false,
        isConstraintValid: false,
      });
      continue;
    }

    const stBody = getBodyStateAtUT(flybyBody, mainBody, tFlyby);
    const vInfIn = vecSub(vTransArr, stBody.vel);
    const vInfOut = vecSub(vTransDep, stBody.vel);
    const flybyEval = evaluateFlybyAtDate(flybyBody, vInfIn, vInfOut, tFlyby, minFlybyAltitude);

    const c3ArrInSmooth = c3ArrIn ?? ((vecMag(vInfIn) ** 2) / 1e6);
    const c3DepOutSmooth = c3DepOut ?? ((vecMag(vInfOut) ** 2) / 1e6);

    const dvFinite = Number.isFinite(flybyEval.poweredDv);
    const totalDv = dvFinite && Number.isFinite(suffixCost) ? suffixCost + flybyEval.poweredDv : Infinity;
    const isPhysValid = isChronologicallyPossible && isPFirstPhys && isSuffixPhys && flybyEval.isValid;
    const isConstraintValid = isPhysValid && isPFirstConstraint && isSuffixConstraint && dvFinite && flybyEval.poweredDv <= 1.0;

    samples.push({
      j_first: j0,
      i_suffix: i1,
      tFlyby,
      c3DepA,
      c3ArrB: c3ArrInSmooth,
      c3DepB: c3DepOutSmooth,
      c3ArrFinal,
      deflectionAngleDeg: flybyEval.deflectionAngleDeg,
      maxDeflectionAngleDeg: flybyEval.maxDeflectionAngleDeg,
      currentDv: dvFinite ? flybyEval.poweredDv : Infinity,
      suffixCost,
      totalDv,
      suffixFlybyDates,
      suffixFlybyDvs,
      suffixFlybyC3Arrs,
      suffixFlybyC3Deps,
      isPhysicallyValid: isPhysValid,
      isConstraintValid,
    });
  }

  if (profiler) {
    profiler.candidatePoolingMs += 0;
    profiler.samplingAndPhysicsMs += (performance.now() - t2);
  }

  return samples;
}

/**
 * Evaluates sequence transfer for higher-order sequences (N > 3) by adding a FIRST leg (Inst_0 -> Inst_1)
 * to an existing (N-1)-bodies suffix sequence ([Inst_1, ..., Inst_{N-1}]).
 * The transfer cost and departure C3 at the first flyby body are retrieved from the suffix SequenceTransferData.
 * Continuous optimization and bisection are performed at the first flyby body (Inst_1).
 */
export function evaluateHigherOrderSequenceTransferAddFirstLeg(
  pathInsts: InstanceNode[],
  tDep: number,
  tArr: number,
  bodies: OrbitalBody[],
  mainBody: CelestialBody,
  porkchops: Record<string, PorkchopPlotData> = {},
  links: DirectionalLink[] = [],
  sequencePorkchops: Record<string, SequencePorkchopData> = {},
  profiler?: SequenceTransferProfiler
): SequenceTransferResult | null {
  const methodStart = profiler ? performance.now() : 0;
  if (profiler) profiler.callsCount++;

  const samples = generateHigherOrderAddFirstLegFlybySamples(
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

  if (!samples || samples.length === 0) {
    if (profiler) profiler.totalMethodMs += (performance.now() - methodStart);
    return null;
  }

  const N = pathInsts.length;
  const physicallyValidSamples = samples.filter(s => s.isPhysicallyValid);
  if (physicallyValidSamples.length === 0) {
    if (profiler) profiler.totalMethodMs += (performance.now() - methodStart);
    return {
      c3DepA: {x: Infinity, y: Infinity, z: Infinity},
      c3ArrFinal: {x: Infinity, y: Infinity, z: Infinity},
      totalDv: Infinity,
      flybyDvs: Array(N - 2).fill(Infinity),
      flybyDates: Array(N - 2).fill(0),
      isPhysicallyValid: false,
      isConstraintValid: false,
    };
  }

  const fbInst = pathInsts[1];
  const flybyBody = bodies.find(b => b.name === fbInst.bodyName)!;
  const minFlybyRadius = getMinFlybyRadius(flybyBody, fbInst.minFlybyAltitude);
  const muFlyby = flybyBody.stdGravParam;

  // --- BLOCK 4: Local Minima & Zero-Crossing Detection ---
  const t6 = profiler ? performance.now() : 0;

  const M = samples.length;
  const localMinIndices: number[] = [];
  const rootDates: number[] = [];

  for (let k = 0; k < M; k++) {
    if (!samples[k].isPhysicallyValid) continue;

    // Check zero-crossing of C3 (unpowered flyby intersection)
    if (k < M - 1 && samples[k + 1].isPhysicallyValid) {
      const d1 = vecMag(samples[k].c3ArrB) - vecMag(samples[k].c3DepB);
      const d2 = vecMag(samples[k + 1].c3ArrB) - vecMag(samples[k + 1].c3DepB);
      if (d1 * d2 <= 0 && Math.abs(d1 - d2) > 1e-9) {
        const alpha = Math.abs(d1) / (Math.abs(d1) + Math.abs(d2));
        const tRoot = samples[k].tFlyby + alpha * (samples[k + 1].tFlyby - samples[k].tFlyby);
        rootDates.push(tRoot);
      }
    }

    if (k > 0 && k < M - 1) {
      if (samples[k - 1].totalDv >= samples[k].totalDv && samples[k + 1].totalDv >= samples[k].totalDv) {
        localMinIndices.push(k);
      }
    } else if (k === 0) {
      if (M >= 2 && samples[1].totalDv >= samples[0].totalDv) {
        localMinIndices.push(0);
      } else if (M === 1) {
        localMinIndices.push(0);
      }
    } else if (k === M - 1) {
      if (M >= 2 && samples[M - 2].totalDv >= samples[M - 1].totalDv) {
        localMinIndices.push(M - 1);
      }
    }
  }

  if (localMinIndices.length === 0 && rootDates.length === 0) {
    let minK = 0;
    let minVal = Infinity;
    for (let k = 0; k < M; k++) {
      if (samples[k].isPhysicallyValid && samples[k].totalDv < minVal) {
        minVal = samples[k].totalDv;
        minK = k;
      }
    }
    localMinIndices.push(minK);
  }

  if (profiler) {
    profiler.localMinimaSearchMs += (performance.now() - t6);
  }

  // --- BLOCK 5: Continuous Optimization ---
  const t8 = profiler ? performance.now() : 0;

  const interp = (v1: number, v2: number, alpha: number) => v1 + alpha * (v2 - v1);

  const evalExtrapolatedAtDate = (t: number) => {
    let s = 0;
    while (s < M - 2 && samples[s + 1].tFlyby <= t) {
      s++;
    }

    const p1 = samples[s];
    const p2 = samples[Math.min(M - 1, s + 1)];
    const dt = p2.tFlyby - p1.tFlyby;
    const alpha = dt > 0 ? Math.max(0, Math.min(1, (t - p1.tFlyby) / dt)) : 0;

    const c3DepA = vecAdd(vecScale(p1.c3DepA, 1-alpha), vecScale(p2.c3DepA, alpha));
    const c3ArrB = vecAdd(vecScale(p1.c3ArrB, 1-alpha), vecScale(p2.c3ArrB, alpha));
    const c3DepB = vecAdd(vecScale(p1.c3DepB, 1-alpha), vecScale(p2.c3DepB, alpha));
    const c3ArrFinal = vecAdd(vecScale(p1.c3ArrFinal, 1-alpha), vecScale(p2.c3ArrFinal, alpha));
    const suffixCost = interp(p1.suffixCost, p2.suffixCost, alpha);
    const deflectionAngleDeg = interp(p1.deflectionAngleDeg, p2.deflectionAngleDeg, alpha);
    const maxDeflectionAngleDeg = interp(p1.maxDeflectionAngleDeg, p2.maxDeflectionAngleDeg, alpha);

    let currentFlybyDv = Infinity;
    if (Number.isFinite(vecMag(c3ArrB)) && Number.isFinite(vecMag(c3DepB))) {
      const vInfInMag = Math.sqrt(vecMag(c3ArrB) * KM2_S2_TO_M2_S2);
      const vInfOutMag = Math.sqrt(vecMag(c3DepB) * KM2_S2_TO_M2_S2);
      currentFlybyDv = computeFlybyPoweredDv(
        vInfInMag,
        vInfOutMag,
        deflectionAngleDeg,
        maxDeflectionAngleDeg,
        muFlyby,
        minFlybyRadius
      );
    }

    const safeSuffixCost = Number.isFinite(suffixCost) ? suffixCost : Infinity;
    const safeCurrentDv = Number.isFinite(currentFlybyDv) ? currentFlybyDv : Infinity;
    const totalDv = safeSuffixCost + safeCurrentDv;

    const interpSuffixFlybyDates = p1.suffixFlybyDates.map((d1, idx) => {
      const d2 = p2.suffixFlybyDates[idx] ?? d1;
      const res = interp(d1, d2, alpha);
      return Number.isFinite(res) ? res : d1;
    });
    const interpSuffixFlybyDvs = p1.suffixFlybyDvs.map((dv1, idx) => {
      const dv2 = p2.suffixFlybyDvs[idx] ?? dv1;
      const res = interp(dv1, dv2, alpha);
      return Number.isFinite(res) ? res : dv1;
    });

    const interpSuffixFlybyC3Arrs = (p1.suffixFlybyC3Arrs || []).map((c1, idx) => {
      const c2 = (p2.suffixFlybyC3Arrs || [])[idx] ?? c1;
      const res = vecAdd(vecScale(c1, 1-alpha), vecScale(c2, alpha));
      return res;
    });
    const interpSuffixFlybyC3Deps = (p1.suffixFlybyC3Deps || []).map((c1, idx) => {
      const c2 = (p2.suffixFlybyC3Deps || [])[idx] ?? c1;
      const res = vecAdd(vecScale(c1, 1-alpha), vecScale(c2, alpha));
      return res;
    });

    return {
      c3DepA: c3DepA,
      c3ArrB: c3ArrB,
      c3DepB: c3DepB,
      c3ArrFinal: c3ArrFinal,
      totalDv: Number.isFinite(totalDv) ? totalDv : Infinity,
      flybyDvs: [safeCurrentDv, ...interpSuffixFlybyDvs],
      flybyDates: [t, ...interpSuffixFlybyDates],
      flybyC3Arrs: [c3ArrB, ...interpSuffixFlybyC3Arrs],
      flybyC3Deps: [c3DepB, ...interpSuffixFlybyC3Deps],
    };
  };

  let bestResult: SequenceTransferResult | null = null;
  let bestOverallDv = Infinity;

  const finalizeResult = (res: SequenceTransferResult | null): SequenceTransferResult | null => {
    if (!res) return null;
    const isFreeFlyby = Number.isFinite(res.totalDv) && res.totalDv <= 1.0;
    return {
      ...res,
      isPhysicallyValid: true,
      isConstraintValid: isFreeFlyby,
    };
  };

  // First, test exact C3 zero-crossings
  for (const tRoot of rootDates) {
    const res = evalExtrapolatedAtDate(tRoot);
    if (res.totalDv < bestOverallDv) {
      bestOverallDv = res.totalDv;
      bestResult = res;
    }
    if (res.flybyDvs[0] <= 1.0) {
      if (profiler) {
        profiler.continuousOptimizationMs += (performance.now() - t8);
        profiler.totalMethodMs += (performance.now() - methodStart);
      }
      return finalizeResult(res);
    }
  }

  for (const candIndex of localMinIndices) {
    let a = candIndex > 0 ? samples[candIndex - 1].tFlyby : samples[0].tFlyby;
    let b = candIndex < M - 1 ? samples[candIndex + 1].tFlyby : samples[M - 1].tFlyby;

    const datePrecision = 864;
    let currentBest = evalExtrapolatedAtDate((a + b) / 2);

    let iter = 0;
    while (b - a > datePrecision && iter < 30) {
      iter++;
      const delta = (b - a) * 0.001;
      const mid = (a + b) / 2;
      const m1 = mid - delta;
      const m2 = mid + delta;

      const res1 = evalExtrapolatedAtDate(m1);
      const res2 = evalExtrapolatedAtDate(m2);

      if (res1.totalDv < currentBest.totalDv) currentBest = res1;
      if (res2.totalDv < currentBest.totalDv) currentBest = res2;

      if (res1.flybyDvs[0] <= 1.0 || res2.flybyDvs[0] <= 1.0) {
        break;
      }

      if (res1.totalDv < res2.totalDv) {
        b = m2;
      } else {
        a = m1;
      }
    }

    if (currentBest.flybyDvs[0] <= 1.0) {
      if (profiler) {
        profiler.continuousOptimizationMs += (performance.now() - t8);
        profiler.totalMethodMs += (performance.now() - methodStart);
      }
      return finalizeResult(currentBest);
    }

    if (currentBest.totalDv < bestOverallDv) {
      bestOverallDv = currentBest.totalDv;
      bestResult = currentBest;
    }
  }

  if (profiler) {
    profiler.continuousOptimizationMs += (performance.now() - t8);
    profiler.totalMethodMs += (performance.now() - methodStart);
  }
  return finalizeResult(bestResult);
}

