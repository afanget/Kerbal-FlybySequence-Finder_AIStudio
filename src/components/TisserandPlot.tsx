import React, { useState, useMemo, useRef } from 'react';
import { CelestialBody, InstanceNode, FlyableSequenceResult } from '../types';
import { ChevronDown, ChevronUp, Layers, Info, Eye, EyeOff, Sparkles, Activity, ZoomIn, ZoomOut, RotateCcw, Move } from 'lucide-react';

interface TisserandPlotProps {
  instances: InstanceNode[];
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

export const TisserandPlot: React.FC<TisserandPlotProps> = ({
  instances,
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

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Get unique list of bodies used in the canvas (excluding the main central body)
  const canvasBodies = useMemo(() => {
    const names = Array.from(new Set(instances.map(i => i.bodyName)));
    return bodies.filter(b => names.includes(b.name) && b.name !== mainBody.name);
  }, [instances, bodies, mainBody]);

  // Main body gravitational parameter
  const mu_main = mainBody.stdGravParam;

  // Process Tisserand data for each canvas body
  const bodyDataList = useMemo<BodyTisserandData[]>(() => {
    return canvasBodies.map((body, idx) => {
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

      // Calculate vInf allowing 5 deg deflection:
      // delta_max = 2 * asin( 1 / (1 + r_p_min * vInf^2 / mu_b) ) = 5 deg
      const targetDeltaRad = (5 * Math.PI) / 180;
      const sinHalfDelta = Math.sin(targetDeltaRad / 2);
      const vInf5DegMs = Math.sqrt(((1 / sinHalfDelta) - 1) * mu_b / r_p_min);

      let vInfMaxMs = vInf5DegMs;
      if (maxC3Val !== undefined && maxC3Val > 0) {
        const vInfC3 = Math.sqrt(maxC3Val) * 1000; // maxC3 is in km^2/s^2
        vInfMaxMs = Math.min(vInfMaxMs, vInfC3);
      }

      // Ensure vInfMax is at least 1000 m/s for display
      vInfMaxMs = Math.max(1000, vInfMaxMs);

      // Helper to generate a single vInf curve
      const buildCurve = (vInfMs: number): VInfCurveData => {
        const numPoints = 80;
        const points: VInfCurvePoint[] = [];

        const thetaMax = vInfMs >= v_p ? Math.acos(-v_p / vInfMs) : Math.PI;

        for (let i = 0; i <= numPoints; i++) {
          const theta = (i / numPoints) * thetaMax;
          const h = a_p * (v_p + vInfMs * Math.cos(theta));
          if (h <= 0) continue;

          const v_sc2 = v_p * v_p + vInfMs * vInfMs + 2 * v_p * vInfMs * Math.cos(theta);
          const E = 0.5 * v_sc2 - mu_main / a_p; // J/kg

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

        // Deflection delta_max
        const sinHalfDeltaMax = Math.min(1, Math.max(0, 1 / (1 + (r_p_min * vInfMs * vInfMs) / mu_b)));
        const deltaMaxRad = 2 * Math.asin(sinHalfDeltaMax);
        const deltaMaxDeg = (deltaMaxRad * 180) / Math.PI;

        // Graduations corresponding to step deltaMaxRad / 10
        const graduations: VInfGraduation[] = [];
        for (let thetaKRad = 0; thetaKRad <= thetaMax; thetaKRad += deltaMaxRad / 10) {
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

      // Generate integer vInf curves from 1 km/s to vInfMax (step 1 km/s)
      const curves: VInfCurveData[] = [];
      const stepMs = 1000;
      for (let v = 1000; v <= vInfMaxMs; v += stepMs) {
        curves.push(buildCurve(v));
      }
      // Add final curve if vInfMax is not an exact multiple of 1000 m/s
      if (vInfMaxMs % 1000 > 100) {
        curves.push(buildCurve(vInfMaxMs));
      }

      let maxC3Curve: VInfCurveData | undefined = undefined;
      if (maxC3Val !== undefined && maxC3Val > 0) {
        maxC3Curve = buildCurve(Math.sqrt(maxC3Val) * 1000);
      }

      const color = body.color || DEFAULT_BODY_COLORS[body.name] || `hsl(${(idx * 137.5) % 360}, 80%, 65%)`;

      return {
        body,
        a_p,
        v_p,
        r_p_min,
        vInf5DegMs,
        maxC3Ms2: maxC3Val,
        vInfMaxMs,
        curves,
        maxC3Curve,
        color,
      };
    });
  }, [canvasBodies, instances, mu_main]);

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

                            {/* Deflection graduations along vInf line */}
                            {curve.graduations.map((grad, gIdx) => {
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
        </div>
      )}
    </div>
  );
};
