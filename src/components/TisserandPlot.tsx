import React, { useState, useMemo, useRef } from 'react';
import { CelestialBody, InstanceNode, DirectionalLink, FlyableSequenceResult } from '../types';
import { ChevronDown, ChevronUp, Layers, Info, Eye, EyeOff, Sparkles, Activity, ZoomIn, ZoomOut, RotateCcw, Move } from 'lucide-react';

interface TisserandPlotProps {
  instances: InstanceNode[];
  links?: DirectionalLink[];
  bodies: CelestialBody[];
  mainBody: CelestialBody;
  results?: FlyableSequenceResult[];
}

interface VInfCurvePoint {
  theta: number;
  E: number; // J/kg (m^2/s^2)
  rp: number; // meters
  log10rp: number;
}

interface VInfGraduation {
  thetaDeg: number;
  deflexionMaxDeg: number;
  E: number;
  rp: number;
  log10rp: number;
}

interface VInfCurveData {
  vInfMs: number;
  vInfKms: number;
  points: VInfCurvePoint[];
  graduations: VInfGraduation[];
  deltaMaxDeg: number;
}

interface BodyTisserandData {
  body: CelestialBody;
  a_p: number; // semi-major axis (m)
  v_p: number; // orbital speed around main body (m/s)
  r_p_min: number; // min flyby radius (m)
  vInf5DegMs: number; // vInf allowing 5 deg deflection at r_p_min (m/s)
  maxC3Ms2?: number; // max C3 constraint in m^2/s^2
  vInfMaxMs: number; // min(vInf5Deg, sqrt(maxC3))
  curves: VInfCurveData[];
  maxC3Curve?: VInfCurveData;
  color: string;
}

const K_GRADUATION_STEP = 5;

const DEFAULT_BODY_COLORS: Record<string, string> = {
  Kerbin: '#38BDF8',
  Earth: '#60A5FA',
  Eve: '#C084FC',
  Venus: '#F472B6',
  Duna: '#F87171',
  Mars: '#EF4444',
  Jool: '#4ADE80',
  Jupiter: '#34D399',
  Laythe: '#38BDF8',
  Vall: '#818CF8',
  Tylo: '#FBBF24',
  Bop: '#A855F7',
  Pol: '#FACC15',
  Mun: '#94A3B8',
  Minmus: '#2DD4BF',
  Moho: '#FB923C',
  Mercury: '#F97316',
  Dres: '#CBD5E1',
  Eeloo: '#E2E8F0',
  Saturn: '#FCD34D',
  Uranus: '#22D3EE',
  Neptune: '#6366F1',
  Pluto: '#A8A29E',
};

export interface VInfDebugEvaluation {
  prevBodyName?: string;
  prevVInfKms?: number;
  prevRpAU?: number;
  prevRpKm?: number;
  prevRpLog10M?: number; // log10(rp [m]) for comparison with chart X-axis
  prevE_MJ?: number;
  prevThetaDeg?: number;

  nextBodyName?: string;
  nextVInfKms?: number;
  nextRpAU?: number;
  nextRpKm?: number;
  nextRpLog10M?: number; // log10(rp [m]) for comparison with chart X-axis
  nextE_MJ?: number;
  nextThetaDeg?: number;

  deflectionDeg?: number;
  maxDeflectionDeg?: number;
  isValid: boolean;
  notes: string;
}

export interface VInfExtremity {
  thetaDeg: number;
  rpM: number;
  rpAU: number;
  rpKm: number;
  log10rp: number; // log10(rp [m])
  E: number;       // Energy J/kg
  E_MJ: number;    // Energy MJ/kg
}

export interface VInfExtremities {
  start: VInfExtremity; // At theta = 0 (periapsis pump angle = 0°)
  end: VInfExtremity;   // At theta = thetaMax (max pump angle)
}

export interface VInfDebugEntry {
  bodyName: string;
  vInfKms: number;
  vInfMs: number;
  isDisplayed: boolean;
  reason: string;
  maxDeflectionDeg: number;
  extremities?: VInfExtremities;
  evaluations: VInfDebugEvaluation[];
  explanationText: string;
}

/**
 * Calculates periapsis rp and energy E for a given body, vInf, and pump angle theta.
 */
function getRpEFromTheta(
  body: CelestialBody,
  vInfMs: number,
  thetaRad: number,
  mu_main: number
): { rpM: number; rpAU: number; rpKm: number; log10rp: number; E: number; E_MJ: number } {
  const a_p = body.semiMajorAxis;
  const v_p = Math.sqrt(mu_main / a_p);
  const h = a_p * (v_p + vInfMs * Math.cos(thetaRad));
  const v_sc2 = v_p * v_p + vInfMs * vInfMs + 2 * v_p * vInfMs * Math.cos(thetaRad);
  const E = 0.5 * v_sc2 - mu_main / a_p;

  let rpM = 0;
  if (Math.abs(E) < 1e-9) {
    rpM = (h * h) / (2 * mu_main);
  } else if (E < 0) {
    const sma = -mu_main / (2 * E);
    const ecc2 = 1 + (2 * E * h * h) / (mu_main * mu_main);
    const ecc = Math.sqrt(Math.max(0, ecc2));
    rpM = sma * (1 - ecc);
  } else {
    const sma = mu_main / (2 * E);
    const ecc2 = 1 + (2 * E * h * h) / (mu_main * mu_main);
    const ecc = Math.sqrt(Math.max(0, ecc2));
    rpM = sma * (ecc - 1);
  }

  const AU = 1.495978707e11;
  return {
    rpM,
    rpAU: rpM / AU,
    rpKm: rpM / 1000,
    log10rp: rpM > 0 ? Math.log10(rpM) : 0,
    E,
    E_MJ: E / 1e6,
  };
}

/**
 * Calculates the exact pump angles thetaA and thetaB where the vInfA curve of bodyA
 * intersects the vInfB curve of bodyB in the Tisserand (r_p, E) space.
 * Returns { thetaA, thetaB } if they intersect within physical bounds, or null if they don't.
 */
function getIntersectionTheta(
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
 * Bisection helper to find pump angle theta1 in [0, thetaMax] such that periapsis rp(theta1) = a1.
 * - If a1 >= a_p: returns 0 (since max achievable rp at body p is a_p, occurring at theta = 0).
 * - If a1 < rp(thetaMax): returns null (a1 is below the minimum periapsis reachable on this vInf curve).
 */
function getThetaForRp(
  a1: number,
  a_p: number,
  v_p: number,
  vInfMs: number,
  mu_main: number,
  thetaMax: number
): number | null {
  if (a1 >= a_p) return 0;

  const getRp = (theta: number) => {
    const h = a_p * (v_p + vInfMs * Math.cos(theta));
    if (h <= 0) return 0;
    const v_sc2 = v_p * v_p + vInfMs * vInfMs + 2 * v_p * vInfMs * Math.cos(theta);
    const E = 0.5 * v_sc2 - mu_main / a_p;
    if (E >= 0) {
      const a_sc = mu_main / (2 * Math.max(E, 1e-9));
      const disc = Math.max(0, 1 + (2 * E * h * h) / (mu_main * mu_main));
      return a_sc * (Math.sqrt(disc) - 1);
    } else {
      const a_sc = -mu_main / (2 * E);
      const disc = Math.max(0, 1 + (2 * E * h * h) / (mu_main * mu_main));
      return a_sc * (1 - Math.sqrt(disc));
    }
  };

  const minRp = getRp(thetaMax);
  if (a1 < minRp - 1e-3) {
    return null;
  }

  let low = 0;
  let high = thetaMax;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (getRp(mid) > a1) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

/**
 * Finds pump angle theta2 in [0, thetaMax] such that spacecraft orbital energy E(theta2) = -mu_main / (2 * a2).
 * This corresponds to spacecraft semi-major axis a_sc = a2.
 */
function getThetaForEnergy(
  a2: number,
  a_p: number,
  v_p: number,
  vInfMs: number,
  mu_main: number,
  thetaMax: number
): number | null {
  const num = (mu_main / (2 * a_p)) - (mu_main / (2 * a2)) - (0.5 * vInfMs * vInfMs);
  const den = v_p * vInfMs;
  if (den === 0) return null;
  const cosVal = num / den;
  if (cosVal < -1 || cosVal > 1) return null;
  const theta = Math.acos(cosVal);
  if (theta > thetaMax + 1e-4) return null;
  return theta;
}

/**
 * Bisection helper to find pump angle theta on a Tisserand curve corresponding to a target body semi-major axis.
 * - If targetSma <= a_p (inner body or same body), we match periapsis r_p(theta) = targetSma.
 * - If targetSma > a_p (outer body), we match apoapsis r_a(theta) = targetSma.
 */
function getThetaForBody(
  targetSma: number,
  a_p: number,
  v_p: number,
  vInfMs: number,
  mu_main: number,
  thetaMax: number
): number | null {
  const calcOrbitParams = (theta: number) => {
    const h = a_p * (v_p + vInfMs * Math.cos(theta));
    if (h <= 0) return { rp: 0, ra: 0 };
    const v_sc2 = v_p * v_p + vInfMs * vInfMs + 2 * v_p * vInfMs * Math.cos(theta);
    const E = 0.5 * v_sc2 - mu_main / a_p;
    let rp = 0;
    let ra = 0;
    if (Math.abs(E) < 1e-9) {
      rp = (h * h) / (2 * mu_main);
      ra = Infinity;
    } else if (E < 0) {
      const a_sc = -mu_main / (2 * E);
      const disc = Math.max(0, 1 + (2 * E * h * h) / (mu_main * mu_main));
      rp = a_sc * (1 - Math.sqrt(disc));
      ra = a_sc * (1 + Math.sqrt(disc));
    } else {
      // Hyperbolic orbit relative to Sun (E > 0)
      const a_sc = mu_main / (2 * E);
      const disc = 1 + (2 * E * h * h) / (mu_main * mu_main);
      rp = a_sc * (Math.sqrt(disc) - 1);
      ra = Infinity;
    }
    return { rp, ra };
  };

  const isInner = targetSma <= a_p;

  const val0 = isInner ? calcOrbitParams(0).rp : calcOrbitParams(0).ra;
  const valMax = isInner ? calcOrbitParams(thetaMax).rp : calcOrbitParams(thetaMax).ra;

  const maxVal = Math.max(val0, valMax);
  const minVal = Math.min(val0, valMax);

  if (targetSma > maxVal + 1e-3 || targetSma < minVal - 1e-3) {
    return null; // targetSma is not reachable on this vInf curve
  }

  let low = 0;
  let high = thetaMax;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    const valMid = isInner ? calcOrbitParams(mid).rp : calcOrbitParams(mid).ra;
    if (valMid > targetSma) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

export const TisserandPlot: React.FC<TisserandPlotProps> = ({
  instances,
  links = [],
  bodies,
  mainBody,
  results = [],
}) => {
  const [isFolded, setIsFolded] = useState<boolean>(false);
  const [selectedBodyNames, setSelectedBodyNames] = useState<Record<string, boolean>>({});
  const [customBounds, setCustomBounds] = useState<{
    minLogRp: number;
    maxLogRp: number;
    minE: number;
    maxE: number;
  } | null>(null);

  const [dragBox, setDragBox] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);

  const [hoverInfo, setHoverInfo] = useState<{
    pctX: number;
    pctY: number;
    bodyName: string;
    vInfKms: number;
    thetaDeg: number;
    deflexionMaxDeg: number;
    E_MJ: number;
    rpKm: number;
  } | null>(null);

  const [showDebugPanel, setShowDebugPanel] = useState<boolean>(false);
  const [debugBodyFilter, setDebugBodyFilter] = useState<string>('ALL');
  const [debugStatusFilter, setDebugStatusFilter] = useState<'ALL' | 'DISPLAYED' | 'FILTERED'>('ALL');

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Get unique list of bodies used in the canvas (excluding the main central body)
  const canvasBodies = useMemo(() => {
    const names = Array.from(new Set(instances.map(i => i.bodyName)));
    return bodies.filter(b => names.includes(b.name) && b.name !== mainBody.name);
  }, [instances, bodies, mainBody]);

  // Map each flyby body name to pairs of connected bodies (body1, body2) based on graph links
  const flybyConnectedPairsMap = useMemo(() => {
    const map: Record<string, { body1: CelestialBody; body2: CelestialBody }[]> = {};

    if (!links || links.length === 0) return map;

    const instMap = new Map<string, InstanceNode>();
    instances.forEach(i => instMap.set(i.id, i));

    const bodyMap = new Map<string, CelestialBody>();
    bodies.forEach(b => bodyMap.set(b.name, b));

    instances.forEach(inst => {
      const incomingLinks = links.filter(l => l.targetInstanceId === inst.id);
      const outgoingLinks = links.filter(l => l.sourceInstanceId === inst.id);

      if (incomingLinks.length > 0 && outgoingLinks.length > 0) {
        const flybyBodyName = inst.bodyName;
        if (!map[flybyBodyName]) {
          map[flybyBodyName] = [];
        }

        incomingLinks.forEach(inLink => {
          const srcInst = instMap.get(inLink.sourceInstanceId);
          if (!srcInst) return;
          const body1 = bodyMap.get(srcInst.bodyName);
          if (!body1) return;

          outgoingLinks.forEach(outLink => {
            const tgtInst = instMap.get(outLink.targetInstanceId);
            if (!tgtInst) return;
            const body2 = bodyMap.get(tgtInst.bodyName);
            if (!body2) return;

            const pairExists = map[flybyBodyName].some(
              p => (p.body1.name === body1.name && p.body2.name === body2.name) ||
                   (p.body1.name === body2.name && p.body2.name === body1.name)
            );
            if (!pairExists) {
              map[flybyBodyName].push({ body1, body2 });
            }
          });
        });
      }
    });

    return map;
  }, [instances, links, bodies]);

  // Map each body name to its connected neighbor bodies from graph links
  const neighborBodiesMap = useMemo(() => {
    const map: Record<string, CelestialBody[]> = {};
    if (!links || links.length === 0) return map;

    const instMap = new Map<string, InstanceNode>();
    instances.forEach(i => instMap.set(i.id, i));

    const bodyMap = new Map<string, CelestialBody>();
    bodies.forEach(b => bodyMap.set(b.name, b));

    links.forEach(l => {
      const srcInst = instMap.get(l.sourceInstanceId);
      const tgtInst = instMap.get(l.targetInstanceId);
      if (!srcInst || !tgtInst) return;

      const srcBody = bodyMap.get(srcInst.bodyName);
      const tgtBody = bodyMap.get(tgtInst.bodyName);
      if (!srcBody || !tgtBody) return;

      if (srcBody.name !== tgtBody.name) {
        if (!map[srcBody.name]) map[srcBody.name] = [];
        if (!map[srcBody.name].some(b => b.name === tgtBody.name)) {
          map[srcBody.name].push(tgtBody);
        }

        if (!map[tgtBody.name]) map[tgtBody.name] = [];
        if (!map[tgtBody.name].some(b => b.name === srcBody.name)) {
          map[tgtBody.name].push(srcBody);
        }
      }
    });

    return map;
  }, [instances, links, bodies]);

  // Main body gravitational parameter
  const mu_main = mainBody.stdGravParam;

  // Process Tisserand data for each canvas body and build debug explanations
  const { bodyDataList, debugEntries } = useMemo<{
    bodyDataList: BodyTisserandData[];
    debugEntries: VInfDebugEntry[];
  }>(() => {
    // 1. Build initial candidate curves for all bodies, enforcing maxC3 as a hard upper bound
    const bodyPrepMap: Record<string, {
      body: CelestialBody;
      a_p: number;
      v_p: number;
      r_p_min: number;
      vInf5DegMs: number;
      maxC3Val?: number;
      vInfMaxMs: number;
      initialCurves: VInfCurveData[];
      maxC3Curve?: VInfCurveData;
      color: string;
      idx: number;
    }> = {};

    const initialKeptMap: Record<string, Set<number>> = {};

    canvasBodies.forEach((body, idx) => {
      const a_p = body.semiMajorAxis;
      const v_p = Math.sqrt(mu_main / a_p);
      const mu_b = body.stdGravParam;
      const R_b = body.radius;

      // Min flyby alt & maxC3 from instances
      const bodyInstances = instances.filter(i => i.bodyName === body.name);
      let minAlt = Infinity;
      let maxC3Val: number | undefined = undefined;

      bodyInstances.forEach(inst => {
        if (inst.minFlybyRadius !== undefined && inst.minFlybyRadius < minAlt) {
          minAlt = inst.minFlybyRadius;
        }
        if (inst.maxC3 !== undefined && inst.maxC3 > 0) {
          if (maxC3Val === undefined || inst.maxC3 < maxC3Val) {
            maxC3Val = inst.maxC3;
          }
        }
      });

      if (minAlt === Infinity) {
        minAlt = body.atmosphereHeight;
      }
      const r_p_min = R_b + minAlt;

      const targetDeltaRad = (5 * Math.PI) / 180;
      const sinHalfDelta = Math.sin(targetDeltaRad / 2);
      const vInf5DegMs = Math.sqrt(((1 / sinHalfDelta) - 1) * mu_b / r_p_min);

      let vInfMaxMs = vInf5DegMs;
      let vInfC3Ms: number | undefined = undefined;
      if (maxC3Val !== undefined && maxC3Val > 0) {
        vInfC3Ms = Math.sqrt(maxC3Val) * 1000;
        vInfMaxMs = Math.min(vInfMaxMs, vInfC3Ms);
      }

      vInfMaxMs = Math.max(1000, vInfMaxMs);

      const buildCurve = (vInfMs: number): VInfCurveData => {
        const numPoints = 80;
        const points: VInfCurvePoint[] = [];

        const thetaMax = vInfMs >= v_p ? Math.acos(-v_p / vInfMs) : Math.PI;

        for (let i = 0; i <= numPoints; i++) {
          const theta = (i / numPoints) * thetaMax;
          const h = a_p * (v_p + vInfMs * Math.cos(theta));
          if (h <= 0) continue;

          const v_sc2 = v_p * v_p + vInfMs * vInfMs + 2 * v_p * vInfMs * Math.cos(theta);
          const E = 0.5 * v_sc2 - mu_main / a_p;

          let rp = 0;
          if (Math.abs(E) < 1e-9) {
            rp = (h * h) / (2 * mu_main);
          } else {
            const a_sc = -mu_main / (2 * E);
            const disc = 1 + (2 * E * h * h) / (mu_main * mu_main);
            if (disc >= 0) {
              const e_sc = Math.sqrt(disc);
              rp = a_sc * (1 - e_sc);
            }
          }

          if (rp > 0 && !isNaN(rp) && isFinite(rp)) {
            points.push({
              theta,
              E,
              rp,
              log10rp: Math.log10(rp),
            });
          }
        }

        const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (r_p_min * vInfMs * vInfMs) / mu_b)));
        const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);
        const deltaMaxDeg = (deltaMaxRad * 180) / Math.PI;

        const graduations: VInfGraduation[] = [];
        for (let thetaKRad = 0; thetaKRad <= thetaMax; thetaKRad += deltaMaxRad / K_GRADUATION_STEP) {
          const hk = a_p * (v_p + vInfMs * Math.cos(thetaKRad));
          if (hk <= 0) continue;

          const v_sc2_k = v_p * v_p + vInfMs * vInfMs + 2 * v_p * vInfMs * Math.cos(thetaKRad);
          const Ek = 0.5 * v_sc2_k - mu_main / a_p;

          let rpk = 0;
          if (Math.abs(Ek) < 1e-9) {
            rpk = (hk * hk) / (2 * mu_main);
          } else {
            const a_sck = -mu_main / (2 * Ek);
            const discK = Math.max(0, 1 + (2 * Ek * hk * hk) / (mu_main * mu_main));
            rpk = a_sck * (1 - Math.sqrt(discK));
          }

          if (rpk > 0 && !isNaN(rpk) && isFinite(rpk)) {
            graduations.push({
              thetaDeg: (thetaKRad * 180) / Math.PI,
              deflexionMaxDeg: deltaMaxDeg,
              E: Ek,
              rp: rpk,
              log10rp: Math.log10(rpk),
            });
          }
        }

        return {
          vInfMs,
          vInfKms: vInfMs / 1000,
          points,
          graduations,
          deltaMaxDeg,
        };
      };

      const initialCurves: VInfCurveData[] = [];
      const stepMs = 1000;
      for (let v = 1000; v <= vInfMaxMs; v += stepMs) {
        initialCurves.push(buildCurve(v));
      }

      // Hard limit Rule 1: filter curves > maxC3
      let filteredCurves = initialCurves;
      let maxC3Curve: VInfCurveData | undefined = undefined;
      if (vInfC3Ms !== undefined) {
        filteredCurves = initialCurves.filter(c => c.vInfMs <= vInfC3Ms! + 1e-3);
        maxC3Curve = buildCurve(vInfC3Ms);
      }

      const color = body.color || DEFAULT_BODY_COLORS[body.name] || `hsl(${(idx * 137.5) % 360}, 80%, 65%)`;

      bodyPrepMap[body.name] = {
        body,
        a_p,
        v_p,
        r_p_min,
        vInf5DegMs,
        maxC3Val,
        vInfMaxMs,
        initialCurves: filteredCurves,
        maxC3Curve,
        color,
        idx,
      };

      initialKeptMap[body.name] = new Set(filteredCurves.map(c => c.vInfMs));
    });

    // 2. Iterative "back and forth" removal pass until fixpoint
    const keptMap: Record<string, Set<number>> = {};
    Object.keys(initialKeptMap).forEach(key => {
      keptMap[key] = new Set(initialKeptMap[key]);
    });

    let changed = true;
    let passCount = 0;

    while (changed && passCount < 20) {
      changed = false;
      passCount++;

      for (const body of canvasBodies) {
        const prep = bodyPrepMap[body.name];
        if (!prep) continue;

        const connectedPairs = flybyConnectedPairsMap[body.name] || [];
        const neighbors = neighborBodiesMap[body.name] || [];

        const currentKept = keptMap[body.name] || new Set();
        const nextKept = new Set<number>();

        for (const vInfMs of currentKept) {
          if (connectedPairs.length > 0) {
            // Flyby body: must touch a displayed line of B1 and a displayed line of B2
            // with deflection angle deltaTheta <= deltaMaxRad
            const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (prep.r_p_min * vInfMs * vInfMs) / body.stdGravParam)));
            const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);

            const isValid = connectedPairs.some(pair => {
              const b1 = pair.body1;
              const b2 = pair.body2;
              const b1Kept = Array.from(keptMap[b1.name] || []);
              const b2Kept = Array.from(keptMap[b2.name] || []);

              for (const v1 of b1Kept) {
                const res1 = getIntersectionTheta(body, vInfMs, b1, v1, mu_main);
                if (!res1) continue;

                for (const v2 of b2Kept) {
                  const res2 = getIntersectionTheta(body, vInfMs, b2, v2, mu_main);
                  if (!res2) continue;

                  const thetaIn = res1.thetaA;
                  const thetaOut = res2.thetaA;
                  const deltaTheta = Math.abs(thetaIn - thetaOut);

                  if (deltaTheta <= deltaMaxRad + 1e-4) {
                    return true;
                  }
                }
              }
              return false;
            });

            if (isValid) {
              nextKept.add(vInfMs);
            }
          } else if (neighbors.length > 0) {
            // Pure source / pure target body (connected to neighbors)
            const isValid = neighbors.some(nb => {
              const nbKept = Array.from(keptMap[nb.name] || []);
              return nbKept.some(vNb => {
                return getIntersectionTheta(body, vInfMs, nb, vNb, mu_main) !== null;
              });
            });

            if (isValid) {
              nextKept.add(vInfMs);
            }
          } else {
            // Unconnected body
            nextKept.add(vInfMs);
          }
        }

        if (nextKept.size !== currentKept.size) {
          keptMap[body.name] = nextKept;
          changed = true;
        }
      }
    }

    // 3. Construct final BodyTisserandData objects
    const finalBodyDataList = canvasBodies.map(body => {
      const prep = bodyPrepMap[body.name];
      const keptSet = keptMap[body.name] || new Set();
      const finalCurves = prep.initialCurves.filter(c => keptSet.has(c.vInfMs));

      return {
        body: prep.body,
        a_p: prep.a_p,
        v_p: prep.v_p,
        r_p_min: prep.r_p_min,
        vInf5DegMs: prep.vInf5DegMs,
        maxC3Ms2: prep.maxC3Val,
        vInfMaxMs: prep.vInfMaxMs,
        curves: finalCurves,
        maxC3Curve: prep.maxC3Curve,
        color: prep.color,
      };
    });

    // 4. Construct comprehensive Debug Entries explaining why each candidate vInf line is displayed or not
    const debugEntries: VInfDebugEntry[] = [];

    canvasBodies.forEach(body => {
      const prep = bodyPrepMap[body.name];
      if (!prep) return;

      const keptSet = keptMap[body.name] || new Set();
      const connectedPairs = flybyConnectedPairsMap[body.name] || [];
      const neighbors = neighborBodiesMap[body.name] || [];

      // Candidate integer vInf lines up to max of vInf5DegMs or sqrt(maxC3)
      const maxCandidateMs = Math.max(prep.vInfMaxMs, prep.maxC3Val ? Math.sqrt(prep.maxC3Val) * 1000 : 0);

      for (let v = 1000; v <= maxCandidateMs; v += 1000) {
        const vInfKms = v / 1000;
        const isDisplayed = keptSet.has(v);

        let exceedsC3 = false;
        if (prep.maxC3Val !== undefined && prep.maxC3Val > 0) {
          const vC3Ms = Math.sqrt(prep.maxC3Val) * 1000;
          if (v > vC3Ms + 1e-3) {
            exceedsC3 = true;
          }
        }

        const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (prep.r_p_min * v * v) / body.stdGravParam)));
        const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);
        const deltaMaxDeg = (deltaMaxRad * 180) / Math.PI;

        // Calculate extremities for this candidate vInf curve
        const candidateCurve = prep.initialCurves.find(c => c.vInfMs === v) || buildCurve(v);
        const candidatePts = candidateCurve ? candidateCurve.points : [];
        const AU_VAL = 1.495978707e11;

        const extremities: VInfExtremities | undefined = candidatePts && candidatePts.length > 0 ? {
          start: {
            thetaDeg: (candidatePts[0].theta * 180) / Math.PI,
            rpM: candidatePts[0].rp,
            rpAU: candidatePts[0].rp / AU_VAL,
            rpKm: candidatePts[0].rp / 1000,
            log10rp: candidatePts[0].log10rp,
            E: candidatePts[0].E,
            E_MJ: candidatePts[0].E / 1e6,
          },
          end: {
            thetaDeg: (candidatePts[candidatePts.length - 1].theta * 180) / Math.PI,
            rpM: candidatePts[candidatePts.length - 1].rp,
            rpAU: candidatePts[candidatePts.length - 1].rp / AU_VAL,
            rpKm: candidatePts[candidatePts.length - 1].rp / 1000,
            log10rp: candidatePts[candidatePts.length - 1].log10rp,
            E: candidatePts[candidatePts.length - 1].E,
            E_MJ: candidatePts[candidatePts.length - 1].E / 1e6,
          },
        } : undefined;

        const evaluations: VInfDebugEvaluation[] = [];

        if (exceedsC3) {
          debugEntries.push({
            bodyName: body.name,
            vInfKms,
            vInfMs: v,
            isDisplayed: false,
            reason: `Exceeds maxC3 hard limit (${prep.maxC3Val?.toFixed(2)} km²/s²)`,
            maxDeflectionDeg: deltaMaxDeg,
            extremities,
            evaluations: [],
            explanationText: `FILTERED OUT: v_inf = ${vInfKms.toFixed(1)} km/s exceeds maxC3 limit (${prep.maxC3Val?.toFixed(2)} km²/s²). Max allowed v_inf = ${(Math.sqrt(prep.maxC3Val!)).toFixed(2)} km/s.`,
          });
          continue;
        }

        if (connectedPairs.length > 0) {
          connectedPairs.forEach(pair => {
            const b1 = pair.body1;
            const b2 = pair.body2;
            const b1Kept = Array.from(keptMap[b1.name] || []).sort((a, b) => a - b);
            const b2Kept = Array.from(keptMap[b2.name] || []).sort((a, b) => a - b);

            for (const v1 of b1Kept) {
              const res1 = getIntersectionTheta(body, v, b1, v1, mu_main);

              for (const v2 of b2Kept) {
                const res2 = getIntersectionTheta(body, v, b2, v2, mu_main);

                if (res1 && res2) {
                  const pt1 = getRpEFromTheta(body, v, res1.thetaA, mu_main);
                  const pt2 = getRpEFromTheta(body, v, res2.thetaA, mu_main);
                  const theta1Deg = (res1.thetaA * 180) / Math.PI;
                  const theta2Deg = (res2.thetaA * 180) / Math.PI;
                  const deflectionDeg = Math.abs(theta1Deg - theta2Deg);
                  const isValid = deflectionDeg <= deltaMaxDeg + 1e-4;

                  evaluations.push({
                    prevBodyName: b1.name,
                    prevVInfKms: v1 / 1000,
                    prevRpAU: pt1.rpAU,
                    prevRpKm: pt1.rpM / 1000,
                    prevRpLog10M: pt1.log10rp,
                    prevE_MJ: pt1.E_MJ,
                    prevThetaDeg: theta1Deg,

                    nextBodyName: b2.name,
                    nextVInfKms: v2 / 1000,
                    nextRpAU: pt2.rpAU,
                    nextRpKm: pt2.rpM / 1000,
                    nextRpLog10M: pt2.log10rp,
                    nextE_MJ: pt2.E_MJ,
                    nextThetaDeg: theta2Deg,

                    deflectionDeg,
                    maxDeflectionDeg: deltaMaxDeg,
                    isValid,
                    notes: isValid
                      ? `Valid flyby transition (required deflection ${deflectionDeg.toFixed(2)}° <= max ${deltaMaxDeg.toFixed(2)}°)`
                      : `Deflection required (${deflectionDeg.toFixed(2)}°) exceeds max allowed (${deltaMaxDeg.toFixed(2)}°)`,
                  });
                } else {
                  let noteMsg = '';
                  if (!res1 && !res2) {
                    noteMsg = `No geometric crossing with ${b1.name} (vInf=${v1/1000}km/s) or ${b2.name} (vInf=${v2/1000}km/s)`;
                  } else if (!res1) {
                    noteMsg = `Crosses ${b2.name} (vInf=${v2/1000}km/s) but no crossing with ${b1.name} (vInf=${v1/1000}km/s)`;
                  } else {
                    noteMsg = `Crosses ${b1.name} (vInf=${v1/1000}km/s) but no crossing with ${b2.name} (vInf=${v2/1000}km/s)`;
                  }

                  evaluations.push({
                    prevBodyName: b1.name,
                    prevVInfKms: v1 / 1000,
                    nextBodyName: b2.name,
                    nextVInfKms: v2 / 1000,
                    deflectionDeg: undefined,
                    maxDeflectionDeg: deltaMaxDeg,
                    isValid: false,
                    notes: noteMsg,
                  });
                }
              }
            }
          });

          let explanationText = '';
          if (isDisplayed) {
            const validEval = evaluations.find(e => e.isValid);
            if (validEval) {
              explanationText = `DISPLAYED: v_inf = ${vInfKms.toFixed(1)} km/s connects displayed line of ${validEval.prevBodyName} (vInf=${validEval.prevVInfKms} km/s at rp=${validEval.prevRpAU?.toFixed(3)} AU, log10(rp[m])=${validEval.prevRpLog10M?.toFixed(3)}, E=${validEval.prevE_MJ?.toFixed(2)} MJ/kg) to displayed line of ${validEval.nextBodyName} (vInf=${validEval.nextVInfKms} km/s at rp=${validEval.nextRpAU?.toFixed(3)} AU, log10(rp[m])=${validEval.nextRpLog10M?.toFixed(3)}, E=${validEval.nextE_MJ?.toFixed(2)} MJ/kg). Deflection = ${validEval.deflectionDeg?.toFixed(2)}° <= max ${deltaMaxDeg.toFixed(2)}°.`;
            } else {
              explanationText = `DISPLAYED: v_inf = ${vInfKms.toFixed(1)} km/s is active (max deflection = ${deltaMaxDeg.toFixed(2)}°).`;
            }
          } else {
            if (evaluations.length === 0) {
              explanationText = `FILTERED OUT: No candidate v_inf line combinations exist on connected bodies (${connectedPairs.map(p => `${p.body1.name} & ${p.body2.name}`).join(', ')}) to allow a flyby.`;
            } else {
              explanationText = `FILTERED OUT: Evaluated ${evaluations.length} pair combination(s). None satisfied the max deflection limit (${deltaMaxDeg.toFixed(2)}°) between crossing points.`;
            }
          }

          debugEntries.push({
            bodyName: body.name,
            vInfKms,
            vInfMs: v,
            isDisplayed,
            reason: isDisplayed ? 'Valid flyby transition' : 'Deflection exceeds max or no line crossing',
            maxDeflectionDeg: deltaMaxDeg,
            extremities,
            evaluations,
            explanationText,
          });
        } else if (neighbors.length > 0) {
          neighbors.forEach(nb => {
            const nbKept = Array.from(keptMap[nb.name] || []).sort((a, b) => a - b);
            nbKept.forEach(vNb => {
              const res = getIntersectionTheta(body, v, nb, vNb, mu_main);
              if (res) {
                const pt = getRpEFromTheta(body, v, res.thetaA, mu_main);
                const thetaDeg = (res.thetaA * 180) / Math.PI;

                evaluations.push({
                  nextBodyName: nb.name,
                  nextVInfKms: vNb / 1000,
                  nextRpAU: pt.rpAU,
                  nextRpKm: pt.rpM / 1000,
                  nextRpLog10M: pt.log10rp,
                  nextE_MJ: pt.E_MJ,
                  nextThetaDeg: thetaDeg,
                  isValid: true,
                  notes: `Crosses ${nb.name} (vInf=${vNb/1000}km/s) at rp=${pt.rpAU.toFixed(3)} AU (log10(rp[m])=${pt.log10rp.toFixed(3)}), E=${pt.E_MJ.toFixed(2)} MJ/kg`,
                });
              } else {
                evaluations.push({
                  nextBodyName: nb.name,
                  nextVInfKms: vNb / 1000,
                  isValid: false,
                  notes: `No geometric intersection with ${nb.name} (vInf=${vNb/1000}km/s)`,
                });
              }
            });
          });

          let explanationText = '';
          if (isDisplayed) {
            const validEval = evaluations.find(e => e.isValid);
            explanationText = `DISPLAYED: v_inf = ${vInfKms.toFixed(1)} km/s crosses displayed v_inf line of ${validEval?.nextBodyName} (vInf=${validEval?.nextVInfKms} km/s) at rp=${validEval?.nextRpAU?.toFixed(3)} AU (log10(rp[m])=${validEval?.nextRpLog10M?.toFixed(3)}), E=${validEval?.nextE_MJ?.toFixed(2)} MJ/kg.`;
          } else {
            explanationText = `FILTERED OUT: v_inf = ${vInfKms.toFixed(1)} km/s does not cross any displayed v_inf line of connected neighbor (${neighbors.map(n => n.name).join(', ')}).`;
          }

          debugEntries.push({
            bodyName: body.name,
            vInfKms,
            vInfMs: v,
            isDisplayed,
            reason: isDisplayed ? 'Crosses connected neighbor vInf line' : 'No crossing with connected neighbor vInf lines',
            maxDeflectionDeg: deltaMaxDeg,
            extremities,
            evaluations,
            explanationText,
          });
        } else {
          debugEntries.push({
            bodyName: body.name,
            vInfKms,
            vInfMs: v,
            isDisplayed: true,
            reason: 'Unconnected body',
            maxDeflectionDeg: deltaMaxDeg,
            extremities,
            evaluations: [],
            explanationText: `DISPLAYED: Unconnected body ${body.name} displays v_inf = ${vInfKms.toFixed(1)} km/s.`,
          });
        }
      }
    });

    console.log('[Tisserand vInf Line Filter Debug Array]', debugEntries);

    return { bodyDataList: finalBodyDataList, debugEntries };
  }, [canvasBodies, instances, links, bodies, mu_main, flybyConnectedPairsMap, neighborBodiesMap]);

  // Overall Plot Bounding Box (Min/Max log10rp and Min/Max E)
  const plotBounds = useMemo(() => {
    const relevantBodies = canvasBodies.length > 0 ? canvasBodies : bodies.filter(b => b.name !== mainBody.name);

    let smaLowerBody = 1e10;
    let smaUpperBody = 1e12;
    if (relevantBodies.length > 0) {
      smaLowerBody = Math.min(...relevantBodies.map(b => b.semiMajorAxis));
      smaUpperBody = Math.max(...relevantBodies.map(b => b.semiMajorAxis));
    }

    // Default periapsis range: smaLowerBody / 10 to smaUpperBody
    const minRp = smaLowerBody / 10;
    const maxRp = smaUpperBody;
    const minLogRp = Math.log10(minRp);
    const maxLogRp = Math.log10(maxRp);

    // Energy minimum: EnergyLowerBody = -mu_main / (2 * smaLowerBody)
    const energyLowerBody = -mu_main / (2 * smaLowerBody);
    const minE = energyLowerBody;

    // Find maximum energy across generated curve points (or default to non-negative/positive)
    let maxE_pts = -Infinity;
    bodyDataList.forEach(data => {
      data.curves.forEach(curve => {
        curve.points.forEach(p => {
          if (p.E > maxE_pts) maxE_pts = p.E;
        });
      });
    });

    let maxE = maxE_pts !== -Infinity ? Math.max(0, maxE_pts) : Math.abs(energyLowerBody) * 0.2;
    if (maxE <= minE) {
      maxE = minE + Math.abs(minE) * 0.5;
    }

    return {
      minLogRp,
      maxLogRp,
      minE,
      maxE,
    };
  }, [canvasBodies, bodies, mainBody, mu_main, bodyDataList]);

  // SVG dimensions
  const svgWidth = 900;
  const svgHeight = 420;
  const margin = { top: 30, right: 40, bottom: 50, left: 75 };
  const graphWidth = svgWidth - margin.left - margin.right;
  const graphHeight = svgHeight - margin.top - margin.bottom;

  // Active View Bounds (custom zoomed bounds or auto-fitted plot bounds)
  const activeBounds = useMemo(() => {
    return customBounds || plotBounds;
  }, [customBounds, plotBounds]);

  // Coordinate projection helpers
  const projectX = (log10rp: number) => {
    const pct = (log10rp - activeBounds.minLogRp) / (activeBounds.maxLogRp - activeBounds.minLogRp || 1);
    return margin.left + pct * graphWidth;
  };

  const projectY = (E: number) => {
    const pct = (E - activeBounds.minE) / (activeBounds.maxE - activeBounds.minE || 1);
    return margin.top + (1 - pct) * graphHeight; // SVG Y is inverted
  };

  // Generate X axis ticks (log10rp)
  const xTicks = useMemo(() => {
    const span = activeBounds.maxLogRp - activeBounds.minLogRp;
    let step = 0.5;
    if (span < 0.5) step = 0.05;
    else if (span < 1.0) step = 0.1;
    else if (span < 2.0) step = 0.2;
    else if (span > 6.0) step = 1.0;

    const start = Math.floor(activeBounds.minLogRp / step) * step;
    const end = Math.ceil(activeBounds.maxLogRp / step) * step;
    const ticks: { val: number; label: string; subLabel: string }[] = [];

    for (let v = start; v <= end + 1e-9; v += step) {
      if (v >= activeBounds.minLogRp - 1e-9 && v <= activeBounds.maxLogRp + 1e-9) {
        const rpMeters = Math.pow(10, v);
        const rpKm = rpMeters / 1000;
        const label = v.toFixed(span < 1 ? 2 : 1);

        ticks.push({
          val: v,
          label,
          subLabel: `${rpKm.toExponential(1)} km`,
        });
      }
    }
    return ticks;
  }, [activeBounds]);

  // Generate Y axis ticks (Energy E in J/kg, displayed as MJ/kg or km^2/s^2)
  const yTicks = useMemo(() => {
    const count = 6;
    const ticks: { val: number; label: string }[] = [];
    const step = (activeBounds.maxE - activeBounds.minE) / count;

    for (let i = 0; i <= count; i++) {
      const val = activeBounds.minE + i * step;
      const valMJ = val / 1e6; // MJ/kg
      ticks.push({
        val,
        label: `${valMJ >= 0 ? '+' : ''}${valMJ.toFixed(1)} MJ/kg`,
      });
    }
    return ticks;
  }, [activeBounds]);

  const handleZoomIn = () => {
    const centerRp = (activeBounds.minLogRp + activeBounds.maxLogRp) / 2;
    const spanRp = (activeBounds.maxLogRp - activeBounds.minLogRp) * 0.75;
    const centerE = (activeBounds.minE + activeBounds.maxE) / 2;
    const spanE = (activeBounds.maxE - activeBounds.minE) * 0.75;
    setCustomBounds({
      minLogRp: centerRp - spanRp / 2,
      maxLogRp: centerRp + spanRp / 2,
      minE: centerE - spanE / 2,
      maxE: centerE + spanE / 2,
    });
  };

  const handleZoomOut = () => {
    const centerRp = (activeBounds.minLogRp + activeBounds.maxLogRp) / 2;
    const spanRp = (activeBounds.maxLogRp - activeBounds.minLogRp) * 1.35;
    const centerE = (activeBounds.minE + activeBounds.maxE) / 2;
    const spanE = (activeBounds.maxE - activeBounds.minE) * 1.35;
    setCustomBounds({
      minLogRp: centerRp - spanRp / 2,
      maxLogRp: centerRp + spanRp / 2,
      minE: centerE - spanE / 2,
      maxE: centerE + spanE / 2,
    });
  };

  const handleResetZoom = () => {
    setCustomBounds(null);
  };

  const getSVGCoords = (e: React.MouseEvent<SVGSVGElement> | React.WheelEvent<SVGSVGElement>) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((e.clientX - rect.left) / rect.width) * svgWidth;
    const y = ((e.clientY - rect.top) / rect.height) * svgHeight;
    return { x, y };
  };

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const coords = getSVGCoords(e);
    if (!coords) return;

    if (
      coords.x >= margin.left &&
      coords.x <= margin.left + graphWidth &&
      coords.y >= margin.top &&
      coords.y <= margin.top + graphHeight
    ) {
      setDragBox({ start: coords, current: coords });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragBox) return;
    const coords = getSVGCoords(e);
    if (!coords) return;

    const clampedX = Math.max(margin.left, Math.min(margin.left + graphWidth, coords.x));
    const clampedY = Math.max(margin.top, Math.min(margin.top + graphHeight, coords.y));

    setDragBox(prev => (prev ? { ...prev, current: { x: clampedX, y: clampedY } } : null));
  };

  const handleMouseUp = () => {
    if (!dragBox) return;
    const { start, current } = dragBox;
    const x1 = Math.min(start.x, current.x);
    const x2 = Math.max(start.x, current.x);
    const y1 = Math.min(start.y, current.y);
    const y2 = Math.max(start.y, current.y);

    if (x2 - x1 > 8 && y2 - y1 > 8) {
      const pctMinX = (x1 - margin.left) / graphWidth;
      const pctMaxX = (x2 - margin.left) / graphWidth;
      const pctMinY = (y1 - margin.top) / graphHeight;
      const pctMaxY = (y2 - margin.top) / graphHeight;

      const newMinLogRp = activeBounds.minLogRp + pctMinX * (activeBounds.maxLogRp - activeBounds.minLogRp);
      const newMaxLogRp = activeBounds.minLogRp + pctMaxX * (activeBounds.maxLogRp - activeBounds.minLogRp);

      const newMaxE = activeBounds.maxE - pctMinY * (activeBounds.maxE - activeBounds.minE);
      const newMinE = activeBounds.maxE - pctMaxY * (activeBounds.maxE - activeBounds.minE);

      setCustomBounds({
        minLogRp: newMinLogRp,
        maxLogRp: newMaxLogRp,
        minE: newMinE,
        maxE: newMaxE,
      });
    }

    setDragBox(null);
  };

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const coords = getSVGCoords(e);
    if (!coords) return;
    if (
      coords.x < margin.left ||
      coords.x > margin.left + graphWidth ||
      coords.y < margin.top ||
      coords.y > margin.top + graphHeight
    ) {
      return;
    }

    const factor = e.deltaY > 0 ? 1.15 : 0.85;

    const pctX = (coords.x - margin.left) / graphWidth;
    const pctY = (coords.y - margin.top) / graphHeight;

    const currentLogRpSpan = activeBounds.maxLogRp - activeBounds.minLogRp;
    const currentESpan = activeBounds.maxE - activeBounds.minE;

    const mouseLogRp = activeBounds.minLogRp + pctX * currentLogRpSpan;
    const mouseE = activeBounds.maxE - pctY * currentESpan;

    const newLogRpSpan = currentLogRpSpan * factor;
    const newESpan = currentESpan * factor;

    setCustomBounds({
      minLogRp: mouseLogRp - pctX * newLogRpSpan,
      maxLogRp: mouseLogRp + (1 - pctX) * newLogRpSpan,
      minE: mouseE - (1 - pctY) * newESpan,
      maxE: mouseE + pctY * newESpan,
    });
  };

  const toggleBodySelected = (name: string) => {
    setSelectedBodyNames(prev => ({
      ...prev,
      [name]: prev[name] === undefined ? false : !prev[name],
    }));
  };

  return (
    <div
      id="tisserand-plot-container"
      ref={containerRef}
      className="bg-[#1A1B1E] border border-[#2D2E33] rounded-lg p-4 shadow-2xl flex flex-col gap-3 text-[#E2E8F0] w-full min-w-full"
    >
      {/* Header bar with Fold toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2D2E33] pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded bg-[#38BDF8]/10 text-[#38BDF8] border border-[#38BDF8]/30">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold tracking-wide text-white flex items-center gap-2">
              <span>Tisserand Energy Plot</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#25262B] text-[#38BDF8] border border-[#38BDF8]/30">
                Energy / log₁₀(rₚ)
              </span>
            </h2>
            <p className="text-[11px] text-[#94A3B8]">
              Specific Orbital Energy vs. Periapsis Radius for bodies used in canvas
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="btn-toggle-tisserand-fold"
            onClick={() => setIsFolded(!isFolded)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#25262B] hover:bg-[#2D2E33] text-[#38BDF8] border border-[#2D2E33] text-xs font-mono transition cursor-pointer"
          >
            {isFolded ? (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Unfold Tisserand Plot</span>
              </>
            ) : (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Fold Plot</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Body Content when unfolded */}
      {!isFolded && (
        <div className="flex flex-col gap-3">
          {/* Controls & Body Toggles */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[#25262B] p-2.5 rounded border border-[#2D2E33] text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-[#94A3B8] uppercase text-[10px] tracking-wider">
                Canvas Bodies ({canvasBodies.length}):
              </span>
              {canvasBodies.length === 0 ? (
                <span className="text-amber-400 font-mono text-[11px] italic">
                  No bodies added to canvas. Add bodies above to display Tisserand curves!
                </span>
              ) : (
                canvasBodies.map(body => {
                  const isHidden = selectedBodyNames[body.name] === false;
                  const bodyColor = body.color || DEFAULT_BODY_COLORS[body.name] || '#38BDF8';

                  return (
                    <button
                      key={body.name}
                      onClick={() => toggleBodySelected(body.name)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono border transition cursor-pointer ${
                        !isHidden
                          ? 'bg-[#1A1B1E] text-white border-[#475569]'
                          : 'bg-[#1A1B1E]/40 text-[#64748B] line-through border-[#2D2E33]'
                      }`}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block"
                        style={{ backgroundColor: !isHidden ? bodyColor : '#64748B' }}
                      />
                      <span>{body.name}</span>
                      {!isHidden ? (
                        <Eye className="w-3 h-3 text-[#38BDF8]" />
                      ) : (
                        <EyeOff className="w-3 h-3 text-[#64748B]" />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-[#94A3B8] font-mono">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-0.5 bg-[#38BDF8] inline-block" /> v_inf lines (1 km/s to max)
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full border border-white bg-white/40 inline-block" /> 1/10th δ_max graduations
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-2 bg-slate-500/20 border border-slate-500/40 inline-block rounded-xs" /> C3 &gt; maxC3 area
              </span>
            </div>
          </div>

          {/* Zoom Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[#25262B] px-3 py-2 rounded border border-[#2D2E33] text-xs font-mono">
            <div className="flex items-center gap-2 text-[#94A3B8] text-[11px]">
              <Move className="w-3.5 h-3.5 text-[#38BDF8]" />
              <span>Click & drag box to zoom • Scroll wheel to zoom</span>
            </div>
            <div className="flex items-center gap-1.5">
              {customBounds && (
                <span className="text-[10px] text-[#38BDF8] bg-[#38BDF8]/10 border border-[#38BDF8]/30 px-2 py-0.5 rounded font-semibold mr-1">
                  Zoomed In
                </span>
              )}
              <button
                onClick={handleZoomIn}
                title="Zoom In (+25%)"
                className="p-1.5 rounded bg-[#1A1B1E] hover:bg-[#2D2E33] text-slate-200 hover:text-white border border-[#2D2E33] transition cursor-pointer"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleZoomOut}
                title="Zoom Out (-25%)"
                className="p-1.5 rounded bg-[#1A1B1E] hover:bg-[#2D2E33] text-slate-200 hover:text-white border border-[#2D2E33] transition cursor-pointer"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleResetZoom}
                disabled={!customBounds}
                title="Reset Zoom to Fit All"
                className={`flex items-center gap-1 px-2.5 py-1 rounded border text-[11px] transition cursor-pointer ${
                  customBounds
                    ? 'bg-[#1A1B1E] hover:bg-[#2D2E33] text-[#38BDF8] border-[#38BDF8]/40 font-bold'
                    : 'bg-[#1A1B1E]/50 text-slate-500 border-[#2D2E33] cursor-not-allowed'
                }`}
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reset Zoom</span>
              </button>
            </div>
          </div>

          {/* Interactive SVG Graph Area */}
          <div className="relative w-full overflow-x-auto bg-[#141517] rounded border border-[#2D2E33] p-2 flex justify-center">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full max-w-5xl h-auto select-none"
              style={{ minWidth: '650px', cursor: dragBox ? 'crosshair' : 'default' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={handleWheel}
            >
              <defs>
                <clipPath id="tisserand-graph-clip">
                  <rect
                    x={margin.left}
                    y={margin.top}
                    width={graphWidth}
                    height={graphHeight}
                  />
                </clipPath>
              </defs>

              {/* Plot Background */}
              <rect
                x={margin.left}
                y={margin.top}
                width={graphWidth}
                height={graphHeight}
                fill="#1A1B1E"
                stroke="#2D2E33"
                strokeWidth={1}
              />

              {/* Grid Lines - X Axis (log10rp) */}
              {xTicks.map((tick, i) => {
                const x = projectX(tick.val);
                return (
                  <g key={`x-grid-${i}`}>
                    <line
                      x1={x}
                      y1={margin.top}
                      x2={x}
                      y2={margin.top + graphHeight}
                      stroke="#25262B"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                    <line
                      x1={x}
                      y1={margin.top + graphHeight}
                      x2={x}
                      y2={margin.top + graphHeight + 5}
                      stroke="#475569"
                      strokeWidth={1}
                    />
                    <text
                      x={x}
                      y={margin.top + graphHeight + 18}
                      fill="#94A3B8"
                      fontSize={10}
                      fontFamily="monospace"
                      textAnchor="middle"
                    >
                      {tick.label}
                    </text>
                  </g>
                );
              })}

              {/* Grid Lines - Y Axis (Energy E) */}
              {yTicks.map((tick, i) => {
                const y = projectY(tick.val);
                return (
                  <g key={`y-grid-${i}`}>
                    <line
                      x1={margin.left}
                      y1={y}
                      x2={margin.left + graphWidth}
                      y2={y}
                      stroke="#25262B"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                    <line
                      x1={margin.left - 5}
                      y1={y}
                      x2={margin.left}
                      y2={y}
                      stroke="#475569"
                      strokeWidth={1}
                    />
                    <text
                      x={margin.left - 8}
                      y={y + 3}
                      fill="#94A3B8"
                      fontSize={9}
                      fontFamily="monospace"
                      textAnchor="end"
                    >
                      {tick.label}
                    </text>
                  </g>
                );
              })}

              {/* Clipped Plot Area for Curves and Shading */}
              <g clipPath="url(#tisserand-graph-clip)">
                {/* E = 0 Zero Energy Reference Line */}
                {activeBounds.minE <= 0 && activeBounds.maxE >= 0 && (
                  <line
                    x1={margin.left}
                    y1={projectY(0)}
                    x2={margin.left + graphWidth}
                    y2={projectY(0)}
                    stroke="#38BDF8"
                    strokeWidth={1.2}
                    strokeDasharray="4 2"
                    opacity={0.6}
                  />
                )}

                {/* Render Body Curves, Shading, and Graduations */}
                {bodyDataList.map(data => {
                  const isHidden = selectedBodyNames[data.body.name] === false;
                  if (isHidden) return null;

                  // Light Gray Shading for maxC3 area if defined
                  let maxC3ShadingPath = '';
                  if (data.maxC3Curve && data.maxC3Curve.points.length > 2) {
                    const pts = data.maxC3Curve.points;
                    const firstPt = pts[0];
                    const lastPt = pts[pts.length - 1];

                    const x1 = projectX(firstPt.log10rp);

                    let pathD = `M ${x1} ${margin.top}`; // Top left
                    pts.forEach(p => {
                      const px = projectX(p.log10rp);
                      const py = projectY(p.E);
                      pathD += ` L ${px} ${py}`;
                    });

                    const xLast = projectX(lastPt.log10rp);
                    pathD += ` L ${xLast} ${margin.top} Z`;
                    maxC3ShadingPath = pathD;
                  }

                  const isFlybyBody = (flybyConnectedPairsMap[data.body.name] || []).length > 0;

                  return (
                    <g key={`body-group-${data.body.name}`}>
                      {/* Light Gray Area for C3 > maxC3 */}
                      {maxC3ShadingPath && (
                        <path
                          d={maxC3ShadingPath}
                          fill="rgba(203, 213, 225, 0.12)"
                          stroke="rgba(203, 213, 225, 0.3)"
                          strokeWidth={1}
                          strokeDasharray="2 2"
                        />
                      )}

                      {/* VInf Curves */}
                      {data.curves.map((curve, cIdx) => {
                        if (curve.points.length < 2) return null;

                        const isMaxCurve = cIdx === data.curves.length - 1;
                        const pathD = curve.points.reduce((acc, p, idx) => {
                          const px = projectX(p.log10rp);
                          const py = projectY(p.E);
                          return idx === 0 ? `M ${px} ${py}` : `${acc} L ${px} ${py}`;
                        }, '');

                        return (
                          <g key={`curve-${data.body.name}-${cIdx}`}>
                            <path
                              d={pathD}
                              fill="none"
                              stroke={data.color}
                              strokeWidth={isMaxCurve ? 2 : 1.2}
                              opacity={isMaxCurve ? 0.95 : 0.75}
                            />

                            {/* Curve vInf Label at end of line */}
                            {curve.points.length > 0 && (
                              <text
                                x={projectX(curve.points[curve.points.length - 1].log10rp) + 4}
                                y={projectY(curve.points[curve.points.length - 1].E) + 3}
                                fill={data.color}
                                fontSize={9}
                                fontFamily="monospace"
                                fontWeight="bold"
                              >
                                {curve.vInfKms.toFixed(1)} km/s
                              </text>
                            )}

                            {/* Deflection graduations along vInf line (only displayed for flyby bodies) */}
                            {isFlybyBody && curve.graduations.map((grad, gIdx) => {
                              const gx = projectX(grad.log10rp);
                              const gy = projectY(grad.E);

                              return (
                                <g key={`grad-${data.body.name}-${cIdx}-${gIdx}`}>
                                  <circle
                                    cx={gx}
                                    cy={gy}
                                    r={3}
                                    fill={data.color}
                                    stroke="#1A1B1E"
                                    strokeWidth={1}
                                  />
                                  {/* Transparent larger hit target for smooth flicker-free hover */}
                                  <circle
                                    cx={gx}
                                    cy={gy}
                                    r={8}
                                    fill="transparent"
                                    className="cursor-pointer"
                                    onMouseEnter={() => {
                                      setHoverInfo({
                                        pctX: (gx / svgWidth) * 100,
                                        pctY: (gy / svgHeight) * 100,
                                        bodyName: data.body.name,
                                        vInfKms: curve.vInfKms,
                                        thetaDeg: grad.thetaDeg,
                                        deflexionMaxDeg: grad.deflexionMaxDeg,
                                        E_MJ: grad.E / 1e6,
                                        rpKm: grad.rp / 1000,
                                      });
                                    }}
                                    onMouseLeave={() => setHoverInfo(null)}
                                  />
                                </g>
                              );
                            })}
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>

              {/* Drag Box Overlay for Marquee Zoom */}
              {dragBox && (
                <rect
                  x={Math.min(dragBox.start.x, dragBox.current.x)}
                  y={Math.min(dragBox.start.y, dragBox.current.y)}
                  width={Math.abs(dragBox.current.x - dragBox.start.x)}
                  height={Math.abs(dragBox.current.y - dragBox.start.y)}
                  fill="rgba(56, 189, 248, 0.25)"
                  stroke="#38BDF8"
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  pointerEvents="none"
                />
              )}

              {/* Axis Titles */}
              <text
                x={margin.left + graphWidth / 2}
                y={svgHeight - 10}
                fill="#E2E8F0"
                fontSize={11}
                fontFamily="sans-serif"
                fontWeight="bold"
                textAnchor="middle"
              >
                Heliocentric Periapsis log₁₀(rₚ [m])
              </text>

              <text
                x={18}
                y={margin.top + graphHeight / 2}
                fill="#E2E8F0"
                fontSize={11}
                fontFamily="sans-serif"
                fontWeight="bold"
                textAnchor="middle"
                transform={`rotate(-90 18 ${margin.top + graphHeight / 2})`}
              >
                Specific Energy E [MJ/kg]
              </text>
            </svg>

            {/* Hover Tooltip Overlay */}
            {hoverInfo && (
              <div
                className="absolute z-20 bg-[#0F172A] border border-[#38BDF8] text-white p-2.5 rounded shadow-2xl text-xs font-mono pointer-events-none flex flex-col gap-1 min-w-[200px]"
                style={{
                  left: `${hoverInfo.pctX}%`,
                  top: `${hoverInfo.pctY}%`,
                  transform: 'translate(-50%, -115%)',
                }}
              >
                <div className="flex items-center justify-between border-b border-slate-700 pb-1">
                  <span className="font-bold text-[#38BDF8]">{hoverInfo.bodyName}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                  <span className="text-slate-400">v_inf:</span>
                  <span className="text-right font-bold text-emerald-400">{hoverInfo.vInfKms.toFixed(2)} km/s</span>

                  <span className="text-slate-400">Deflection Max δ:</span>
                  <span className="text-right font-bold text-amber-300">{hoverInfo.deflexionMaxDeg.toFixed(2)}°</span>

                  <span className="text-slate-400">Energy E:</span>
                  <span className="text-right font-bold text-sky-300">{hoverInfo.E_MJ.toFixed(2)} MJ/kg</span>

                  <span className="text-slate-400">Periapsis rₚ:</span>
                  <span className="text-right font-bold text-purple-300">
                    {hoverInfo.rpKm >= 1e6
                      ? `${(hoverInfo.rpKm).toExponential(2)} km`
                      : `${Math.round(hoverInfo.rpKm).toLocaleString()} km`}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Debug Panel Toggle Button */}
          <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
            <button
              onClick={() => setShowDebugPanel(!showDebugPanel)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors border border-slate-700"
            >
              <Activity className="w-3.5 h-3.5 text-sky-400" />
              <span>{showDebugPanel ? 'Hide' : 'Show'} V_inf Line Filter Debug Explanations ({debugEntries.length} evaluated)</span>
              {showDebugPanel ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            <div className="text-[11px] text-slate-400 flex items-center gap-3 font-mono">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
                Displayed: {debugEntries.filter(e => e.isDisplayed).length}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-rose-500 inline-block"></span>
                Filtered Out: {debugEntries.filter(e => !e.isDisplayed).length}
              </span>
            </div>
          </div>

          {/* Debug Panel Details */}
          {showDebugPanel && (
            <div className="mt-3 p-4 rounded-lg bg-slate-950 border border-slate-800 flex flex-col gap-3 text-xs">
              {/* Filter Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 text-[11px] font-medium">Filter Body:</span>
                  <select
                    value={debugBodyFilter}
                    onChange={e => setDebugBodyFilter(e.target.value)}
                    className="bg-slate-900 text-slate-200 border border-slate-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-sky-500"
                  >
                    <option value="ALL">All Bodies</option>
                    {Array.from(new Set(debugEntries.map(e => e.bodyName))).map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-slate-400 text-[11px] font-medium">Status:</span>
                  <div className="flex rounded bg-slate-900 p-0.5 border border-slate-800">
                    <button
                      onClick={() => setDebugStatusFilter('ALL')}
                      className={`px-2 py-0.5 rounded text-[11px] ${debugStatusFilter === 'ALL' ? 'bg-sky-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setDebugStatusFilter('DISPLAYED')}
                      className={`px-2 py-0.5 rounded text-[11px] ${debugStatusFilter === 'DISPLAYED' ? 'bg-emerald-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      Displayed
                    </button>
                    <button
                      onClick={() => setDebugStatusFilter('FILTERED')}
                      className={`px-2 py-0.5 rounded text-[11px] ${debugStatusFilter === 'FILTERED' ? 'bg-rose-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
                    >
                      Filtered
                    </button>
                  </div>
                </div>
              </div>

              {/* List of Debug Entries */}
              <div className="flex flex-col gap-2.5 max-h-[380px] overflow-y-auto pr-1">
                {debugEntries
                  .filter(entry => {
                    if (debugBodyFilter !== 'ALL' && entry.bodyName !== debugBodyFilter) return false;
                    if (debugStatusFilter === 'DISPLAYED' && !entry.isDisplayed) return false;
                    if (debugStatusFilter === 'FILTERED' && entry.isDisplayed) return false;
                    return true;
                  })
                  .map((entry, idx) => (
                    <div
                      key={`debug-entry-${entry.bodyName}-${entry.vInfKms}-${idx}`}
                      className={`p-3 rounded border font-mono ${
                        entry.isDisplayed
                          ? 'bg-emerald-950/20 border-emerald-800/40'
                          : 'bg-rose-950/15 border-rose-900/30'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-slate-100">{entry.bodyName}</span>
                          <span className="text-sky-400 font-semibold">v_inf = {entry.vInfKms.toFixed(1)} km/s</span>
                          <span className="text-amber-300/80 text-[11px]">(max δ = {entry.maxDeflectionDeg.toFixed(1)}°)</span>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
                            entry.isDisplayed
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                          }`}
                        >
                          {entry.isDisplayed ? 'Displayed' : 'Filtered Out'}
                        </span>
                      </div>

                      <p className="text-[11px] text-slate-300 leading-relaxed mb-2 font-sans">
                        {entry.explanationText}
                      </p>

                      {/* Line Extremities */}
                      {entry.extremities && (
                        <div className="mt-1.5 mb-2 p-1.5 rounded bg-slate-900/90 border border-slate-800 text-[10px] flex flex-col gap-1">
                          <div className="text-slate-400 font-sans font-medium flex items-center justify-between">
                            <span>v_inf Line Extremities (rp / E coordinates):</span>
                            <span className="text-[9px] text-slate-500 font-mono">Chart X-axis: log10(rp [m])</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono text-[10px]">
                            <div className="p-1 rounded bg-slate-950/60 border border-slate-800/60">
                              <span className="text-sky-400 font-bold">Start (θ = {entry.extremities.start.thetaDeg.toFixed(1)}°):</span>{' '}
                              <span>log10(rp[m]) = <strong className="text-amber-300">{entry.extremities.start.log10rp.toFixed(3)}</strong></span>{' '}
                              <span className="text-slate-400">({entry.extremities.start.rpAU.toFixed(3)} AU)</span>,{' '}
                              <span>E = {entry.extremities.start.E_MJ.toFixed(2)} MJ/kg</span>
                            </div>
                            <div className="p-1 rounded bg-slate-950/60 border border-slate-800/60">
                              <span className="text-sky-400 font-bold">End (θ = {entry.extremities.end.thetaDeg.toFixed(1)}°):</span>{' '}
                              <span>log10(rp[m]) = <strong className="text-amber-300">{entry.extremities.end.log10rp.toFixed(3)}</strong></span>{' '}
                              <span className="text-slate-400">({entry.extremities.end.rpAU.toFixed(3)} AU)</span>,{' '}
                              <span>E = {entry.extremities.end.E_MJ.toFixed(2)} MJ/kg</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Evaluation breakdown table */}
                      {entry.evaluations.length > 0 && (
                        <div className="mt-2 border-t border-slate-800/80 pt-2 text-[10px]">
                          <div className="text-slate-400 font-sans font-medium mb-1">Evaluated Crossings & Deflections:</div>
                          <div className="flex flex-col gap-1">
                            {entry.evaluations.map((ev, evIdx) => (
                              <div
                                key={`ev-${evIdx}`}
                                className={`p-1.5 rounded flex flex-wrap items-center justify-between gap-2 ${
                                  ev.isValid ? 'bg-emerald-900/30 text-emerald-200' : 'bg-slate-900/80 text-slate-400'
                                }`}
                              >
                                <div className="flex items-center gap-2 flex-wrap">
                                  {ev.prevBodyName && (
                                    <span>
                                      {ev.prevBodyName} ({ev.prevVInfKms}km/s):{' '}
                                      log10(rp)={<strong className="text-amber-300">{ev.prevRpLog10M !== undefined ? ev.prevRpLog10M.toFixed(3) : 'N/A'}</strong>}{' '}
                                      <span className="text-slate-400">({ev.prevRpAU ? `${ev.prevRpAU.toFixed(3)}AU` : 'N/A'})</span>,{' '}
                                      {ev.prevE_MJ !== undefined ? `${ev.prevE_MJ.toFixed(1)}MJ/kg` : 'N/A'},{' '}
                                      {ev.prevThetaDeg !== undefined ? `θ₁=${ev.prevThetaDeg.toFixed(1)}°` : ''}
                                    </span>
                                  )}
                                  {ev.prevBodyName && ev.nextBodyName && <span className="text-slate-500">→</span>}
                                  {ev.nextBodyName && (
                                    <span>
                                      {ev.nextBodyName} ({ev.nextVInfKms}km/s):{' '}
                                      log10(rp)={<strong className="text-amber-300">{ev.nextRpLog10M !== undefined ? ev.nextRpLog10M.toFixed(3) : 'N/A'}</strong>}{' '}
                                      <span className="text-slate-400">({ev.nextRpAU ? `${ev.nextRpAU.toFixed(3)}AU` : 'N/A'})</span>,{' '}
                                      {ev.nextE_MJ !== undefined ? `${ev.nextE_MJ.toFixed(1)}MJ/kg` : 'N/A'},{' '}
                                      {ev.nextThetaDeg !== undefined ? `θ₂=${ev.nextThetaDeg.toFixed(1)}°` : ''}
                                    </span>
                                  )}
                                </div>

                                <div className="flex items-center gap-2">
                                  {ev.deflectionDeg !== undefined && (
                                    <span className={ev.isValid ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                                      Δθ = {ev.deflectionDeg.toFixed(1)}° (max {ev.maxDeflectionDeg?.toFixed(1)}°)
                                    </span>
                                  )}
                                  <span className="italic opacity-80 font-sans">{ev.notes}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
