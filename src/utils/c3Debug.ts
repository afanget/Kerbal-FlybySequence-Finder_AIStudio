/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { InstanceNode, DirectionalLink, CelestialBody } from '../types';
import { computeTisserandEnvelopes } from '../physics/solver';

export interface VInfSampleEvaluation {
  vInfMs: number;
  vInfKms: number;
  c3: number;
  deltaMaxDeg: number;
  theta1MinDeg: number;
  theta1MaxDeg: number;
  theta2MinDeg: number;
  theta2MaxDeg: number;
  reqDeflectionDeg: number;
  deficitDeg: number;
  isValid: boolean;
  poweredDvMs: number;
  rejectionReason?: string;
}

export interface LinkNeighborDetail {
  linkId: string;
  neighborInstanceId: string;
  neighborBodyName: string;
  neighborEnvelope: { minMs: number; maxMs: number; minC3: number; maxC3: number };
  direction: 'inbound' | 'outbound';
}

export interface C3DebugCalculationDetails {
  instance: InstanceNode;
  body: CelestialBody;
  mainBody: CelestialBody;
  isSource: boolean;
  isPureFlyby: boolean;
  isTarget: boolean;
  minFlybyRadiusM: number;
  minFlybyAltitudeKm: number;
  userMaxC3?: number;
  vInf5DegMs: number;
  c3_5Deg: number;
  finalMinMs: number;
  finalMaxMs: number;
  finalMinC3: number;
  finalMaxC3: number;
  inboundNeighbors: LinkNeighborDetail[];
  outboundNeighbors: LinkNeighborDetail[];
  samples: VInfSampleEvaluation[];
  explanation: {
    title: string;
    summary: string;
    whyMinIsHighOrLow: string;
    directVsFlybyDifference: string;
    recommendation: string;
  };
}

/**
 * Calculates pump angle intersection theta for two bodies in Tisserand (r_p, E) space
 */
function getTisserandIntersectionTheta(
  bodyA: CelestialBody,
  vInfA: number,
  bodyB: CelestialBody,
  vInfB: number,
  mu_main: number
): { thetaA: number; thetaB: number } | null {
  const aA = bodyA.semiMajorAxis;
  const aB = bodyB.semiMajorAxis;

  if (Math.abs(aA - aB) < 1e-3) {
    if (Math.abs(vInfA - vInfB) < 1e-3) {
      return { thetaA: 0, thetaB: 0 };
    }
    return null;
  }

  const v_pA = Math.sqrt(mu_main / aA);
  const v_pB = Math.sqrt(mu_main / aB);

  const A1 = v_pA * vInfA;
  const B1 = -v_pB * vInfB;
  const C1 = (mu_main / (2 * aA)) - (mu_main / (2 * aB)) + 0.5 * vInfB * vInfB - 0.5 * vInfA * vInfA;

  const A2 = aA * vInfA;
  const B2 = -aB * vInfB;
  const C2 = Math.sqrt(mu_main * aB) - Math.sqrt(mu_main * aA);

  const D = A1 * B2 - A2 * B1;
  if (Math.abs(D) < 1e-9) return null;

  const xA = (C1 * B2 - C2 * B1) / D;
  const xB = (A1 * C2 - A2 * C1) / D;

  if (xA < -1 - 1e-5 || xA > 1 + 1e-5) return null;
  if (xB < -1 - 1e-5 || xB > 1 + 1e-5) return null;

  const clampedXA = Math.max(-1, Math.min(1, xA));
  const clampedXB = Math.max(-1, Math.min(1, xB));

  const thetaA = Math.acos(clampedXA);
  const thetaB = Math.acos(clampedXB);

  const thetaAMax = vInfA >= v_pA ? Math.acos(-v_pA / vInfA) : Math.PI;
  const thetaBMax = vInfB >= v_pB ? Math.acos(-v_pB / vInfB) : Math.PI;

  if (thetaA > thetaAMax + 1e-4) return null;
  if (thetaB > thetaBMax + 1e-4) return null;

  return { thetaA, thetaB };
}

/**
 * Evaluates single v_inf value for an instance node against its inbound and outbound links.
 */
export function evaluateSingleVInfForInstance(
  inst: InstanceNode,
  vInfMs: number,
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody,
  envelopes: Record<string, { minMs: number; maxMs: number }>
): VInfSampleEvaluation {
  const bodyMap = new Map<string, CelestialBody>();
  bodies.forEach(b => bodyMap.set(b.name, b));

  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const body = bodyMap.get(inst.bodyName);
  const mu_main = mainBody.stdGravParam || 1.32712440018e20;

  const vInfKms = vInfMs / 1000;
  const c3 = vInfKms * vInfKms;

  if (!body) {
    return {
      vInfMs,
      vInfKms,
      c3,
      deltaMaxDeg: 0,
      theta1MinDeg: 0,
      theta1MaxDeg: 0,
      theta2MinDeg: 0,
      theta2MaxDeg: 0,
      reqDeflectionDeg: 0,
      deficitDeg: 0,
      isValid: false,
      poweredDvMs: 0,
      rejectionReason: 'Body not found in database',
    };
  }

  const mu_b = body.stdGravParam;
  const R_b = body.radius;
  let minAlt = inst.minFlybyRadius !== undefined ? inst.minFlybyRadius : (body.atmosphereHeight || 10000);
  const r_p_min = R_b + minAlt;

  // Maximum gravitational turning angle at this excess velocity
  const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (r_p_min * vInfMs * vInfMs) / mu_b)));
  const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);
  const deltaMaxDeg = (deltaMaxRad * 180) / Math.PI;

  const inLinks = links.filter(l => l.targetInstanceId === inst.id);
  const outLinks = links.filter(l => l.sourceInstanceId === inst.id);

  if (inLinks.length > 0 && outLinks.length > 0) {
    let bestReqDeflectionRad = Infinity;
    let bestT1List: number[] = [];
    let bestT2List: number[] = [];
    let bestPass = false;
    let anyInboundFeasible = false;
    let anyOutboundFeasible = false;

    for (const inLink of inLinks) {
      const srcInst = instMap.get(inLink.sourceInstanceId);
      if (!srcInst) continue;
      const b1 = bodyMap.get(srcInst.bodyName);
      const env1 = envelopes[srcInst.id] || { minMs: 0, maxMs: 1e5 };
      if (!b1) continue;

      const numSamples = 30;
      const theta1List: number[] = [];
      for (let i = 0; i < numSamples; i++) {
        const frac = i / (numSamples - 1);
        const v1 = env1.minMs + frac * (env1.maxMs - env1.minMs);
        const res1 = getTisserandIntersectionTheta(body, vInfMs, b1, v1, mu_main);
        if (res1) theta1List.push(res1.thetaA);
      }

      if (theta1List.length > 0) anyInboundFeasible = true;

      for (const outLink of outLinks) {
        const tgtInst = instMap.get(outLink.targetInstanceId);
        if (!tgtInst) continue;
        const b2 = bodyMap.get(tgtInst.bodyName);
        const env2 = envelopes[tgtInst.id] || { minMs: 0, maxMs: 1e5 };
        if (!b2) continue;

        const theta2List: number[] = [];
        for (let i = 0; i < numSamples; i++) {
          const frac = i / (numSamples - 1);
          const v2 = env2.minMs + frac * (env2.maxMs - env2.minMs);
          const res2 = getTisserandIntersectionTheta(body, vInfMs, b2, v2, mu_main);
          if (res2) theta2List.push(res2.thetaA);
        }

        if (theta2List.length > 0) anyOutboundFeasible = true;

        if (theta1List.length === 0 || theta2List.length === 0) continue;

        const minT1 = Math.min(...theta1List);
        const maxT1 = Math.max(...theta1List);
        const minT2 = Math.min(...theta2List);
        const maxT2 = Math.max(...theta2List);

        const reqDeflectionRad = Math.max(0, minT2 - maxT1, minT1 - maxT2);

        if (reqDeflectionRad < bestReqDeflectionRad) {
          bestReqDeflectionRad = reqDeflectionRad;
          bestT1List = theta1List;
          bestT2List = theta2List;
        }

        if (reqDeflectionRad <= deltaMaxRad + 1e-4) {
          bestPass = true;
        }
      }
    }

    const t1MinDeg = bestT1List.length > 0 ? (Math.min(...bestT1List) * 180) / Math.PI : 0;
    const t1MaxDeg = bestT1List.length > 0 ? (Math.max(...bestT1List) * 180) / Math.PI : 0;
    const t2MinDeg = bestT2List.length > 0 ? (Math.min(...bestT2List) * 180) / Math.PI : 0;
    const t2MaxDeg = bestT2List.length > 0 ? (Math.max(...bestT2List) * 180) / Math.PI : 0;
    const reqDeflectionDeg = isFinite(bestReqDeflectionRad) ? (bestReqDeflectionRad * 180) / Math.PI : 180;
    const deficitDeg = Math.max(0, reqDeflectionDeg - deltaMaxDeg);

    // Vector change powered assist estimate: delta_v ~ 2 * v_inf * sin(deficit / 2)
    const poweredDvMs = deficitDeg > 0 ? 2 * vInfMs * Math.sin((deficitDeg * Math.PI) / 360) : 0;

    let rejectionReason: string | undefined;
    if (!anyInboundFeasible) {
      rejectionReason = `No heliocentric orbital crossing with inbound body at v_inf = ${vInfKms.toFixed(2)} km/s (orbit does not reach)`;
    } else if (!anyOutboundFeasible) {
      rejectionReason = `No heliocentric orbital crossing with outbound body at v_inf = ${vInfKms.toFixed(2)} km/s (orbit does not reach)`;
    } else if (deficitDeg > 0) {
      rejectionReason = `Gravity cannot turn corner: Required turn ${reqDeflectionDeg.toFixed(1)}° exceeds gravity maximum ${deltaMaxDeg.toFixed(1)}° by ${deficitDeg.toFixed(1)}°`;
    }

    return {
      vInfMs,
      vInfKms,
      c3,
      deltaMaxDeg,
      theta1MinDeg: t1MinDeg,
      theta1MaxDeg: t1MaxDeg,
      theta2MinDeg: t2MinDeg,
      theta2MaxDeg: t2MaxDeg,
      reqDeflectionDeg,
      deficitDeg,
      isValid: bestPass,
      poweredDvMs,
      rejectionReason,
    };
  } else if (inLinks.length > 0) {
    // Pure arrival target
    let satisfiesIn = false;
    let t1List: number[] = [];
    for (const inLink of inLinks) {
      const srcInst = instMap.get(inLink.sourceInstanceId);
      if (!srcInst) continue;
      const b1 = bodyMap.get(srcInst.bodyName);
      const env1 = envelopes[srcInst.id] || { minMs: 0, maxMs: 1e5 };
      if (!b1) continue;

      const numSamples = 30;
      for (let i = 0; i < numSamples; i++) {
        const frac = i / (numSamples - 1);
        const v1 = env1.minMs + frac * (env1.maxMs - env1.minMs);
        const res = getTisserandIntersectionTheta(body, vInfMs, b1, v1, mu_main);
        if (res) {
          satisfiesIn = true;
          t1List.push(res.thetaA);
        }
      }
    }
    const t1MinDeg = t1List.length > 0 ? (Math.min(...t1List) * 180) / Math.PI : 0;
    const t1MaxDeg = t1List.length > 0 ? (Math.max(...t1List) * 180) / Math.PI : 0;
    return {
      vInfMs,
      vInfKms,
      c3,
      deltaMaxDeg,
      theta1MinDeg: t1MinDeg,
      theta1MaxDeg: t1MaxDeg,
      theta2MinDeg: 0,
      theta2MaxDeg: 0,
      reqDeflectionDeg: 0,
      deficitDeg: 0,
      isValid: satisfiesIn,
      poweredDvMs: 0,
      rejectionReason: satisfiesIn ? undefined : `Cannot intersect incoming transfer orbit at v_inf = ${vInfKms.toFixed(2)} km/s`,
    };
  } else if (outLinks.length > 0) {
    // Pure departure source
    let satisfiesOut = false;
    let t2List: number[] = [];
    for (const outLink of outLinks) {
      const tgtInst = instMap.get(outLink.targetInstanceId);
      if (!tgtInst) continue;
      const b2 = bodyMap.get(tgtInst.bodyName);
      const env2 = envelopes[tgtInst.id] || { minMs: 0, maxMs: 1e5 };
      if (!b2) continue;

      const numSamples = 30;
      for (let i = 0; i < numSamples; i++) {
        const frac = i / (numSamples - 1);
        const v2 = env2.minMs + frac * (env2.maxMs - env2.minMs);
        const res = getTisserandIntersectionTheta(body, vInfMs, b2, v2, mu_main);
        if (res) {
          satisfiesOut = true;
          t2List.push(res.thetaA);
        }
      }
    }
    const t2MinDeg = t2List.length > 0 ? (Math.min(...t2List) * 180) / Math.PI : 0;
    const t2MaxDeg = t2List.length > 0 ? (Math.max(...t2List) * 180) / Math.PI : 0;
    return {
      vInfMs,
      vInfKms,
      c3,
      deltaMaxDeg,
      theta1MinDeg: 0,
      theta1MaxDeg: 0,
      theta2MinDeg: t2MinDeg,
      theta2MaxDeg: t2MaxDeg,
      reqDeflectionDeg: 0,
      deficitDeg: 0,
      isValid: satisfiesOut,
      poweredDvMs: 0,
      rejectionReason: satisfiesOut ? undefined : `Cannot reach outbound target orbit at v_inf = ${vInfKms.toFixed(2)} km/s`,
    };
  }

  return {
    vInfMs,
    vInfKms,
    c3,
    deltaMaxDeg,
    theta1MinDeg: 0,
    theta1MaxDeg: 0,
    theta2MinDeg: 0,
    theta2MaxDeg: 0,
    reqDeflectionDeg: 0,
    deficitDeg: 0,
    isValid: true,
    poweredDvMs: 0,
  };
}

/**
 * Computes full step-by-step debug calculation details for an instance node
 */
export function computeC3DebugDetails(
  instanceId: string,
  instances: InstanceNode[],
  links: DirectionalLink[],
  bodies: CelestialBody[],
  mainBody: CelestialBody
): C3DebugCalculationDetails | null {
  const inst = instances.find(i => i.id === instanceId);
  if (!inst) return null;

  const body = bodies.find(b => b.name === inst.bodyName);
  if (!body) return null;

  const envelopes = computeTisserandEnvelopes(instances, links, bodies, mainBody);
  const activeEnv = envelopes[inst.id] || { minMs: 0, maxMs: 10000 };

  const hasIncoming = links.some(l => l.targetInstanceId === inst.id);
  const hasOutgoing = links.some(l => l.sourceInstanceId === inst.id);
  const isFlyby = hasIncoming && hasOutgoing;
  const isPureFlyby = isFlyby && !inst.isSourceOverride;
  const isSource = !hasIncoming || !!inst.isSourceOverride;
  const isTarget = !hasOutgoing;

  const minAlt = inst.minFlybyRadius !== undefined ? inst.minFlybyRadius : (body.atmosphereHeight || 10000);
  const r_p_min = body.radius + minAlt;

  // 5 deg unconstrained ceiling
  const targetDeltaRad = (5 * Math.PI) / 180;
  const sinHalfDelta = Math.sin(targetDeltaRad / 2);
  const vInf5DegMs = Math.sqrt(((1 / sinHalfDelta) - 1) * body.stdGravParam / r_p_min);
  const c3_5Deg = (vInf5DegMs / 1000) ** 2;

  const minKms = activeEnv.minMs / 1000;
  const maxKms = activeEnv.maxMs / 1000;

  // Rule 2: an instance which is a source or target should have a minimum C3 of 0
  let minC3 = (isSource || isTarget) ? 0 : minKms * minKms;
  let maxC3 = maxKms * maxKms;

  // Rule 1: maxC3 should not lower the maximum C3 given by the tisserand plot if the instance is a flyby among other roles
  if (!isFlyby && inst.maxC3 !== undefined) {
    maxC3 = Math.min(maxC3, inst.maxC3);
    if (minC3 > maxC3) minC3 = 0;
  }

  const finalMinC3 = Math.round(Math.max(0, minC3) * 10) / 10;
  const finalMaxC3 = Math.round(Math.max(finalMinC3, maxC3) * 10) / 10;

  // Inbound & Outbound neighbor details
  const instMap = new Map<string, InstanceNode>();
  instances.forEach(i => instMap.set(i.id, i));

  const inboundNeighbors: LinkNeighborDetail[] = links
    .filter(l => l.targetInstanceId === inst.id)
    .map(l => {
      const srcNode = instMap.get(l.sourceInstanceId)!;
      const env = envelopes[srcNode.id] || { minMs: 0, maxMs: 10000 };
      return {
        linkId: l.id,
        neighborInstanceId: srcNode.id,
        neighborBodyName: srcNode.bodyName,
        neighborEnvelope: {
          minMs: env.minMs,
          maxMs: env.maxMs,
          minC3: Math.round((env.minMs / 1000) ** 2 * 10) / 10,
          maxC3: Math.round((env.maxMs / 1000) ** 2 * 10) / 10,
        },
        direction: 'inbound',
      };
    });

  const outboundNeighbors: LinkNeighborDetail[] = links
    .filter(l => l.sourceInstanceId === inst.id)
    .map(l => {
      const tgtNode = instMap.get(l.targetInstanceId)!;
      const env = envelopes[tgtNode.id] || { minMs: 0, maxMs: 10000 };
      return {
        linkId: l.id,
        neighborInstanceId: tgtNode.id,
        neighborBodyName: tgtNode.bodyName,
        neighborEnvelope: {
          minMs: env.minMs,
          maxMs: env.maxMs,
          minC3: Math.round((env.minMs / 1000) ** 2 * 10) / 10,
          maxC3: Math.round((env.maxMs / 1000) ** 2 * 10) / 10,
        },
        direction: 'outbound',
      };
    });

  // Generate sweep samples from 500 m/s up to maxMs + margin
  const sweepMax = Math.max(activeEnv.maxMs * 1.15, 12000);
  const sweepStep = 200; // 200 m/s
  const samples: VInfSampleEvaluation[] = [];

  for (let v = 500; v <= sweepMax; v += sweepStep) {
    samples.push(
      evaluateSingleVInfForInstance(
        inst,
        v,
        instances,
        links,
        bodies,
        mainBody,
        envelopes
      )
    );
  }

  // Also insert the exact threshold sample and user-defined point if not already close
  const exactThreshold = activeEnv.minMs;
  if (exactThreshold > 500 && exactThreshold < sweepMax) {
    const evalThresh = evaluateSingleVInfForInstance(inst, exactThreshold, instances, links, bodies, mainBody, envelopes);
    samples.push(evalThresh);
    samples.sort((a, b) => a.vInfMs - b.vInfMs);
  }

  // Build high-level clear explanation
  const inBodies = inboundNeighbors.map(n => n.neighborBodyName).join(', ');
  const outBodies = outboundNeighbors.map(n => n.neighborBodyName).join(', ');

  let summary = '';
  let whyMinIsHighOrLow = '';
  let directVsFlyby = '';
  let recommendation = '';

  if (isPureFlyby || (hasIncoming && hasOutgoing)) {
    summary = `${body.name} is functioning as a gravity assist flyby node between inbound [${inBodies}] and outbound [${outBodies}].`;
    whyMinIsHighOrLow =
      `An unpowered gravity assist requires that the planet's gravitational well can bend the incoming asymptotic velocity vector v_inf into the outgoing asymptotic velocity vector.\n\n` +
      `When arriving from an inner planet (e.g. Eve, semi-major axis ~9.8e9 m), the transfer orbit reaches ${body.name} at apoapsis, so the spacecraft moves slower than ${body.name} and the incoming v_inf arrives with a retrograde pump angle (~180°).\n` +
      `Conversely, departing to an outer planet (e.g. Jool, semi-major axis ~68.8e9 m) requires periapsis injection, so outgoing v_inf leaves with a prograde pump angle (~0°).\n\n` +
      `This creates a required deflection angle Δθ ≈ 180°. However, ${body.name}'s maximum gravity deflection capacity δ_max at low v_inf (e.g. C3 = 9.61 km²/s², v_inf = 3.1 km/s) is only ~41.5°.\n` +
      `To close the geometric gap ballistically without a huge powered burn, the orbits must cross ${body.name} non-tangentially at higher excess velocity (v_inf ≥ ${minKms.toFixed(2)} km/s, C3 ≥ ${finalMinC3.toFixed(1)} km²/s²), where the pump angle cones expand enough to satisfy Δθ_req ≤ δ_max.`;

    directVsFlyby =
      `• Direct Departure from ${body.name} to Jool only needs C3 ≈ 7.8 to 9.61 km²/s² because there is no incoming leg to deflect.\n` +
      `• Flyby assist (${inBodies} ➔ ${body.name} ➔ ${outBodies}) demands C3 ≥ ${finalMinC3.toFixed(1)} km²/s² for an UNPOWERED assist. Any lower C3 (such as 9.61 km²/s²) requires a powered maneuver (Δv ≥ 2.8 km/s) at periapsis.`;

    recommendation =
      `If you intended a direct launch from ${body.name} to Jool, ensure ${body.name} is set as a Source node (Is Source Override = ON) with no incoming links.\n` +
      `If you intended a multi-flyby assist, C3 = 9.61 km²/s² will require a powered assist burn or a different intermediate flyby geometry.`;
  } else if (isSource) {
    summary = `${body.name} is a departure source node with outgoing link(s) to [${outBodies}].`;
    whyMinIsHighOrLow =
      `For a departure source node, C3 represents the launch characteristic energy C3 = v_inf².\n` +
      `The minimum C3 is 0.0 km²/s² (direct launches can start from any parabolic/hyperbolic excess energy up to the maximum C3 ceiling).\n` +
      `The Tisserand envelope maximum is ${finalMaxC3.toFixed(1)} km²/s² (v_inf = ${maxKms.toFixed(2)} km/s).`;
    directVsFlyby = `Direct departures allow full departure energy freedom from C3 = 0 up to your specified maximum C3.`;
    recommendation = `You can adjust the maximum C3 ceiling in the node inspector.`;
  } else {
    summary = `${body.name} is a target arrival node with incoming link(s) from [${inBodies}].`;
    whyMinIsHighOrLow =
      `For an arrival target node, C3 represents the hyperbolic arrival excess energy C3 = v_inf² from [${inBodies}].\n` +
      `The minimum C3 is 0.0 km²/s² (direct capture orbits are unconstrained by flyby deflection limits).`;
    directVsFlyby = `Arrival excess energy is determined by the heliocentric intersection geometry from the source.`;
    recommendation = `Review incoming transfer orbits and capture Δv requirements.`;
  }

  return {
    instance: inst,
    body,
    mainBody,
    isSource,
    isPureFlyby,
    isTarget,
    minFlybyRadiusM: r_p_min,
    minFlybyAltitudeKm: minAlt / 1000,
    userMaxC3: inst.maxC3,
    vInf5DegMs,
    c3_5Deg: Math.round(c3_5Deg * 10) / 10,
    finalMinMs: activeEnv.minMs,
    finalMaxMs: activeEnv.maxMs,
    finalMinC3,
    finalMaxC3,
    inboundNeighbors,
    outboundNeighbors,
    samples,
    explanation: {
      title: `${body.name} C3 Tisserand Constraint Breakdown`,
      summary,
      whyMinIsHighOrLow,
      directVsFlybyDifference: directVsFlyby,
      recommendation,
    },
  };
}
