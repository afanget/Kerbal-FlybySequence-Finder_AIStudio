/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CelestialBody, FlybyDetail, FlyableSequenceResult, PorkchopPlotData, DirectionalLink, InstanceNode } from '../types';
import { Vector3D, vecSub, vecMag, vecDot, getGravitationalParameter, getBodyStateAtUT } from './kepler';
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

const maxdC3inUnpoweredFlyby = 100*100; // if C3 are less than 20m/s different, the flyby is considered unpowered as this manouver
// can be considered as a correction during prior or after the flyby
const factorRpForNoDeflexion = 100; // TODO should put SOIradius instead of rpmin*100

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
  const mu = getGravitationalParameter(body);
  const R = body.radius || 100000;
  const minAlt = getMinFlybyAlt(body, minFlybyAltOverride);
  const rpMin = R + minAlt;

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
      flybyMargin: -minAlt,
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
  const isVInfMatched = deltaC3 < maxdC3inUnpoweredFlyby || Math.abs(vInMag - vOutMag) < 1.0;

  if (isVInfMatched && deflectionRad <= maxDeflectionTotalRad + 1e-4) {
    const sinHalf = Math.sin(deflectionRad / 2);
    const avgVInfSq = (vInMag * vInMag + vOutMag * vOutMag) / 2;
    if (sinHalf > 1e-6) {
      rp = (mu / avgVInfSq) * (1 / sinHalf - 1);
    } else {
      rp = rpMin * factorRpForNoDeflexion;
    }
  }

  rp = Math.max(rpMin, rp);
  const periapsisAlt = rp - R;
  const flybyMargin = periapsisAlt - minAlt;

  // Periapsis velocities on inbound and outbound hyperbolas
  const vpIn = Math.sqrt(vInMag * vInMag + (2 * mu) / rp);
  const vpOut = Math.sqrt(vOutMag * vOutMag + (2 * mu) / rp);

  // Deflection provided by the orbit geometry at periapsis rp
  const e1 = 1 + (rp * vInMag * vInMag) / Math.max(1, mu);
  const e2 = 1 + (rp * vOutMag * vOutMag) / Math.max(1, mu);
  const delta1 = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / e1)));
  const delta2 = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / e2)));
  const deltaTotalPrv = (delta1 + delta2) / 2;

  const excessAngle = Math.max(0, deflectionRad - deltaTotalPrv);

  // Powered delta-V required at periapsis
  let poweredDv = Math.abs(vpOut - vpIn);
  if (excessAngle > 1e-5) {
    poweredDv = Math.sqrt(vpIn * vpIn + vpOut * vpOut - 2 * vpIn * vpOut * Math.cos(excessAngle));
  }

  // If vInf is matched within maxdC3inUnpoweredFlyby m²/s² and body can deflect enough, no powered maneuver is required
  if (isVInfMatched && deflectionRad <= maxDeflectionTotalRad + 1e-4) {
    poweredDv = 0;
  }

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
 * Helper to compute minimum safe flyby altitude above body surface (m).
 */
export function getMinFlybyAlt(body: CelestialBody, minFlybyAlt?: number): number {
  if (minFlybyAlt !== undefined) return minFlybyAlt;
  const atm = body.atmosphereHeight || 0;
  return atm > 0 ? atm + 10000 : 10000;
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

  const mu = getGravitationalParameter(body);
  const R = body.radius || 100000;
  const minAlt = getMinFlybyAlt(body);
  const rpMin = R + minAlt;
  const rpNom = Math.max(rpMin, R + periapsisAlt);

  const eNom = 1 + (rpNom * vInfInMag * vInfInMag) / Math.max(1, mu);
  const deflectionRadNom = 2 * Math.asin(Math.max(-1, Math.min(1, 1 / eNom)));

  const rpPert = Math.max(R + 1000, rpNom - altErr);
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
  body: CelestialBody | undefined,
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
  body: CelestialBody | undefined,
  stochasticAltError?: number,
  stochasticVelError?: number
): StochasticDvDebugInfo {
  const altErr = stochasticAltError ?? DEFAULT_STOCHASTIC_ALT_ERROR;
  const velErr = stochasticVelError ?? DEFAULT_STOCHASTIC_VEL_ERROR;
  const mu = body ? getGravitationalParameter(body) : 0;
  const R = body?.radius || 100000;

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
  const mu = getGravitationalParameter(body);
  const R = body.radius || 100000;
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

  if (deltaC3_1 >= maxdC3inUnpoweredFlyby) {
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
    rpRequired = rpMin * factorRpForNoDeflexion;
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
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  stochasticAltError: number,
  stochasticVelError: number,
  flybyBodyDateSampling = 86400,
  porkchops?: Record<string, PorkchopPlotData>,
  links?: DirectionalLink[],
  instances?: InstanceNode[]
): SequentialFlybyDebugInfo[] {
  const debugInfos: SequentialFlybyDebugInfo[] = [];
  const bodyMap = new Map<string, CelestialBody>(bodies.map(b => [b.name, b]));

  if (!seq.transfers || seq.transfers.length === 0) return debugInfos;

  // Flybys occur at intermediate bodies (index 1 to bodyNames.length - 2)
  for (let k = 1; k < seq.bodyNames.length - 1; k++) {
    const bodyName = seq.bodyNames[k];
    const flybyBody = bodyMap.get(bodyName) || mainBody;

    const trIn = seq.transfers[k - 1];
    const trOut = seq.transfers[k];

    if (!trIn || !trOut) continue;

    const tPrev = trIn.arrDate;
    const stPrev1 = getBodyStateAtUT(flybyBody, mainBody, tPrev);

    const vTransIn1: Vector3D = { x: trIn.vTransArr[0], y: trIn.vTransArr[1], z: trIn.vTransArr[2] };
    const vTransOut1: Vector3D = { x: trOut.vTransDep[0], y: trOut.vTransDep[1], z: trOut.vTransDep[2] };

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

    const minFlybyAlt = flybyInst?.minFlybyRadius;

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
