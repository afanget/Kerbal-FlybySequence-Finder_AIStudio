import React, { useState, useMemo, useRef } from 'react';
import { CelestialBody, InstanceNode, DirectionalLink, FlyableSequenceResult } from '../types';
import { ChevronDown, ChevronUp, Layers, Info, Eye, EyeOff, Sparkles, Activity, ZoomIn, ZoomOut, RotateCcw, Move, Search, X, Copy, Check } from 'lucide-react';

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

export interface InspectionCurveData {
  bodyName: string;
  instanceId: string;
  instanceLabel?: string;
  vInfKms: number;
  color: string;
  isPrimary: boolean;
  role: 'primary_limit' | 'related_envelope_min' | 'related_envelope_max';
  curve: VInfCurveData;
}

export interface EnvelopeLogEntry {
  pass: number;
  sweepDirection?: 'forward' | 'backward';
  instanceId: string;
  instanceLabel?: string;
  bodyName: string;
  instPrevMinKms: number;
  instPrevMaxKms: number;
  instNewMinKms: number;
  instNewMaxKms: number;
  bodyPrevMinKms: number;
  bodyPrevMaxKms: number;
  bodyNewMinKms: number;
  bodyNewMaxKms: number;
  action: 'initialized' | 'reduced' | 'unchanged' | 'empty';
  reason: string;
  inspection?: {
    primaryBodyName: string;
    primaryInstanceId: string;
    primaryInstanceLabel?: string;
    primaryVInfMs: number;
    relatedInstances: Array<{
      id: string;
      bodyName: string;
      label?: string;
      minMs: number;
      maxMs: number;
    }>;
    inspectionCurves: InspectionCurveData[];
  };
}

export interface BodyEnvelopeSummary {
  bodyName: string;
  color: string;
  maxC3Kms2?: number;
  minVinfKms: number;
  maxVinfKms: number;
  activeCount: number;
}

export function formatKms(vKms: number): string {
  if (Math.abs(vKms - Math.round(vKms)) < 1e-4) {
    return vKms.toFixed(1);
  }
  return vKms.toFixed(3);
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
    label?: string;
    vInfKms?: number;
    thetaDeg?: number;
    deflexionMaxDeg?: number;
    E_MJ: number;
    rpKm: number;
    rpAU?: number;
    log10rp?: number;
  } | null>(null);

  const [showDebugPanel, setShowDebugPanel] = useState<boolean>(false);
  const [debugBodyFilter, setDebugBodyFilter] = useState<string>('ALL');
  const [debugStatusFilter, setDebugStatusFilter] = useState<'ALL' | 'DISPLAYED' | 'FILTERED'>('ALL');
  const [inspectedLogIndex, setInspectedLogIndex] = useState<number | null>(null);
  const [copiedLogIndex, setCopiedLogIndex] = useState<number | null>(null);

  const handleCopyLogReason = (log: EnvelopeLogEntry, idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const instName = `${log.bodyName}${log.instanceLabel ? ` (${log.instanceLabel})` : ''}`;
    const textToCopy = `[Instance: ${instName} | Pass ${log.pass}] ${log.reason}`;
    navigator.clipboard.writeText(textToCopy);
    setCopiedLogIndex(idx);
    setTimeout(() => setCopiedLogIndex(null), 2000);
  };

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
  const { bodyDataList, envelopeLogs, bodyEnvelopeSummaries } = useMemo<{
    bodyDataList: BodyTisserandData[];
    envelopeLogs: EnvelopeLogEntry[];
    bodyEnvelopeSummaries: BodyEnvelopeSummary[];
  }>(() => {
    // 1. Initial Candidate Envelopes & Curve Builder
    const instMap = new Map<string, InstanceNode>();
    instances.forEach(i => instMap.set(i.id, i));

    const bodyMap = new Map<string, CelestialBody>();
    bodies.forEach(b => bodyMap.set(b.name, b));

    const bodyPrepMap: Record<string, {
      body: CelestialBody;
      a_p: number;
      v_p: number;
      r_p_min: number;
      vInf5DegMs: number;
      maxC3Val?: number;
      initialMinVinfMs: number;
      initialMaxVinfMs: number;
      buildCurve: (vInfMs: number) => VInfCurveData;
      color: string;
      idx: number;
    }> = {};

    const activeInstanceEnvelopes: Record<string, { minMs: number; maxMs: number }> = {};
    const activeBodyEnvelopes: Record<string, { minMs: number; maxMs: number }> = {};
    const envelopeLogs: EnvelopeLogEntry[] = [];

    canvasBodies.forEach((body, idx) => {
      const a_p = body.semiMajorAxis;
      const v_p = Math.sqrt(mu_main / a_p);
      const mu_b = body.stdGravParam;
      const R_b = body.radius;

      // Min flyby alt from instances
      const bodyInstances = instances.filter(i => i.bodyName === body.name);
      let minAlt = Infinity;

      bodyInstances.forEach(inst => {
        if (inst.minFlybyRadius !== undefined && inst.minFlybyRadius < minAlt) {
          minAlt = inst.minFlybyRadius;
        }
      });

      if (minAlt === Infinity) {
        minAlt = body.atmosphereHeight;
      }
      const r_p_min = R_b + minAlt;

      const targetDeltaRad = (5 * Math.PI) / 180;
      const sinHalfDelta = Math.sin(targetDeltaRad / 2);
      const vInf5DegMs = Math.sqrt(((1 / sinHalfDelta) - 1) * mu_b / r_p_min);

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

      const color = body.color || DEFAULT_BODY_COLORS[body.name] || `hsl(${(idx * 137.5) % 360}, 80%, 65%)`;

      bodyPrepMap[body.name] = {
        body,
        a_p,
        v_p,
        r_p_min,
        vInf5DegMs,
        initialMinVinfMs: 0,
        initialMaxVinfMs: vInf5DegMs,
        buildCurve,
        color,
        idx,
      };
    });

    // Initialize per-instance envelopes
    instances.forEach(inst => {
      const prep = bodyPrepMap[inst.bodyName];
      if (!prep) return;
      let maxMs = prep.vInf5DegMs;
      if (inst.maxC3 !== undefined && inst.maxC3 > 0) {
        maxMs = Math.min(maxMs, Math.sqrt(inst.maxC3) * 1000);
      }
      maxMs = Math.max(1000, maxMs);
      const minMs = 0;
      activeInstanceEnvelopes[inst.id] = { minMs, maxMs };
    });

    // Helper to compute body union envelope from all its instance envelopes
    const computeBodyUnionEnvelope = (bodyName: string): { minMs: number; maxMs: number } => {
      const bodyInsts = instances.filter(i => i.bodyName === bodyName);
      const validEnvs = bodyInsts
        .map(i => activeInstanceEnvelopes[i.id])
        .filter(e => e && (e.minMs > 0 || e.maxMs > 0));

      if (validEnvs.length === 0) {
        return { minMs: 0, maxMs: 0 };
      }

      const minMs = Math.min(...validEnvs.map(e => e.minMs));
      const maxMs = Math.max(...validEnvs.map(e => e.maxMs));
      return { minMs, maxMs };
    };

    // Initialize body union envelopes & initial logs
    canvasBodies.forEach(body => {
      const unionEnv = computeBodyUnionEnvelope(body.name);
      activeBodyEnvelopes[body.name] = unionEnv;
    });

    instances.forEach(inst => {
      const env = activeInstanceEnvelopes[inst.id] || { minMs: 0, maxMs: 0 };
      const bodyUnion = activeBodyEnvelopes[inst.bodyName] || { minMs: 0, maxMs: 0 };
      const prep = bodyPrepMap[inst.bodyName];

      const initCurves: InspectionCurveData[] = [];
      if (prep) {
        if (env.minMs > 0) {
          initCurves.push({
            bodyName: inst.bodyName,
            instanceId: inst.id,
            instanceLabel: inst.label,
            vInfKms: env.minMs / 1000,
            color: prep.color,
            isPrimary: true,
            role: 'primary_limit',
            curve: prep.buildCurve(env.minMs),
          });
        }
        if (env.maxMs > 0 && Math.abs(env.maxMs - env.minMs) > 10) {
          initCurves.push({
            bodyName: inst.bodyName,
            instanceId: inst.id,
            instanceLabel: inst.label,
            vInfKms: env.maxMs / 1000,
            color: prep.color,
            isPrimary: true,
            role: 'primary_limit',
            curve: prep.buildCurve(env.maxMs),
          });
        }
      }

      envelopeLogs.push({
        pass: 0,
        instanceId: inst.id,
        instanceLabel: inst.label,
        bodyName: inst.bodyName,
        instPrevMinKms: 0,
        instPrevMaxKms: 0,
        instNewMinKms: env.minMs / 1000,
        instNewMaxKms: env.maxMs / 1000,
        bodyPrevMinKms: 0,
        bodyPrevMaxKms: 0,
        bodyNewMinKms: bodyUnion.minMs / 1000,
        bodyNewMaxKms: bodyUnion.maxMs / 1000,
        action: 'initialized',
        reason: inst.maxC3 !== undefined && inst.maxC3 > 0
          ? `Initial instance envelope = [${formatKms(env.minMs / 1000)}, ${formatKms(env.maxMs / 1000)}] km/s (maxC3 limit = ${inst.maxC3.toFixed(1)} km²/s²)`
          : `Initial instance envelope = [${formatKms(env.minMs / 1000)}, ${formatKms(env.maxMs / 1000)}] km/s (5° deflection limit)`,
        inspection: {
          primaryBodyName: inst.bodyName,
          primaryInstanceId: inst.id,
          primaryInstanceLabel: inst.label,
          primaryVInfMs: env.minMs,
          relatedInstances: [],
          inspectionCurves: initCurves,
        },
      });
    });

    // Test validity of vInfMs for a specific graph instance
    const testInstanceVInfMsValid = (
      inst: InstanceNode,
      vInfMs: number
    ): {
      isValid: boolean;
      reason: string;
      relatedInsts: Array<{ id: string; bodyName: string; label?: string; minMs: number; maxMs: number }>;
    } => {
      const body = bodyMap.get(inst.bodyName);
      const prep = bodyPrepMap[inst.bodyName];
      if (!body || !prep) return { isValid: true, reason: '', relatedInsts: [] };

      const inLinks = links.filter(l => l.targetInstanceId === inst.id);
      const outLinks = links.filter(l => l.sourceInstanceId === inst.id);
      const relatedMap = new Map<string, { id: string; bodyName: string; label?: string; minMs: number; maxMs: number }>();

      if (inLinks.length > 0 && outLinks.length > 0) {
        // Flyby instance: must be able to deflect between connected upstream and downstream instance envelopes
        const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (prep.r_p_min * vInfMs * vInfMs) / body.stdGravParam)));
        const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);
        const deltaMaxDeg = (deltaMaxRad * 180) / Math.PI;

        let satisfiesPair = false;
        let failReason = '';

        for (const inLink of inLinks) {
          const srcInst = instMap.get(inLink.sourceInstanceId);
          if (!srcInst) continue;
          const b1 = bodyMap.get(srcInst.bodyName);
          const env1 = activeInstanceEnvelopes[srcInst.id];
          if (!b1 || !env1 || (env1.minMs === 0 && env1.maxMs === 0)) {
            failReason = `Connected upstream instance ${srcInst.label ? `${b1.name} (${srcInst.label})` : srcInst.id} envelope is empty`;
            if (env1) relatedMap.set(srcInst.id, { id: srcInst.id, bodyName: b1.name, label: srcInst.label, minMs: env1.minMs, maxMs: env1.maxMs });
            continue;
          }

          for (const outLink of outLinks) {
            const tgtInst = instMap.get(outLink.targetInstanceId);
            if (!tgtInst) continue;
            const b2 = bodyMap.get(tgtInst.bodyName);
            const env2 = activeInstanceEnvelopes[tgtInst.id];
            if (!b2 || !env2 || (env2.minMs === 0 && env2.maxMs === 0)) {
              failReason = `Connected downstream instance ${tgtInst.label ? `${b2.name} (${tgtInst.label})` : tgtInst.id} envelope is empty`;
              if (env2) relatedMap.set(tgtInst.id, { id: tgtInst.id, bodyName: b2.name, label: tgtInst.label, minMs: env2.minMs, maxMs: env2.maxMs });
              continue;
            }

            relatedMap.set(srcInst.id, { id: srcInst.id, bodyName: b1.name, label: srcInst.label, minMs: env1.minMs, maxMs: env1.maxMs });
            relatedMap.set(tgtInst.id, { id: tgtInst.id, bodyName: b2.name, label: tgtInst.label, minMs: env2.minMs, maxMs: env2.maxMs });

            const numSamples: number = 30;
            const theta1List: number[] = [];
            const theta2List: number[] = [];

            // Sample upstream body b1 envelope independently
            for (let i = 0; i < numSamples; i++) {
              const frac = numSamples === 1 ? 0 : i / (numSamples - 1);
              const v1 = env1.minMs + frac * (env1.maxMs - env1.minMs);
              const res1 = getIntersectionTheta(body, vInfMs, b1, v1, mu_main);
              if (res1) theta1List.push(res1.thetaA);
            }

            // Sample downstream body b2 envelope independently
            for (let i = 0; i < numSamples; i++) {
              const frac = numSamples === 1 ? 0 : i / (numSamples - 1);
              const v2 = env2.minMs + frac * (env2.maxMs - env2.minMs);
              const res2 = getIntersectionTheta(body, vInfMs, b2, v2, mu_main);
              if (res2) theta2List.push(res2.thetaA);
            }

            const srcName = srcInst.label ? `${b1.name} (${srcInst.label})` : `${b1.name} (${srcInst.id})`;
            const tgtName = tgtInst.label ? `${b2.name} (${tgtInst.label})` : `${b2.name} (${tgtInst.id})`;

            if (theta1List.length === 0) {
              failReason = `v_inf (${formatKms(vInfMs / 1000)} km/s) exceeds connectable range with upstream ${srcName} envelope [${formatKms(env1.minMs / 1000)}, ${formatKms(env1.maxMs / 1000)}] km/s`;
              continue;
            }

            if (theta2List.length === 0) {
              failReason = `v_inf (${formatKms(vInfMs / 1000)} km/s) exceeds connectable range with downstream ${tgtName} envelope [${formatKms(env2.minMs / 1000)}, ${formatKms(env2.maxMs / 1000)}] km/s`;
              continue;
            }

            const minT1 = Math.min(...theta1List);
            const maxT1 = Math.max(...theta1List);
            const minT2 = Math.min(...theta2List);
            const maxT2 = Math.max(...theta2List);

            const minDeflectionRad = Math.max(0, minT2 - maxT1, minT1 - maxT2);

            if (minDeflectionRad <= deltaMaxRad + 1e-4) {
              satisfiesPair = true;
              break;
            } else {
              const reqDeg = (minDeflectionRad * 180) / Math.PI;
              failReason = `Deflection required (${reqDeg.toFixed(1)}°) to connect ${srcName} & ${tgtName} > max allowed δ (${deltaMaxDeg.toFixed(1)}°)`;
            }
          }
          if (satisfiesPair) break;
        }

        return { isValid: satisfiesPair, reason: failReason, relatedInsts: Array.from(relatedMap.values()) };
      } else if (inLinks.length > 0) {
        // Target / Terminal instance: must intersect at least one incoming upstream instance envelope
        let satisfiesNeigh = false;
        let failReason = '';

        for (const inLink of inLinks) {
          const srcInst = instMap.get(inLink.sourceInstanceId);
          if (!srcInst) continue;
          const nb = bodyMap.get(srcInst.bodyName);
          const envNb = activeInstanceEnvelopes[srcInst.id];
          if (!nb || !envNb || (envNb.minMs === 0 && envNb.maxMs === 0)) continue;

          relatedMap.set(srcInst.id, { id: srcInst.id, bodyName: nb.name, label: srcInst.label, minMs: envNb.minMs, maxMs: envNb.maxMs });

          const numSamplesUp: number = 30;
          for (let i = 0; i < numSamplesUp; i++) {
            const frac = numSamplesUp === 1 ? 0 : i / (numSamplesUp - 1);
            const vNb = envNb.minMs + frac * (envNb.maxMs - envNb.minMs);
            if (getIntersectionTheta(body, vInfMs, nb, vNb, mu_main) !== null) {
              satisfiesNeigh = true;
              break;
            }
          }
          if (satisfiesNeigh) break;
          const srcName = srcInst.label ? `${nb.name} (${srcInst.label})` : `${nb.name} (${srcInst.id})`;
          failReason = `v_inf (${formatKms(vInfMs / 1000)} km/s) exceeds connectable range with upstream ${srcName} envelope [${formatKms(envNb.minMs / 1000)}, ${formatKms(envNb.maxMs / 1000)}] km/s`;
        }

        return { isValid: satisfiesNeigh, reason: failReason, relatedInsts: Array.from(relatedMap.values()) };
      } else if (outLinks.length > 0) {
        // Source / Launch instance: must intersect at least one outgoing downstream instance envelope
        let satisfiesNeigh = false;
        let failReason = '';

        for (const outLink of outLinks) {
          const tgtInst = instMap.get(outLink.targetInstanceId);
          if (!tgtInst) continue;
          const nb = bodyMap.get(tgtInst.bodyName);
          const envNb = activeInstanceEnvelopes[tgtInst.id];
          if (!nb || !envNb || (envNb.minMs === 0 && envNb.maxMs === 0)) continue;

          relatedMap.set(tgtInst.id, { id: tgtInst.id, bodyName: nb.name, label: tgtInst.label, minMs: envNb.minMs, maxMs: envNb.maxMs });

          const numSamplesDn: number = 30;
          for (let i = 0; i < numSamplesDn; i++) {
            const frac = numSamplesDn === 1 ? 0 : i / (numSamplesDn - 1);
            const vNb = envNb.minMs + frac * (envNb.maxMs - envNb.minMs);
            if (getIntersectionTheta(body, vInfMs, nb, vNb, mu_main) !== null) {
              satisfiesNeigh = true;
              break;
            }
          }
          if (satisfiesNeigh) break;
          const tgtName = tgtInst.label ? `${nb.name} (${tgtInst.label})` : `${nb.name} (${tgtInst.id})`;
          failReason = `v_inf (${formatKms(vInfMs / 1000)} km/s) exceeds connectable range with downstream ${tgtName} envelope [${formatKms(envNb.minMs / 1000)}, ${formatKms(envNb.maxMs / 1000)}] km/s`;
        }

        return { isValid: satisfiesNeigh, reason: failReason, relatedInsts: Array.from(relatedMap.values()) };
      }

      return { isValid: true, reason: '', relatedInsts: [] };
    };

    const getCandidateVInfs = (bodyName: string, minMs: number, maxMs: number): number[] => {
      if (minMs === 0 && maxMs === 0) return [];
      const set = new Set<number>();
      set.add(minMs);
      set.add(maxMs);
      const step = 1000;
      const start = Math.ceil(minMs / step) * step;
      for (let v = start; v <= maxMs; v += step) {
        if (v >= minMs && v <= maxMs) {
          set.add(v);
        }
      }
      return Array.from(set).sort((a, b) => a - b);
    };

    // 2. Iterative "back and forth" envelope reduction pass until fixpoint (1 m/s precision)
    let changed = true;
    let passCount = 0;

    const processInstanceEnvelope = (inst: InstanceNode, sweepDirection: 'forward' | 'backward') => {
      const prep = bodyPrepMap[inst.bodyName];
      if (!prep) return;

      const curInstEnv = activeInstanceEnvelopes[inst.id];
      if (!curInstEnv || (curInstEnv.minMs === 0 && curInstEnv.maxMs === 0)) return;

      const instPrevMinMs = curInstEnv.minMs;
      const instPrevMaxMs = curInstEnv.maxMs;
      const bodyPrevEnv = computeBodyUnionEnvelope(inst.bodyName);

      // Coarse sample over [curInstEnv.minMs, curInstEnv.maxMs] with step = 50 m/s
      const stepMs = 50;
      const coarseSamples: number[] = [];
      for (let v = curInstEnv.minMs; v < curInstEnv.maxMs; v += stepMs) {
        coarseSamples.push(v);
      }
      if (coarseSamples.length === 0 || coarseSamples[coarseSamples.length - 1] !== curInstEnv.maxMs) {
        coarseSamples.push(curInstEnv.maxMs);
      }

      const validCoarseIndices: number[] = [];
      let firstFailTest: { reason: string; relatedInsts: any[] } | null = null;
      let lastFailTest: { reason: string; relatedInsts: any[] } | null = null;

      for (let i = 0; i < coarseSamples.length; i++) {
        const test = testInstanceVInfMsValid(inst, coarseSamples[i]);
        if (test.isValid) {
          validCoarseIndices.push(i);
        } else {
          if (!firstFailTest) firstFailTest = { reason: test.reason, relatedInsts: test.relatedInsts };
          lastFailTest = { reason: test.reason, relatedInsts: test.relatedInsts };
        }
      }

      let newMinMs = 0;
      let newMaxMs = 0;
      let lowReason = firstFailTest?.reason || '';
      let highReason = lastFailTest?.reason || '';
      let lowRelatedInsts = firstFailTest?.relatedInsts || [];
      let highRelatedInsts = lastFailTest?.relatedInsts || [];

      if (validCoarseIndices.length === 0) {
        // Check fine step = 10 m/s just in case a narrow band was missed
        for (let v = curInstEnv.minMs; v <= curInstEnv.maxMs; v += 10) {
          const test = testInstanceVInfMsValid(inst, v);
          if (test.isValid) {
            validCoarseIndices.push(0);
            break;
          }
        }
      }

      if (validCoarseIndices.length === 0) {
        newMinMs = 0;
        newMaxMs = 0;
      } else {
        // Bisection for lower bound (newMinMs) at 1 m/s precision
        const firstValidIdx = validCoarseIndices[0];
        if (firstValidIdx === 0 && testInstanceVInfMsValid(inst, curInstEnv.minMs).isValid) {
          newMinMs = curInstEnv.minMs;
        } else {
          let low = firstValidIdx > 0 ? coarseSamples[firstValidIdx - 1] : curInstEnv.minMs;
          let high = coarseSamples[firstValidIdx];
          while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            const test = testInstanceVInfMsValid(inst, mid);
            if (test.isValid) {
              high = mid;
            } else {
              low = mid;
              lowReason = test.reason;
              lowRelatedInsts = test.relatedInsts;
            }
          }
          newMinMs = high; // smallest valid m/s
        }

        // Bisection for upper bound (newMaxMs) at 1 m/s precision
        const lastValidIdx = validCoarseIndices[validCoarseIndices.length - 1];
        if (lastValidIdx === coarseSamples.length - 1 && testInstanceVInfMsValid(inst, curInstEnv.maxMs).isValid) {
          newMaxMs = curInstEnv.maxMs;
        } else {
          let low = coarseSamples[lastValidIdx];
          let high = lastValidIdx < coarseSamples.length - 1 ? coarseSamples[lastValidIdx + 1] : curInstEnv.maxMs;
          while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            const test = testInstanceVInfMsValid(inst, mid);
            if (test.isValid) {
              low = mid;
            } else {
              high = mid;
              highReason = test.reason;
              highRelatedInsts = test.relatedInsts;
            }
          }
          newMaxMs = low; // largest valid m/s
        }
      }

      if (newMinMs > newMaxMs) {
        newMinMs = 0;
        newMaxMs = 0;
      }

      // Check if instance boundary moved by at least 1 m/s
      if (Math.abs(newMinMs - instPrevMinMs) >= 1 || Math.abs(newMaxMs - instPrevMaxMs) >= 1) {
        activeInstanceEnvelopes[inst.id] = { minMs: newMinMs, maxMs: newMaxMs };

        const bodyNewEnv = computeBodyUnionEnvelope(inst.bodyName);

        const createLogEntry = (
          vInfMs: number,
          reasonStr: string,
          actionType: 'reduced' | 'empty',
          entryNewMinMs: number,
          entryNewMaxMs: number,
          relatedInsts: Array<{ id: string; bodyName: string; label?: string; minMs: number; maxMs: number }>
        ): EnvelopeLogEntry => {
          const inspectionCurves: InspectionCurveData[] = [];
          const primaryPrep = bodyPrepMap[inst.bodyName];

          if (primaryPrep && vInfMs > 0) {
            inspectionCurves.push({
              bodyName: inst.bodyName,
              instanceId: inst.id,
              instanceLabel: inst.label,
              vInfKms: vInfMs / 1000,
              color: primaryPrep.color,
              isPrimary: true,
              role: 'primary_limit',
              curve: primaryPrep.buildCurve(vInfMs),
            });
          }

          relatedInsts.forEach(rel => {
            const relPrep = bodyPrepMap[rel.bodyName];
            if (!relPrep) return;

            if (rel.minMs > 0) {
              inspectionCurves.push({
                bodyName: rel.bodyName,
                instanceId: rel.id,
                instanceLabel: rel.label,
                vInfKms: rel.minMs / 1000,
                color: relPrep.color,
                isPrimary: false,
                role: 'related_envelope_min',
                curve: relPrep.buildCurve(rel.minMs),
              });
            }

            if (rel.maxMs > 0 && Math.abs(rel.maxMs - rel.minMs) > 10) {
              inspectionCurves.push({
                bodyName: rel.bodyName,
                instanceId: rel.id,
                instanceLabel: rel.label,
                vInfKms: rel.maxMs / 1000,
                color: relPrep.color,
                isPrimary: false,
                role: 'related_envelope_max',
                curve: relPrep.buildCurve(rel.maxMs),
              });
            }
          });

          return {
            pass: passCount,
            sweepDirection,
            instanceId: inst.id,
            instanceLabel: inst.label,
            bodyName: inst.bodyName,
            instPrevMinKms: instPrevMinMs / 1000,
            instPrevMaxKms: instPrevMaxMs / 1000,
            instNewMinKms: entryNewMinMs / 1000,
            instNewMaxKms: entryNewMaxMs / 1000,
            bodyPrevMinKms: bodyPrevEnv.minMs / 1000,
            bodyPrevMaxKms: bodyPrevEnv.maxMs / 1000,
            bodyNewMinKms: bodyNewEnv.minMs / 1000,
            bodyNewMaxKms: bodyNewEnv.maxMs / 1000,
            action: actionType,
            reason: reasonStr,
            inspection: {
              primaryBodyName: inst.bodyName,
              primaryInstanceId: inst.id,
              primaryInstanceLabel: inst.label,
              primaryVInfMs: vInfMs,
              relatedInstances: relatedInsts,
              inspectionCurves,
            },
          };
        };

        if (newMinMs === 0 && newMaxMs === 0) {
          let reasonStr = '';
          const minKms = formatKms(instPrevMinMs / 1000);
          const maxKms = formatKms(instPrevMaxMs / 1000);

          if (firstFailTest && lastFailTest) {
            reasonStr = `Envelope emptied: No valid v_inf in [${minKms}, ${maxKms}] km/s satisfies constraints. At min v_inf (${minKms} km/s): ${firstFailTest.reason}. At max v_inf (${maxKms} km/s): ${lastFailTest.reason}`;
          } else if (lowReason) {
            reasonStr = `Envelope emptied: Constraint failure (${lowReason})`;
          } else {
            reasonStr = `Envelope emptied: No valid v_inf in range [${minKms}, ${maxKms}] km/s satisfies flyby criteria`;
          }

          envelopeLogs.push(createLogEntry(
            instPrevMinMs || 1000,
            reasonStr,
            'empty',
            0,
            0,
            lowRelatedInsts.length > 0 ? lowRelatedInsts : highRelatedInsts
          ));
        } else {
          // Push separate lower bound log entry if lower bound was raised
          if (newMinMs > instPrevMinMs + 0.5) {
            const lowReasonStr = `Lower bound raised to ${formatKms(newMinMs / 1000)} km/s (${lowReason || 'deflection/crossing limit'})`;
            envelopeLogs.push(createLogEntry(
              newMinMs,
              lowReasonStr,
              'reduced',
              newMinMs,
              newMaxMs < instPrevMaxMs ? newMaxMs : instPrevMaxMs,
              lowRelatedInsts
            ));
          }

          // Push separate upper bound log entry if upper bound was reduced
          if (newMaxMs < instPrevMaxMs - 0.5) {
            const highReasonStr = `Upper bound reduced to ${formatKms(newMaxMs / 1000)} km/s (${highReason || 'deflection/crossing limit'})`;
            envelopeLogs.push(createLogEntry(
              newMaxMs,
              highReasonStr,
              'reduced',
              newMinMs > instPrevMinMs ? newMinMs : instPrevMinMs,
              newMaxMs,
              highRelatedInsts
            ));
          }
        }

        activeBodyEnvelopes[inst.bodyName] = bodyNewEnv;
        changed = true;
      }
    };

    while (changed && passCount < 20) {
      changed = false;
      passCount++;

      // Forward Sweep (Source -> Target: instances sequence)
      for (const inst of instances) {
        processInstanceEnvelope(inst, 'forward');
      }

      // Backward Sweep (Target -> Source: reverse instances sequence)
      for (const inst of [...instances].reverse()) {
        processInstanceEnvelope(inst, 'backward');
      }
    }

    // 3. Construct final BodyTisserandData objects & summaries
    const finalBodyDataList = canvasBodies.map(body => {
      const prep = bodyPrepMap[body.name];
      const env = activeBodyEnvelopes[body.name] || { minMs: 0, maxMs: 0 };
      const validVInfs = env.minMs > 0 ? getCandidateVInfs(body.name, env.minMs, env.maxMs) : [];
      const finalCurves = validVInfs.map(v => prep.buildCurve(v));

      return {
        body: prep.body,
        a_p: prep.a_p,
        v_p: prep.v_p,
        r_p_min: prep.r_p_min,
        vInf5DegMs: prep.vInf5DegMs,
        maxC3Ms2: prep.maxC3Val,
        vInfMaxMs: env.maxMs,
        curves: finalCurves,
        color: prep.color,
      };
    });

    const bodyEnvelopeSummaries: BodyEnvelopeSummary[] = canvasBodies.map(body => {
      const prep = bodyPrepMap[body.name];
      const env = activeBodyEnvelopes[body.name] || { minMs: 0, maxMs: 0 };
      const validVInfs = env.minMs > 0 ? getCandidateVInfs(body.name, env.minMs, env.maxMs) : [];
      return {
        bodyName: body.name,
        color: prep.color,
        maxC3Kms2: prep.maxC3Val,
        minVinfKms: env.minMs / 1000,
        maxVinfKms: env.maxMs / 1000,
        activeCount: validVInfs.length,
      };
    });

    return {
      bodyDataList: finalBodyDataList,
      envelopeLogs,
      bodyEnvelopeSummaries,
    };
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

            <div className="flex items-center gap-3 text-[11px] text-[#94A3B8] font-mono flex-wrap">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-0.5 bg-[#38BDF8] inline-block" /> v_inf lines (1 km/s to max)
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full border border-white bg-white/40 inline-block" /> 1/10th δ_max graduations
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[#38BDF8] border border-white inline-block" /> Planet Orbit Point
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-0.5 border-b border-dashed border-[#38BDF8] inline-block" /> Hohmann transfer & rₚ lines
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

          {/* Active Inspection Banner */}
          {inspectedLogIndex !== null && envelopeLogs[inspectedLogIndex] && (
            <div className="flex items-center justify-between gap-2 bg-amber-950/70 border border-amber-500/60 px-3 py-2 rounded text-xs font-mono text-amber-200 shadow-lg">
              <div className="flex items-center gap-2 flex-wrap">
                <Search className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="font-bold text-amber-300">
                  Inspecting Log #{inspectedLogIndex + 1}:
                </span>
                <span>
                  Instance <strong>{envelopeLogs[inspectedLogIndex].bodyName}{envelopeLogs[inspectedLogIndex].instanceLabel ? ` (${envelopeLogs[inspectedLogIndex].instanceLabel})` : ''}</strong>
                </span>
                <span className="text-amber-400/80">
                  • Forced curves highlighted in <span className="text-amber-300 font-bold">amber</span> (primary bound) & <span className="text-sky-300 font-bold">sky blue</span> (connected envelopes)
                </span>
              </div>
              <button
                onClick={() => setInspectedLogIndex(null)}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-900/80 hover:bg-amber-800 text-amber-100 border border-amber-500/50 transition cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear Inspection</span>
              </button>
            </div>
          )}

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

                {/* Render Body Curves, Planet Points, Hohmann Lines, and Graduations */}
                {bodyDataList.map(data => {
                  const isHidden = selectedBodyNames[data.body.name] === false;
                  if (isHidden) return null;

                  const a_body = data.body.semiMajorAxis; // in meters
                  const E_body = -mu_main / (2 * a_body); // in J/kg
                  const log10_a = Math.log10(a_body);

                  const planetX = projectX(log10_a);
                  const planetY = projectY(E_body);

                  // Hohmann Transfer Energy Curve to data.body from lower rp
                  const hohmannPts: string[] = [];
                  const minRpHohmann = Math.max(1e3, Math.min(Math.pow(10, activeBounds.minLogRp - 0.5), a_body * 0.001));
                  const stepCount = 80;
                  const logMin = Math.log10(minRpHohmann);
                  const logMax = log10_a;

                  if (logMax > logMin) {
                    for (let i = 0; i <= stepCount; i++) {
                      const curLogRp = logMin + (i / stepCount) * (logMax - logMin);
                      const curRp = Math.pow(10, curLogRp);
                      const curE = -mu_main / (curRp + a_body); // Specific energy for Hohmann transfer from curRp to a_body
                      const hx = projectX(curLogRp);
                      const hy = projectY(curE);
                      hohmannPts.push(`${i === 0 ? 'M' : 'L'} ${hx} ${hy}`);
                    }
                  }
                  const hohmannD = hohmannPts.join(' ');

                  const isFlybyBody = (flybyConnectedPairsMap[data.body.name] || []).length > 0;

                  return (
                    <g key={`body-group-${data.body.name}`}>
                      {/* Hohmann transfer energy line in light dots */}
                      {hohmannD && (
                        <path
                          d={hohmannD}
                          fill="none"
                          stroke={data.color}
                          strokeWidth={1.2}
                          strokeDasharray="2 3"
                          opacity={0.55}
                        />
                      )}

                      {/* Vertical line in light dots for rp corresponding to the body (from E_body up to top of graph) */}
                      <line
                        x1={planetX}
                        y1={planetY}
                        x2={planetX}
                        y2={margin.top}
                        stroke={data.color}
                        strokeWidth={1.2}
                        strokeDasharray="2 3"
                        opacity={0.55}
                      />

                      {/* Planet Orbit Single Point */}
                      <g key={`planet-point-${data.body.name}`}>
                        <circle
                          cx={planetX}
                          cy={planetY}
                          r={5}
                          fill={data.color}
                          stroke="#FFFFFF"
                          strokeWidth={1.5}
                        />
                        <text
                          x={planetX + 7}
                          y={planetY - 6}
                          fill={data.color}
                          fontSize={10}
                          fontFamily="sans-serif"
                          fontWeight="bold"
                        >
                          {data.body.name}
                        </text>
                        {/* Transparent hover hit target */}
                        <circle
                          cx={planetX}
                          cy={planetY}
                          r={10}
                          fill="transparent"
                          className="cursor-pointer"
                          onMouseEnter={() => {
                            setHoverInfo({
                              pctX: (planetX / svgWidth) * 100,
                              pctY: (planetY / svgHeight) * 100,
                              bodyName: data.body.name,
                              label: 'Planet Orbit Point',
                              E_MJ: E_body / 1e6,
                              rpKm: a_body / 1000,
                              rpAU: a_body / 1.495978707e11,
                              log10rp: log10_a,
                            });
                          }}
                          onMouseLeave={() => setHoverInfo(null)}
                        />
                      </g>

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

              {/* Inspected Curves Overlay when an Evolution Log entry is selected */}
              {inspectedLogIndex !== null && envelopeLogs[inspectedLogIndex]?.inspection && (
                <g key={`inspected-overlay-${inspectedLogIndex}`}>
                  {envelopeLogs[inspectedLogIndex].inspection?.inspectionCurves.map((ic, iIdx) => {
                    if (ic.curve.points.length < 2) return null;

                    const pathD = ic.curve.points.reduce((acc, p, idx) => {
                      const px = projectX(p.log10rp);
                      const py = projectY(p.E);
                      return idx === 0 ? `M ${px} ${py}` : `${acc} L ${px} ${py}`;
                    }, '');

                    const isPrimary = ic.isPrimary;
                    const strokeColor = isPrimary ? '#F59E0B' : '#38BDF8';
                    const strokeDash = isPrimary ? 'none' : '6 3';
                    const labelText = isPrimary
                      ? `[PRIMARY] ${ic.bodyName}${ic.instanceLabel ? ` (${ic.instanceLabel})` : ''}: ${ic.vInfKms.toFixed(3)} km/s`
                      : `[BOUND] ${ic.bodyName}${ic.instanceLabel ? ` (${ic.instanceLabel})` : ''}: ${ic.vInfKms.toFixed(3)} km/s`;

                    return (
                      <g key={`inspection-curve-${iIdx}`}>
                        {/* Glow outline */}
                        <path
                          d={pathD}
                          fill="none"
                          stroke={strokeColor}
                          strokeWidth={isPrimary ? 6 : 4}
                          opacity={0.35}
                        />
                        {/* Crisp curve */}
                        <path
                          d={pathD}
                          fill="none"
                          stroke={strokeColor}
                          strokeWidth={isPrimary ? 2.8 : 2}
                          strokeDasharray={strokeDash}
                        />
                        {/* Label */}
                        {ic.curve.points.length > 0 && (
                          <text
                            x={projectX(ic.curve.points[ic.curve.points.length - 1].log10rp) + 6}
                            y={projectY(ic.curve.points[ic.curve.points.length - 1].E) + 4}
                            fill={strokeColor}
                            fontSize={10}
                            fontFamily="monospace"
                            fontWeight="bold"
                          >
                            {labelText}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              )}
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
                className="absolute z-20 bg-[#0F172A] border border-[#38BDF8] text-white p-2.5 rounded shadow-2xl text-xs font-mono pointer-events-none flex flex-col gap-1 min-w-[210px]"
                style={{
                  left: `${hoverInfo.pctX}%`,
                  top: `${hoverInfo.pctY}%`,
                  transform: 'translate(-50%, -115%)',
                }}
              >
                <div className="flex items-center justify-between border-b border-slate-700 pb-1 gap-2">
                  <span className="font-bold text-[#38BDF8]">{hoverInfo.bodyName}</span>
                  {hoverInfo.label && (
                    <span className="text-[10px] text-amber-300 font-sans px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 font-medium">
                      {hoverInfo.label}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                  {hoverInfo.vInfKms !== undefined && (
                    <>
                      <span className="text-slate-400">v_inf:</span>
                      <span className="text-right font-bold text-emerald-400">{hoverInfo.vInfKms.toFixed(2)} km/s</span>
                    </>
                  )}

                  {hoverInfo.deflexionMaxDeg !== undefined && (
                    <>
                      <span className="text-slate-400">Deflection Max δ:</span>
                      <span className="text-right font-bold text-amber-300">{hoverInfo.deflexionMaxDeg.toFixed(2)}°</span>
                    </>
                  )}

                  <span className="text-slate-400">Energy E:</span>
                  <span className="text-right font-bold text-sky-300">{hoverInfo.E_MJ.toFixed(2)} MJ/kg</span>

                  <span className="text-slate-400">Periapsis rₚ:</span>
                  <span className="text-right font-bold text-purple-300">
                    {hoverInfo.rpKm >= 1e6
                      ? `${(hoverInfo.rpKm).toExponential(2)} km`
                      : `${Math.round(hoverInfo.rpKm).toLocaleString()} km`}
                  </span>

                  {hoverInfo.rpAU !== undefined && (
                    <>
                      <span className="text-slate-400">rₚ (AU):</span>
                      <span className="text-right font-bold text-slate-200">{hoverInfo.rpAU.toFixed(3)} AU</span>
                    </>
                  )}

                  {hoverInfo.log10rp !== undefined && (
                    <>
                      <span className="text-slate-400">log₁₀(rₚ [m]):</span>
                      <span className="text-right font-bold text-amber-300">{hoverInfo.log10rp.toFixed(3)}</span>
                    </>
                  )}
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
              <span>{showDebugPanel ? 'Hide' : 'Show'} v_inf Envelope Evolution Log ({envelopeLogs.length} updates)</span>
              {showDebugPanel ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            <div className="text-[11px] text-slate-400 flex items-center gap-3 font-mono">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-sky-500 inline-block"></span>
                Active Bodies: {bodyEnvelopeSummaries.filter(s => s.activeCount > 0).length}
              </span>
            </div>
          </div>

          {/* Debug Panel Details */}
          {showDebugPanel && (
            <div className="mt-3 p-4 rounded-lg bg-slate-950 border border-slate-800 flex flex-col gap-4 text-xs">
              {/* Converged Envelopes Summary Cards */}
              <div>
                <div className="text-slate-400 text-[11px] font-semibold uppercase tracking-wider mb-2 flex items-center justify-between">
                  <span>Converged v_inf Envelopes per Body</span>
                  <span className="text-[10px] text-slate-500 font-normal font-mono">minVinf = 0, maxVinf = sqrt(maxC3) or 5° limit</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {bodyEnvelopeSummaries.map(s => (
                    <div
                      key={s.bodyName}
                      className="p-2.5 rounded border border-slate-800 bg-slate-900/80 flex flex-col gap-1 font-mono"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-100 flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }}></span>
                          {s.bodyName}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-sky-300 font-semibold">
                          {s.activeCount} lines
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-300">
                        Envelope: <strong className="text-amber-300">[{formatKms(s.minVinfKms)} - {formatKms(s.maxVinfKms)}] km/s</strong>
                      </div>
                      {s.maxC3Kms2 !== undefined && (
                        <div className="text-[10px] text-slate-400">
                          maxC3 = {s.maxC3Kms2.toFixed(1)} km²/s² (sqrt = {Math.sqrt(s.maxC3Kms2).toFixed(1)} km/s)
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Filter & Evolution Logs */}
              <div className="border-t border-slate-800/80 pt-3">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-2.5">
                  <span className="text-slate-400 text-[11px] font-semibold uppercase tracking-wider">
                    Evolution Log (Back & Forth Reductions)
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 text-[11px] font-medium">Filter Body:</span>
                    <select
                      value={debugBodyFilter}
                      onChange={e => setDebugBodyFilter(e.target.value)}
                      className="bg-slate-900 text-slate-200 border border-slate-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-sky-500"
                    >
                      <option value="ALL">All Bodies</option>
                      {bodyEnvelopeSummaries.map(s => (
                        <option key={s.bodyName} value={s.bodyName}>{s.bodyName}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto pr-1">
                  {envelopeLogs
                    .filter(log => debugBodyFilter === 'ALL' || log.bodyName === debugBodyFilter)
                    .map((log, idx) => {
                      const color = bodyEnvelopeSummaries.find(s => s.bodyName === log.bodyName)?.color || '#38BDF8';
                      const isInspected = inspectedLogIndex === idx;

                      return (
                        <div
                          key={`log-${idx}`}
                          className={`p-3 rounded-lg border font-mono text-[11px] flex flex-col gap-2 transition ${
                            isInspected
                              ? 'border-amber-500 bg-amber-950/30 ring-1 ring-amber-500/50 shadow-md'
                              : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                          }`}
                        >
                          {/* Header Line */}
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-300 font-semibold">
                                {log.pass === 0 ? 'Init' : `Pass ${log.pass} (${log.sweepDirection === 'backward' ? 'Backward ◄' : 'Forward ►'})`}
                              </span>
                              <span className="font-bold text-slate-100 flex items-center gap-1.5">
                                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }}></span>
                                Instance: {log.bodyName}{log.instanceLabel ? ` (${log.instanceLabel})` : ''}
                              </span>
                              <span className="text-slate-400 text-[10px]">
                                (ID: {log.instanceId})
                              </span>
                            </div>

                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                log.action === 'initialized'
                                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                  : log.action === 'reduced'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                  : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                              }`}
                            >
                              {log.action}
                            </span>
                          </div>

                          {/* Impact Metrics Grid */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] bg-slate-950/70 p-2 rounded border border-slate-800/80">
                            <div>
                              <span className="text-slate-400 block text-[10px]">Instance Range:</span>
                              <span className="text-slate-300">
                                [{formatKms(log.instPrevMinKms)} - {formatKms(log.instPrevMaxKms)}] km/s
                              </span>
                              <span className="text-sky-400 mx-1">➔</span>
                              <span className="text-amber-300 font-bold">
                                [{formatKms(log.instNewMinKms)} - {formatKms(log.instNewMaxKms)}] km/s
                              </span>
                            </div>

                            <div>
                              <span className="text-slate-400 block text-[10px]">Body ({log.bodyName}) Union Impact:</span>
                              <span className="text-slate-300">
                                [{formatKms(log.bodyPrevMinKms)} - {formatKms(log.bodyPrevMaxKms)}] km/s
                              </span>
                              <span className="text-sky-400 mx-1">➔</span>
                              <span className="text-amber-300 font-bold">
                                [{formatKms(log.bodyNewMinKms)} - {formatKms(log.bodyNewMaxKms)}] km/s
                              </span>
                            </div>
                          </div>

                          {/* Interactive Explanation Box with Copy & Graph Inspection */}
                          <div className={`p-3 rounded-lg border flex flex-col gap-2 transition ${
                            isInspected
                              ? 'bg-amber-950/30 border-amber-500/80'
                              : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'
                          }`}>
                            <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2 flex-wrap">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                                <Info className="w-3.5 h-3.5 text-sky-400" />
                                <span>Explanation & Reason:</span>
                              </div>

                              <div className="flex items-center gap-2">
                                {/* Copy Button */}
                                <button
                                  type="button"
                                  onClick={(e) => handleCopyLogReason(log, idx, e)}
                                  title="Copy text to clipboard"
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-slate-200 border border-slate-700 transition cursor-pointer shrink-0"
                                >
                                  {copiedLogIndex === idx ? (
                                    <>
                                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                                      <span className="text-emerald-400 font-bold">Copied!</span>
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3.5 h-3.5 text-slate-300" />
                                      <span>Copy text</span>
                                    </>
                                  )}
                                </button>

                                {/* Force Display / Inspect Button */}
                                <button
                                  type="button"
                                  onClick={() => setInspectedLogIndex(isInspected ? null : idx)}
                                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono border transition cursor-pointer shrink-0 ${
                                    isInspected
                                      ? 'bg-amber-500 text-slate-950 font-bold border-amber-400 shadow-md'
                                      : 'bg-sky-950/80 hover:bg-sky-900 text-sky-300 border-sky-700/80'
                                  }`}
                                >
                                  <Search className="w-3.5 h-3.5" />
                                  <span>{isInspected ? '✓ Inspecting on graph' : '🔍 Inspect on graph'}</span>
                                </button>
                              </div>
                            </div>

                            {/* Selectable & Copyable Text */}
                            <div className="select-text cursor-text text-xs text-slate-200 font-sans leading-relaxed pt-0.5">
                              {log.reason}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
