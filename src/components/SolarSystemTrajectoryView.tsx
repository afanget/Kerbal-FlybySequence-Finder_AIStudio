/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { FlyableSequenceResult, CelestialBody } from '../types';
import {
  getBodyStateAtUT,
  getGravitationalParameter,
  stateToOrbitalElements,
  getPositionFromOrbitalElements,
  solveKeplerEquation,
  solveHyperbolicKeplerEquation,
  Vector3D,
  StateVector,
  OrbitalElements,
  vecSub,
  vecMag
} from '../physics/kepler';
import { solveLambert } from '../physics/lambert';
import { formatUT, formatShortUT, formatDuration, daysToSeconds } from '../utils/timeFormat';
import { Play, Pause, RotateCcw, ZoomIn, ZoomOut, Maximize2, Sparkles, Navigation, Bug, ChevronDown, ChevronUp, Terminal } from 'lucide-react';

interface SolarSystemTrajectoryViewProps {
  sequence: FlyableSequenceResult;
  bodies: CelestialBody[];
  mainBody: CelestialBody;
  timeFormatMode: 'ksp' | 'earth';
}

interface TransferArc {
  sourceName: string;
  targetName: string;
  depDate: number;
  arrDate: number;
  points: { x: number; y: number; ut: number }[];
}

export interface TransferArcDebugData {
  legIndex: number;
  sourceName: string;
  targetName: string;
  depDate: number;
  arrDate: number;
  dt: number;
  sourceStateAtDep: StateVector;
  targetStateAtArr: StateVector;
  vSpacecraftDep: Vector3D;
  vSpacecraftArr: Vector3D;
  vInfDep: Vector3D;
  vInfArr: Vector3D;
  computedElementsDep: OrbitalElements;
  computedElementsArr: OrbitalElements;
  computedElementsArrAtDepEpoch: OrbitalElements;
  vTransDepFromTransfer?: [number, number, number];
  vTransArrFromTransfer?: [number, number, number];
  lambertV1?: Vector3D;
  lambertV2?: Vector3D;
}

export function shiftOrbitalElementsEpoch(
  elements: OrbitalElements,
  targetEpoch: number,
  mu: number
): OrbitalElements {
  const dt = targetEpoch - elements.epoch;
  const absA = Math.abs(elements.semiMajorAxis);
  if (absA === 0 || mu <= 0) return { ...elements, epoch: targetEpoch };

  const n = Math.sqrt(mu / Math.pow(absA, 3));
  let M_new = elements.meanAnomalyEpoch + n * dt;
  const e = elements.eccentricity;
  let nu_new = 0;

  if (e < 0.99999) {
    M_new = M_new % (2 * Math.PI);
    if (M_new < 0) M_new += 2 * Math.PI;
    const E = solveKeplerEquation(M_new, e);
    const xOrb = absA * (Math.cos(E) - e);
    const yOrb = absA * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    nu_new = Math.atan2(yOrb, xOrb);
    if (nu_new < 0) nu_new += 2 * Math.PI;
  } else {
    const H = solveHyperbolicKeplerEquation(M_new, e);
    const xOrb = absA * (e - Math.cosh(H));
    const yOrb = absA * Math.sqrt(Math.max(0, e * e - 1)) * Math.sinh(H);
    nu_new = Math.atan2(yOrb, xOrb);
    if (nu_new < 0) nu_new += 2 * Math.PI;
  }

  return {
    ...elements,
    meanAnomalyEpoch: M_new,
    trueAnomalyEpoch: nu_new,
    epoch: targetEpoch
  };
}

export const SolarSystemTrajectoryView: React.FC<SolarSystemTrajectoryViewProps> = ({
  sequence,
  bodies,
  mainBody,
  timeFormatMode,
}) => {
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showDebug, setShowDebug] = useState<boolean>(false);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentUt, setCurrentUt] = useState<number>(sequence.depDate);
  const animRef = useRef<number | null>(null);

  const muCentral = getGravitationalParameter(mainBody);

  // Collect all unique bodies involved in sequence + major planets orbiting mainBody
  const sequenceBodyNames = sequence.bodyNames;
  const sunOrbiters = useMemo(() => {
    return bodies.filter(b => (!b.referenceBody || b.referenceBody === mainBody.name) && b.name !== mainBody.name);
  }, [bodies, mainBody]);

  // Compute transfer trajectory arcs & debug details
  const { transferArcs, transferDebugs } = useMemo<{ transferArcs: TransferArc[]; transferDebugs: TransferArcDebugData[] }>(() => {
    const arcs: TransferArc[] = [];
    const debugs: TransferArcDebugData[] = [];

    sequence.transfers.forEach((tr, idx) => {
      const sourceName = sequence.bodyNames[idx];
      const targetName = sequence.bodyNames[idx + 1];
      const sourceBody = bodies.find(b => b.name === sourceName);
      const targetBody = bodies.find(b => b.name === targetName);

      if (!sourceBody || !targetBody) return;

      // Position of source body at departure & target body at arrival
      const sourceStateAtDep = getBodyStateAtUT(sourceBody, mainBody, tr.depDate);
      const targetStateAtArr = getBodyStateAtUT(targetBody, mainBody, tr.arrDate);

      const dt = tr.arrDate - tr.depDate;
      if (dt <= 0) return;

      const minAllowedRadius = 1.1 * (mainBody.radius + (mainBody.atmosphereHeight || 0));
      const lambertSol = solveLambert(sourceStateAtDep.pos, targetStateAtArr.pos, dt, muCentral, true, minAllowedRadius);

      // Departure velocity vector in central frame (use stored solver vector if available)
      const vSpacecraftDep: Vector3D = tr.vTransDep
        ? { x: tr.vTransDep[0], y: tr.vTransDep[1], z: tr.vTransDep[2] }
        : lambertSol.v1;

      const vSpacecraftArr: Vector3D = tr.vTransArr
        ? { x: tr.vTransArr[0], y: tr.vTransArr[1], z: tr.vTransArr[2] }
        : lambertSol.v2;

      const vInfDep = vecSub(vSpacecraftDep, sourceStateAtDep.vel);
      const vInfArr = vecSub(vSpacecraftArr, targetStateAtArr.vel);

      // Compute orbital elements for transfer arc from departure state (sourceStateAtDep.pos + vSpacecraftDep at depDate)
      const computedElementsDep = stateToOrbitalElements(sourceStateAtDep.pos, vSpacecraftDep, muCentral, tr.depDate);

      // Compute orbital elements for transfer arc from arrival state (targetStateAtArr.pos + vSpacecraftArr at arrDate)
      const computedElementsArr = stateToOrbitalElements(targetStateAtArr.pos, vSpacecraftArr, muCentral, tr.arrDate);

      // Compute arrival orbital elements evaluated at the SAME epoch as departure (tr.depDate)
      const computedElementsArrAtDepEpoch = shiftOrbitalElementsEpoch(computedElementsArr, tr.depDate, muCentral);

      // Sample points along transfer duration using Kepler orbital elements
      const sampleCount = 120;
      const points: { x: number; y: number; ut: number }[] = [];

      for (let i = 0; i <= sampleCount; i++) {
        const ut = tr.depDate + (i / sampleCount) * dt;
        const pos = getPositionFromOrbitalElements(computedElementsDep, muCentral, ut);
        points.push({ x: pos.x, y: pos.y, ut });
      }

      arcs.push({
        sourceName,
        targetName,
        depDate: tr.depDate,
        arrDate: tr.arrDate,
        points
      });

      debugs.push({
        legIndex: idx + 1,
        sourceName,
        targetName,
        depDate: tr.depDate,
        arrDate: tr.arrDate,
        dt,
        sourceStateAtDep,
        targetStateAtArr,
        vSpacecraftDep,
        vSpacecraftArr,
        vInfDep,
        vInfArr,
        computedElementsDep,
        computedElementsArr,
        computedElementsArrAtDepEpoch,
        vTransDepFromTransfer: tr.vTransDep,
        vTransArrFromTransfer: tr.vTransArr,
        lambertV1: lambertSol.v1,
        lambertV2: lambertSol.v2
      });
    });

    console.log('[SolarSystemTrajectoryView Debug Data]', debugs);
    return { transferArcs: arcs, transferDebugs: debugs };
  }, [sequence, bodies, mainBody, muCentral]);

  // Compute bounding scale so sequence fits cleanly in view
  const { maxRadius, bodyOrbitPaths } = useMemo(() => {
    // Determine max radius based on bodies in the sequence
    const sequenceOrbiters = sunOrbiters.filter(b => sequenceBodyNames.includes(b.name));
    let maxSequenceR = 1e9;

    if (sequenceOrbiters.length > 0) {
      maxSequenceR = Math.max(...sequenceOrbiters.map(b => {
        const a = b.semiMajorAxis || 1e9;
        const e = b.eccentricity || 0;
        return a * (1 + e);
      }));
    } else if (sunOrbiters.length > 0) {
      maxSequenceR = Math.max(...sunOrbiters.map(b => {
        const a = b.semiMajorAxis || 1e9;
        const e = b.eccentricity || 0;
        return a * (1 + e);
      }));
    }

    // Factor transfer arc points into maxSequenceR
    transferArcs.forEach(arc => {
      arc.points.forEach(p => {
        const r = Math.sqrt(p.x * p.x + p.y * p.y);
        if (r > maxSequenceR) maxSequenceR = r;
      });
    });

    // Generate orbit path rings for planets
    const orbitPaths: { name: string; body: CelestialBody; pathD: string; maxR: number; isSequenceBody: boolean }[] = [];

    sunOrbiters.forEach(b => {
      const a = b.semiMajorAxis || 1e9;

      const isSequenceBody = sequenceBodyNames.includes(b.name);
      const steps = 80;
      const period = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / Math.max(1, muCentral));
      const points: { x: number; y: number }[] = [];

      for (let i = 0; i <= steps; i++) {
        const ut = (i / steps) * period;
        const st = getBodyStateAtUT(b, mainBody, ut);
        points.push({ x: st.pos.x, y: st.pos.y });
      }

      orbitPaths.push({
        name: b.name,
        body: b,
        pathD: points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z',
        maxR: a,
        isSequenceBody
      });
    });

    return { maxRadius: maxSequenceR * 1.15, bodyOrbitPaths: orbitPaths };
  }, [sunOrbiters, sequenceBodyNames, mainBody, muCentral, transferArcs]);

  // SVG Dimension Constants
  const width = 800;
  const height = 500;
  const cx = width / 2;
  const cy = height / 2;

  // Coordinate transform from physical meters to SVG canvas space
  const scale = (Math.min(width, height) / 2 - 40) / maxRadius;

  const toSvgX = (xMeters: number) => cx + xMeters * scale * zoom + pan.x;
  const toSvgY = (yMeters: number) => cy - yMeters * scale * zoom + pan.y;

  // Compute current spacecraft position during time scrubbing / animation
  const currentCraftState = useMemo(() => {
    for (const arc of transferArcs) {
      if (currentUt >= arc.depDate && currentUt <= arc.arrDate) {
        // Interpolate or find exact point
        const fraction = (currentUt - arc.depDate) / Math.max(1, arc.arrDate - arc.depDate);
        const idx = Math.min(arc.points.length - 1, Math.floor(fraction * (arc.points.length - 1)));
        const p1 = arc.points[idx];
        const p2 = arc.points[Math.min(arc.points.length - 1, idx + 1)];
        const localFrac = (fraction * (arc.points.length - 1)) - idx;

        const x = p1.x + (p2.x - p1.x) * localFrac;
        const y = p1.y + (p2.y - p1.y) * localFrac;
        return { active: true, x, y, currentArc: arc };
      }
    }
    return { active: false, x: 0, y: 0, currentArc: null };
  }, [currentUt, transferArcs]);

  // Animation Loop Effect
  useEffect(() => {
    if (!isPlaying) {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }

    let lastTimestamp = performance.now();
    const duration = sequence.arrDate - sequence.depDate;
    const speed = duration / 12000; // Complete full mission animation in ~12 seconds

    const tick = (now: number) => {
      const dt = now - lastTimestamp;
      lastTimestamp = now;

      setCurrentUt(prev => {
        const next = prev + dt * speed;
        if (next >= sequence.arrDate) {
          setIsPlaying(false);
          return sequence.arrDate;
        }
        return next;
      });

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isPlaying, sequence.depDate, sequence.arrDate]);

  // Mouse pan event handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const isLongFlight = sequence.totalFlightTime > daysToSeconds(10, timeFormatMode);

  return (
    <div className="bg-[#111215] border border-[#2D2E33] rounded-lg p-4 space-y-4 font-sans text-xs">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#2D2E33] pb-3">
        <div className="flex items-center gap-2">
          <Navigation className="w-4 h-4 text-[#60A5FA]" />
          <h3 className="font-serif text-sm uppercase tracking-wider text-[#E2E8F0]">
            Interplanetary Trajectory View ({sequence.bodyNames.join(' ➔ ')})
          </h3>
        </div>

        {/* Animation & Zoom Controls */}
        <div className="flex items-center gap-2">
          {/* Debug Data Toggle Button */}
          <button
            onClick={() => setShowDebug(!showDebug)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-mono border transition ${
              showDebug
                ? 'bg-[#3B82F6]/20 text-[#60A5FA] border-[#3B82F6]'
                : 'bg-[#25262B] text-[#94A3B8] border-[#2D2E33] hover:bg-[#2D2E33] hover:text-[#E2E8F0]'
            }`}
            title="Toggle Trajectory View Physics Debug Data"
          >
            <Bug className="w-3.5 h-3.5" />
            <span>{showDebug ? 'Hide Debug Data' : 'Debug Data'}</span>
          </button>

          {/* Play/Pause Animation */}
          <button
            onClick={() => {
              if (currentUt >= sequence.arrDate) setCurrentUt(sequence.depDate);
              setIsPlaying(!isPlaying);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#25262B] hover:bg-[#2D2E33] text-[#60A5FA] border border-[#2D2E33] rounded text-[11px] font-mono transition"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isPlaying ? 'Pause' : 'Animate Trajectory'}</span>
          </button>

          {/* Reset Time */}
          <button
            onClick={() => {
              setIsPlaying(false);
              setCurrentUt(sequence.depDate);
            }}
            className="p-1.5 bg-[#25262B] hover:bg-[#2D2E33] text-[#94A3B8] border border-[#2D2E33] rounded transition"
            title="Reset Time to Departure"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Zoom In/Out/Reset */}
          <div className="flex items-center bg-[#25262B] border border-[#2D2E33] rounded overflow-hidden ml-2">
            <button
              onClick={() => setZoom(z => z * 1.25)}
              className="p-1.5 hover:bg-[#2D2E33] text-[#94A3B8] transition"
              title="Zoom In (Unlimited)"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setZoom(z => Math.max(z / 1.25, 0.05))}
              className="p-1.5 hover:bg-[#2D2E33] text-[#94A3B8] transition"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
              className="p-1.5 hover:bg-[#2D2E33] text-[#94A3B8] transition border-l border-[#2D2E33]"
              title="Reset Zoom & Pan"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Main SVG Interactive Canvas */}
      <div
        className="relative bg-[#0A0B0D] border border-[#2D2E33] rounded overflow-hidden cursor-grab active:cursor-grabbing select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={(e) => {
          e.preventDefault();
          const zoomFactor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
          setZoom(z => Math.max(0.05, z * zoomFactor));
        }}
        style={{ height: '420px' }}
      >
        {/* Background Starfield Grid Effect */}
        <div className="absolute inset-0 bg-[radial-gradient(#1E293B_1px,transparent_1px)] [background-size:24px_24px] opacity-40 pointer-events-none" />

        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
          <defs>
            {/* Sun Glow Gradient */}
            <radialGradient id="sun-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FDE047" stopOpacity="1" />
              <stop offset="40%" stopColor="#EAB308" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#CA8A04" stopOpacity="0" />
            </radialGradient>

            {/* Transfer Arc Gradient */}
            <linearGradient id="transfer-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#38BDF8" />
              <stop offset="50%" stopColor="#A855F7" />
              <stop offset="100%" stopColor="#F43F5E" />
            </linearGradient>
          </defs>

          {/* Render Planet Orbit Rings */}
          {bodyOrbitPaths.map(op => {
            const pathPoints = op.pathD.split(' ').reduce((acc: string[], curr, i, arr) => {
              if (curr === 'M' || curr === 'L') {
                const x = toSvgX(parseFloat(arr[i + 1]));
                const y = toSvgY(parseFloat(arr[i + 2]));
                acc.push(`${curr} ${x.toFixed(1)} ${y.toFixed(1)}`);
              } else if (curr === 'Z') {
                acc.push('Z');
              }
              return acc;
            }, []);

            return (
              <path
                key={op.name}
                d={pathPoints.join(' ')}
                fill="none"
                stroke={op.isSequenceBody ? '#475569' : '#1E293B'}
                strokeWidth={op.isSequenceBody ? 1.5 : 0.8}
                strokeDasharray={op.isSequenceBody ? '4 3' : '2 4'}
              />
            );
          })}

          {/* Render Spacecraft Lambert Transfer Trajectory Arcs */}
          {transferArcs.map((arc, aIdx) => {
            const pathD = arc.points
              .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${toSvgX(p.x).toFixed(1)} ${toSvgY(p.y).toFixed(1)}`)
              .join(' ');

            return (
              <g key={aIdx}>
                {/* Glow Shadow line */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="#38BDF8"
                  strokeWidth={4 * zoom}
                  strokeOpacity={0.2}
                />
                {/* Main trajectory arc */}
                <path
                  d={pathD}
                  fill="none"
                  stroke="url(#transfer-grad)"
                  strokeWidth={2}
                  strokeDasharray="6 3"
                />
              </g>
            );
          })}

          {/* Render Central Star (Sun / Kerbol) */}
          <circle
            cx={toSvgX(0)}
            cy={toSvgY(0)}
            r={8}
            fill="url(#sun-glow)"
          />
          <circle
            cx={toSvgX(0)}
            cy={toSvgY(0)}
            r={6}
            fill="#FEF08A"
          />
          <text
            x={toSvgX(0)}
            y={toSvgY(0) + 20 * Math.sqrt(zoom)}
            textAnchor="middle"
            fill="#FDE047"
            fontSize={10}
            fontFamily="monospace"
            fontWeight="bold"
          >
            {mainBody.name}
          </text>

          {/* Render Celestial Bodies at Current Animated UT */}
          {sunOrbiters.map(body => {
            const state = getBodyStateAtUT(body, mainBody, currentUt);
            const bx = toSvgX(state.pos.x);
            const by = toSvgY(state.pos.y);

            const isSeqBody = sequenceBodyNames.includes(body.name);
            const bodyIdx = sequenceBodyNames.indexOf(body.name);

            // Color coding for sequence bodies
            let badgeColor = '#94A3B8';
            if (bodyIdx === 0) badgeColor = '#22C55E'; // Departure = Green
            else if (bodyIdx === sequenceBodyNames.length - 1) badgeColor = '#EC4899'; // Arrival = Pink
            else if (bodyIdx > 0) badgeColor = '#F59E0B'; // Flyby = Amber

            return (
              <g key={body.name}>
                <circle
                  cx={bx}
                  cy={by}
                  r={isSeqBody ? 6 : 4}
                  fill={badgeColor}
                  stroke="#0A0B0D"
                  strokeWidth={1.5}
                />
                <text
                  x={bx}
                  y={by - 10}
                  textAnchor="middle"
                  fill={isSeqBody ? '#E2E8F0' : '#64748B'}
                  fontSize={isSeqBody ? 11 : 9}
                  fontFamily="sans-serif"
                  fontWeight={isSeqBody ? 'bold' : 'normal'}
                >
                  {body.name}
                </text>
              </g>
            );
          })}

          {/* Render Animated Spacecraft Icon (🚀) */}
          {currentCraftState.active && (
            <g transform={`translate(${toSvgX(currentCraftState.x)}, ${toSvgY(currentCraftState.y)})`}>
              <circle r={8} fill="#38BDF8" fillOpacity={0.3} className="animate-pulse" />
              <circle r={4} fill="#60A5FA" />
              <text y={-10} textAnchor="middle" fill="#60A5FA" fontSize={10} fontFamily="monospace" fontWeight="bold">
                🚀 Spacecraft
              </text>
            </g>
          )}
        </svg>

        {/* Current Time Overlay Badge */}
        <div className="absolute top-3 left-3 bg-[#1A1B1E]/90 backdrop-blur border border-[#2D2E33] rounded p-2.5 space-y-1 font-mono text-[11px] text-[#E2E8F0] shadow-lg pointer-events-none">
          <div className="flex items-center gap-2 text-[#60A5FA] font-bold">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Mission Timeline</span>
          </div>
          <div>UT: <strong className="text-white">{Math.round(currentUt)} s</strong></div>
          <div className="text-[#94A3B8]">
            Date: {isLongFlight ? formatShortUT(currentUt, timeFormatMode) : formatUT(currentUt, timeFormatMode)}
          </div>
        </div>

        {/* Legend */}
        <div className="absolute bottom-3 right-3 bg-[#1A1B1E]/90 backdrop-blur border border-[#2D2E33] rounded px-3 py-2 flex items-center gap-3 font-sans text-[10px] text-[#94A3B8] shadow-lg pointer-events-none">
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#22C55E]" />
            <span>Departure</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]" />
            <span>Gravity Assist Flyby</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-[#EC4899]" />
            <span>Arrival</span>
          </div>
        </div>
      </div>

      {/* Scrubbing Time Slider Control */}
      <div className="bg-[#1A1B1E] p-3 rounded border border-[#2D2E33] space-y-2">
        <div className="flex justify-between items-center text-[11px] font-mono text-[#94A3B8]">
          <span>Departure ({formatShortUT(sequence.depDate, timeFormatMode)})</span>
          <span className="text-[#60A5FA] font-bold">
            Progress: {(((currentUt - sequence.depDate) / Math.max(1, sequence.arrDate - sequence.depDate)) * 100).toFixed(0)}%
          </span>
          <span>Arrival ({formatShortUT(sequence.arrDate, timeFormatMode)})</span>
        </div>
        <input
          type="range"
          min={sequence.depDate}
          max={sequence.arrDate}
          step={(sequence.arrDate - sequence.depDate) / 500}
          value={currentUt}
          onChange={(e) => {
            setIsPlaying(false);
            setCurrentUt(parseFloat(e.target.value));
          }}
          className="w-full accent-[#60A5FA] bg-[#25262B] h-1.5 rounded cursor-pointer"
        />
      </div>

      {/* Trajectory View Physics Debug Inspector Panel */}
      {showDebug && (
        <div className="bg-[#15161A] border border-[#3B82F6]/40 rounded-lg p-4 space-y-4 font-mono text-[11px]">
          <div className="flex items-center justify-between border-b border-[#2D2E33] pb-2 text-[#60A5FA]">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[#3B82F6]" />
              <span className="font-bold text-xs uppercase tracking-wider">Solar System Trajectory View Physics Debug Inspector</span>
            </div>
            <span className="text-[10px] text-[#94A3B8]">Main Central Body: {mainBody.name} (μ = {muCentral.toExponential(4)} m³/s²)</span>
          </div>

          <div className="space-y-4">
            {transferDebugs.map((dbg) => (
              <div key={dbg.legIndex} className="bg-[#0D0E11] border border-[#2D2E33] rounded p-3 space-y-3">
                <div className="flex items-center justify-between border-b border-[#1E293B] pb-2 text-[#E2E8F0]">
                  <span className="font-bold text-xs text-[#38BDF8]">
                    Leg #{dbg.legIndex}: {dbg.sourceName} ➔ {dbg.targetName}
                  </span>
                  <div className="text-[10px] text-[#94A3B8] space-x-3">
                    <span>Dep UT: {formatShortUT(dbg.depDate, timeFormatMode)}</span>
                    <span>Arr UT: {formatShortUT(dbg.arrDate, timeFormatMode)}</span>
                    <span>Duration: {formatDuration(dbg.dt, timeFormatMode)}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[10.5px]">
                  {/* Source Body State at Departure */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#25262B] space-y-1">
                    <div className="text-[#22C55E] font-bold border-b border-[#25262B] pb-1">bodyStateAtDep ({dbg.sourceName})</div>
                    <div>
                      <span className="text-[#94A3B8]">pos (m):</span> [{dbg.sourceStateAtDep.pos.x.toFixed(1)}, {dbg.sourceStateAtDep.pos.y.toFixed(1)}, {dbg.sourceStateAtDep.pos.z.toFixed(1)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">pos r:</span> {(vecMag(dbg.sourceStateAtDep.pos) / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">vel (m/s):</span> [{dbg.sourceStateAtDep.vel.x.toFixed(2)}, {dbg.sourceStateAtDep.vel.y.toFixed(2)}, {dbg.sourceStateAtDep.vel.z.toFixed(2)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">vel v:</span> {vecMag(dbg.sourceStateAtDep.vel).toFixed(2)} m/s
                    </div>
                  </div>

                  {/* Target Body State at Arrival */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#25262B] space-y-1">
                    <div className="text-[#EC4899] font-bold border-b border-[#25262B] pb-1">bodyStateAtArr ({dbg.targetName})</div>
                    <div>
                      <span className="text-[#94A3B8]">pos (m):</span> [{dbg.targetStateAtArr.pos.x.toFixed(1)}, {dbg.targetStateAtArr.pos.y.toFixed(1)}, {dbg.targetStateAtArr.pos.z.toFixed(1)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">pos r:</span> {(vecMag(dbg.targetStateAtArr.pos) / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">vel (m/s):</span> [{dbg.targetStateAtArr.vel.x.toFixed(2)}, {dbg.targetStateAtArr.vel.y.toFixed(2)}, {dbg.targetStateAtArr.vel.z.toFixed(2)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">vel v:</span> {vecMag(dbg.targetStateAtArr.vel).toFixed(2)} m/s
                    </div>
                  </div>

                  {/* Spacecraft Central Velocity Vectors */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#25262B] space-y-1">
                    <div className="text-[#38BDF8] font-bold border-b border-[#25262B] pb-1">Spacecraft Central Frame Vectors</div>
                    <div>
                      <span className="text-[#94A3B8]">vSpacecraftDep (m/s):</span> [{dbg.vSpacecraftDep.x.toFixed(2)}, {dbg.vSpacecraftDep.y.toFixed(2)}, {dbg.vSpacecraftDep.z.toFixed(2)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">|vSpacecraftDep|:</span> {vecMag(dbg.vSpacecraftDep).toFixed(2)} m/s
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">vSpacecraftArr (m/s):</span> [{dbg.vSpacecraftArr.x.toFixed(2)}, {dbg.vSpacecraftArr.y.toFixed(2)}, {dbg.vSpacecraftArr.z.toFixed(2)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">|vSpacecraftArr|:</span> {vecMag(dbg.vSpacecraftArr).toFixed(2)} m/s
                    </div>
                  </div>

                  {/* Relative Velocity v_infinity Vectors */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#25262B] space-y-1">
                    <div className="text-[#F59E0B] font-bold border-b border-[#25262B] pb-1">v_infinity Relative Vectors</div>
                    <div>
                      <span className="text-[#94A3B8]">vInfDep (m/s):</span> [{dbg.vInfDep.x.toFixed(2)}, {dbg.vInfDep.y.toFixed(2)}, {dbg.vInfDep.z.toFixed(2)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">|vInfDep|:</span> {vecMag(dbg.vInfDep).toFixed(2)} m/s
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">vInfArr (m/s):</span> [{dbg.vInfArr.x.toFixed(2)}, {dbg.vInfArr.y.toFixed(2)}, {dbg.vInfArr.z.toFixed(2)}]
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">|vInfArr|:</span> {vecMag(dbg.vInfArr).toFixed(2)} m/s
                    </div>
                  </div>
                </div>

                {/* Computed Transfer Arc Orbital Elements Comparison */}
                <div className="space-y-2 pt-1 text-[10.5px]">
                  {/* 1. Departure State Orbital Elements */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#25262B] space-y-1.5">
                    <div className="text-[#A855F7] font-bold border-b border-[#25262B] pb-1 flex justify-between items-center">
                      <span>Departure Orbit Elements (from bodyStateAtDep.pos + vSpacecraftDep)</span>
                      <span className="text-[10px] text-[#C084FC] font-normal">Epoch = Departure UT ({formatShortUT(dbg.computedElementsDep.epoch, timeFormatMode)})</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[#E2E8F0]">
                      <div><span className="text-[#94A3B8]">a (semi-major axis):</span> {(dbg.computedElementsDep.semiMajorAxis / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km</div>
                      <div><span className="text-[#94A3B8]">e (eccentricity):</span> {dbg.computedElementsDep.eccentricity.toFixed(6)}</div>
                      <div><span className="text-[#94A3B8]">i (inclination):</span> {((dbg.computedElementsDep.inclination * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">Ω (long. asc. node):</span> {((dbg.computedElementsDep.ascNodeLongitude * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">ω (arg. periapsis):</span> {((dbg.computedElementsDep.argOfPeriapsis * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">M0 (mean anomaly):</span> {((dbg.computedElementsDep.meanAnomalyEpoch * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">nu0 (true anomaly):</span> {((dbg.computedElementsDep.trueAnomalyEpoch * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">epoch (t0):</span> {Math.round(dbg.computedElementsDep.epoch)} s</div>
                    </div>
                  </div>

                  {/* 2. Arrival State Orbital Elements (at Arrival UT) */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#25262B] space-y-1.5">
                    <div className="text-[#E879F9] font-bold border-b border-[#25262B] pb-1 flex justify-between items-center">
                      <span>Arrival Orbit Elements (from bodyStateAtArr.pos + vSpacecraftArr)</span>
                      <span className="text-[10px] text-[#F0ABFC] font-normal">Epoch = Arrival UT ({formatShortUT(dbg.computedElementsArr.epoch, timeFormatMode)})</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[#E2E8F0]">
                      <div><span className="text-[#94A3B8]">a (semi-major axis):</span> {(dbg.computedElementsArr.semiMajorAxis / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km</div>
                      <div><span className="text-[#94A3B8]">e (eccentricity):</span> {dbg.computedElementsArr.eccentricity.toFixed(6)}</div>
                      <div><span className="text-[#94A3B8]">i (inclination):</span> {((dbg.computedElementsArr.inclination * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">Ω (long. asc. node):</span> {((dbg.computedElementsArr.ascNodeLongitude * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">ω (arg. periapsis):</span> {((dbg.computedElementsArr.argOfPeriapsis * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">M0 (mean anomaly):</span> {((dbg.computedElementsArr.meanAnomalyEpoch * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">nu0 (true anomaly):</span> {((dbg.computedElementsArr.trueAnomalyEpoch * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">epoch (t0):</span> {Math.round(dbg.computedElementsArr.epoch)} s</div>
                    </div>
                  </div>

                  {/* 3. Arrival State Orbital Elements Evaluated at Departure Epoch */}
                  <div className="bg-[#16171C] p-2.5 rounded border border-[#3B82F6]/30 space-y-1.5">
                    <div className="text-[#60A5FA] font-bold border-b border-[#25262B] pb-1 flex justify-between items-center">
                      <span>Arrival Orbit Elements Shifted to Departure Epoch (for Same-Epoch Comparison)</span>
                      <span className="text-[10px] text-[#93C5FD] font-normal">Same Epoch = Departure UT ({formatShortUT(dbg.computedElementsArrAtDepEpoch.epoch, timeFormatMode)})</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[#E2E8F0]">
                      <div><span className="text-[#94A3B8]">a (semi-major axis):</span> {(dbg.computedElementsArrAtDepEpoch.semiMajorAxis / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km</div>
                      <div><span className="text-[#94A3B8]">e (eccentricity):</span> {dbg.computedElementsArrAtDepEpoch.eccentricity.toFixed(6)}</div>
                      <div><span className="text-[#94A3B8]">i (inclination):</span> {((dbg.computedElementsArrAtDepEpoch.inclination * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">Ω (long. asc. node):</span> {((dbg.computedElementsArrAtDepEpoch.ascNodeLongitude * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">ω (arg. periapsis):</span> {((dbg.computedElementsArrAtDepEpoch.argOfPeriapsis * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#38BDF8] font-bold">M0 (at dep epoch):</span> {((dbg.computedElementsArrAtDepEpoch.meanAnomalyEpoch * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#38BDF8] font-bold">nu0 (true anomaly at dep epoch):</span> {((dbg.computedElementsArrAtDepEpoch.trueAnomalyEpoch * 180) / Math.PI).toFixed(4)}°</div>
                      <div><span className="text-[#94A3B8]">epoch (t0):</span> {Math.round(dbg.computedElementsArrAtDepEpoch.epoch)} s</div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
