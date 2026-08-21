/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { SequencePorkchopData, PorkchopPlotData, DirectionalLink, CelestialBody, OrbitalBody, InstanceNode, SubtaskProgressInfo, Vector3D } from '../types';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import { X, Compass, Calendar, RefreshCw, RotateCcw, ZoomIn, Timer, Activity, ChevronDown, ChevronUp, Cpu, Zap, BarChart2, Layers, Info } from 'lucide-react';
import { extractFlybyDebugData, FlybyDebugPlotData } from '../utils/flybyDebugPlot';
import { extractMultiInstanceDebugData, MultiInstanceDebugData } from '../utils/multiInstanceDebug';
import { FlybyDebugPlotModal } from './FlybyDebugPlotModal';
import { MultiInstanceDebugModal } from './MultiInstanceDebugModal';
import {
  evaluateSequenceTransferFromDirectPorkchops,
  evaluateHigherOrderSequenceTransferAddLastLeg,
  evaluateHigherOrderSequenceTransferAddFirstLeg
} from '../physics/flyby';
import { vecMag } from '../physics/kepler';

interface SequencePorkchopViewerProps {
  seqPorkchop: SequencePorkchopData;
  timeFormatMode: 'ksp' | 'earth';
  onClose: () => void;
  onRecomputePorkchop?: () => void;
  isComputing?: boolean;
  activeSubtask?: SubtaskProgressInfo | null;
  porkchops: Record<string, PorkchopPlotData>;
  sequencePorkchops: Record<string, SequencePorkchopData>;
  links: DirectionalLink[];
  instances: InstanceNode[];
  bodies: OrbitalBody[];
  mainBody: CelestialBody;
}

export type SeqViewTab =
  | 'c3DepA'
  | 'c3ArrB'
  | 'c3DepB'
  | 'c3ArrC'
  | 'c3DepC'
  | 'c3ArrD'
  | 'c3ArrFinal'
  | 'poweredDvB'
  | 'poweredDvC'
  | 'totalPoweredDv'
  | string;

export const SequencePorkchopViewer: React.FC<SequencePorkchopViewerProps> = ({
  seqPorkchop,
  timeFormatMode,
  onClose,
  onRecomputePorkchop,
  isComputing,
  activeSubtask,
  porkchops,
  sequencePorkchops,
  links,
  instances,
  bodies,
  mainBody,
}) => {
  const resolvedPathInsts = useMemo<InstanceNode[]>(() => {
    if (seqPorkchop.sourceBody && seqPorkchop.targetBody) {
      return [
        seqPorkchop.sourceBody,
        ...(seqPorkchop.flybys ? seqPorkchop.flybys.map(f => f.instance) : []),
        seqPorkchop.targetBody,
      ];
    }
    const names = seqPorkchop.sequenceLabel.split(/➔|->|→/).map(s => s.trim()).filter(Boolean);
    return names.map((name, idx) => ({
      id: `inst-${idx}`,
      bodyName: name,
      customName: name,
      x: 0,
      y: 0,
    } as InstanceNode));
  }, [seqPorkchop]);

  const currentSubtask = activeSubtask || seqPorkchop.activeSubtask || null;
  const bodyNames = resolvedPathInsts.map(i => i.bodyName);
  const instanceCount = seqPorkchop.instanceCount || resolvedPathInsts.length || 3;
  const srcBodyName = resolvedPathInsts[0]?.bodyName || 'Source';
  const tgtBodyName = resolvedPathInsts[resolvedPathInsts.length - 1]?.bodyName || 'Target';
  const flybyBodyNames = resolvedPathInsts.slice(1, -1).map(i => i.bodyName);

  const [activeTab, setActiveTab] = useState<SeqViewTab>(
    instanceCount >= 4 ? 'totalPoweredDv' : 'poweredDvB'
  );
  const [showOptimisedOut, setShowOptimisedOut] = useState<boolean>(false);

  const [hoverData, setHoverData] = useState<{
    depDate: number;
    flybyDates: { body: string; date: number }[];
    arrDate: number;
    flightTime: number;
    c3DepA: number;
    c3ArrFinal: number;
    flybyDvs: { body: string; dv: number }[];
    totalPoweredDv: number;
    isValid: boolean;
    isPhysical: boolean;
    isConstraint: boolean;
    statusText: string;
    xPct: number;
    yPct: number;
  } | null>(null);

  const [debugPlotData, setDebugPlotData] = useState<FlybyDebugPlotData | null>(null);
  const [multiInstanceDebugData, setMultiInstanceDebugData] = useState<MultiInstanceDebugData | null>(null);

  // View bounds for click-and-drag zoom (indices range)
  const [viewBounds, setViewBounds] = useState<{
    iMin: number;
    iMax: number;
    jMin: number;
    jMax: number;
  } | null>(null);

  // Profiling panel fold state
  const [isProfilingFolded, setIsProfilingFolded] = useState<boolean>(true);

  // Drag selection state for box zoom
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [renderEpoch, setRenderEpoch] = useState<number>(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const nDep = seqPorkchop.depDates ? seqPorkchop.depDates.length : 0;
  const nArr = seqPorkchop.arrDates ? seqPorkchop.arrDates.length : 0;
  const totalSamples = seqPorkchop.totalSamples ?? (nDep * nArr);
  const computedSamples = useMemo(() => {
    if (seqPorkchop.computedSamples !== undefined) return seqPorkchop.computedSamples;
    if (!isComputing && totalSamples > 0) return totalSamples;
    const vMatrix = seqPorkchop.constraintValidMatrix || seqPorkchop.physicalValidMatrix;
    if (vMatrix && nDep > 0 && nArr > 0) {
      let count = 0;
      for (let i = 0; i < nDep; i++) {
        const row = vMatrix[i];
        if (row) {
          for (let j = 0; j < nArr; j++) {
            if (row[j] !== undefined) count++;
          }
        }
      }
      return count;
    }
    return 0;
  }, [seqPorkchop, isComputing, totalSamples, nDep, nArr]);

  const computedPct = totalSamples > 0
    ? Math.min(100, Math.max(0, Math.round((computedSamples / totalSamples) * 100)))
    : (isComputing ? 0 : 100);

  const getMatrixForTab = (tab: SeqViewTab): number[][] | Vector3D[][] => {
    if (tab === 'totalPoweredDv') return seqPorkchop.totalPoweredDvMatrix || [];
    if (tab === 'c3DepA') return seqPorkchop.c3DepMatrix || [];
    if (tab === 'c3ArrFinal' || tab === 'c3ArrD' || tab === 'c3ArrC') return seqPorkchop.c3ArrMatrix || [];
    if (tab === 'c3ArrB') return seqPorkchop.flybys?.[0]?.c3ArrMatrix || [];
    if (tab === 'c3DepB') return seqPorkchop.flybys?.[0]?.c3DepMatrix || [];
    if (tab === 'poweredDvB') return seqPorkchop.flybys?.[0]?.poweredDvMatrix || seqPorkchop.totalPoweredDvMatrix || [];
    if (tab === 'poweredDvC') return seqPorkchop.flybys?.[1]?.poweredDvMatrix || seqPorkchop.totalPoweredDvMatrix || [];

    if (tab.startsWith('flybyDv_')) {
      const idx = parseInt(tab.replace('flybyDv_', ''), 10);
      if (seqPorkchop.flybys?.[idx]) {
        return seqPorkchop.flybys[idx].poweredDvMatrix || [];
      }
    }
    return seqPorkchop.totalPoweredDvMatrix || [];
  };

  const currentMatrix = getMatrixForTab(activeTab);

  const getScalarMatrixValue = (value: number | Vector3D | undefined): number | undefined => {
    if (typeof value === 'number') return value;
    if (!value) return undefined;
    return vecMag(value);
  };

  // Compute departure & arrival date windows based on first/last feasible columns (departure) and lines (arrival)
  const dateWindows = useMemo(() => {
    const vMatrix = seqPorkchop.constraintValidMatrix || seqPorkchop.physicalValidMatrix;
    if (!vMatrix || nDep === 0 || nArr === 0) {
      return null;
    }

    let firstDepIdx = -1;
    let lastDepIdx = -1;
    let firstArrIdx = -1;
    let lastArrIdx = -1;

    for (let i = 0; i < nDep; i++) {
      const row = vMatrix[i];
      if (row && row.some(Boolean)) {
        if (firstDepIdx === -1) firstDepIdx = i;
        lastDepIdx = i;
      }
    }

    for (let j = 0; j < nArr; j++) {
      let hasFeasible = false;
      for (let i = 0; i < nDep; i++) {
        if (vMatrix[i]?.[j]) {
          hasFeasible = true;
          break;
        }
      }
      if (hasFeasible) {
        if (firstArrIdx === -1) firstArrIdx = j;
        lastArrIdx = j;
      }
    }

    if (firstDepIdx === -1 || firstArrIdx === -1) {
      return null;
    }

    const depStart = seqPorkchop.depDates[firstDepIdx];
    const depEnd = seqPorkchop.depDates[lastDepIdx];
    const arrStart = seqPorkchop.arrDates[firstArrIdx];
    const arrEnd = seqPorkchop.arrDates[lastArrIdx];

    return {
      depStart,
      depEnd,
      depDuration: depEnd - depStart,
      arrStart,
      arrEnd,
      arrDuration: arrEnd - arrStart,
    };
  }, [seqPorkchop, nDep, nArr]);

  // Compute number of departure dates for which the delta-v cost is <= 1 m/s ("possible departure date for free flyby")
  const freeFlybyDepDatesCount = useMemo(() => {
    if (!seqPorkchop || nDep === 0 || nArr === 0) return 0;
    const dvMatrix = seqPorkchop.totalPoweredDvMatrix;
    if (!dvMatrix) return 0;

    let count = 0;
    for (let i = 0; i < nDep; i++) {
      let hasFreeFlyby = false;
      for (let j = 0; j < nArr; j++) {
        if (seqPorkchop.constraintValidMatrix?.[i]?.[j]) {
          const dv = dvMatrix[i]?.[j];
          if (dv !== undefined && Number.isFinite(dv) && dv <= 1.0) {
            hasFreeFlyby = true;
            break;
          }
        }
      }
      if (hasFreeFlyby) {
        count++;
      }
    }
    return count;
  }, [seqPorkchop, nDep, nArr]);

  // Collect valid values for current matrix
  const validValues: number[] = [];
  if (currentMatrix && nDep > 0 && nArr > 0) {
    for (let i = 0; i < nDep; i++) {
      for (let j = 0; j < nArr; j++) {
        const isEligible = showOptimisedOut
          ? (seqPorkchop.physicalValidMatrix ? seqPorkchop.physicalValidMatrix[i]?.[j] : false)
          : (seqPorkchop.constraintValidMatrix ? seqPorkchop.constraintValidMatrix[i]?.[j] : false);

        if (isEligible) {
          const val = getScalarMatrixValue(currentMatrix[i]?.[j]);
          if (val !== undefined && Number.isFinite(val) && val >= 0) {
            validValues.push(val);
          }
        }
      }
    }
  }

  validValues.sort((a, b) => a - b);

  const minVal = validValues.length > 0 ? validValues[0] : 0;
  const maxVal = validValues.length > 0 ? validValues[validValues.length - 1] : 100;
  const effectiveMin = Math.max(1, minVal);

  // 2nd decile (20th percentile) ignoring values below effectiveMin
  const valuesAboveEffectiveMin = validValues.filter(v => v >= effectiveMin);
  let decile2 = effectiveMin;
  if (valuesAboveEffectiveMin.length > 0) {
    const idx20 = Math.min(valuesAboveEffectiveMin.length - 1, Math.floor(0.20 * valuesAboveEffectiveMin.length));
    decile2 = valuesAboveEffectiveMin[idx20];
  }

  const capByFactor = effectiveMin * Math.pow(1.1, 16);
  const redCap = Math.max(capByFactor, decile2);
  const logRange = redCap > effectiveMin ? Math.log(redCap / effectiveMin) : 1;

  // Draw Heatmap Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    if (nDep === 0 || nArr === 0 || !currentMatrix) return;

    const curIMin = viewBounds ? viewBounds.iMin : 0;
    const curIMax = viewBounds ? viewBounds.iMax : Math.max(0, nDep - 1);
    const curJMin = viewBounds ? viewBounds.jMin : 0;
    const curJMax = viewBounds ? viewBounds.jMax : Math.max(0, nArr - 1);

    const rangeI = Math.max(1, curIMax - curIMin + 1);
    const rangeJ = Math.max(1, curJMax - curJMin + 1);

    const startI = Math.max(0, Math.floor(curIMin));
    const endI = Math.min(nDep - 1, Math.ceil(curIMax));
    const startJ = Math.max(0, Math.floor(curJMin));
    const endJ = Math.min(nArr - 1, Math.ceil(curJMax));

    const minPhysicalDt = 3600 * Math.max(1, instanceCount - 1);

    for (let i = startI; i <= endI; i++) {
      const x1 = ((i - curIMin) / rangeI) * width;
      const x2 = ((i + 1 - curIMin) / rangeI) * width;
      const cellW = Math.max(0.5, x2 - x1);

      for (let j = startJ; j <= endJ; j++) {
        const y1 = height - ((j + 1 - curJMin) / rangeJ) * height;
        const y2 = height - ((j - curJMin) / rangeJ) * height;
        const cellH = Math.max(0.5, y2 - y1);

        const dt = (seqPorkchop.arrDates?.[j] ?? 0) - (seqPorkchop.depDates?.[i] ?? 0);
        const isPhysical = seqPorkchop.physicalValidMatrix
          ? !!seqPorkchop.physicalValidMatrix[i]?.[j]
          : dt >= minPhysicalDt;

        const isConstraint = seqPorkchop.constraintValidMatrix
          ? !!seqPorkchop.constraintValidMatrix[i]?.[j]
          : false;

        // Physically impossible transfers are strictly hidden (never displayed as viable paths)
        if (!isPhysical) {
          ctx.fillStyle = '#0B0F19'; // Void for physically impossible
          ctx.fillRect(x1, y1, cellW + 0.5, cellH + 0.5);
          continue;
        }

        // If physically possible but filtered out (optimised-out) by constraints
        if (!isConstraint && !showOptimisedOut) {
          ctx.fillStyle = '#0F172A'; // Hidden when debug mode is off
          ctx.fillRect(x1, y1, cellW + 0.5, cellH + 0.5);
          continue;
        }

        const val = getScalarMatrixValue(currentMatrix[i]?.[j]) ?? 0;

        let norm = 0;
        if (val <= effectiveMin) {
          norm = 0;
        } else if (val >= redCap) {
          norm = 1;
        } else if (logRange > 0) {
          norm = Math.log(val / effectiveMin) / logRange;
        }
        norm = Math.max(0, Math.min(1, norm));

        const hue = (1 - norm) * 240;
        if (isConstraint) {
          ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
        } else {
          // Subdued styling for optimised-out points during debug inspection
          ctx.fillStyle = `hsla(${hue}, 35%, 35%, 0.8)`;
        }
        ctx.fillRect(x1, y1, cellW + 0.5, cellH + 0.5);
      }
    }

    // Draw rubber-band box zoom selection rectangle if dragging
    if (dragStart && dragCurrent) {
      const bx = Math.min(dragStart.x, dragCurrent.x);
      const by = Math.min(dragStart.y, dragCurrent.y);
      const bw = Math.abs(dragCurrent.x - dragStart.x);
      const bh = Math.abs(dragCurrent.y - dragStart.y);

      ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 2;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    }
  }, [
    seqPorkchop,
    activeTab,
    showOptimisedOut,
    currentMatrix,
    minVal,
    maxVal,
    effectiveMin,
    redCap,
    logRange,
    nDep,
    nArr,
    instanceCount,
    viewBounds,
    dragStart,
    dragCurrent,
    renderEpoch,
  ]);

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width, ((e.clientX - rect.left) / rect.width) * canvas.width));
    const y = Math.max(0, Math.min(canvas.height, ((e.clientY - rect.top) / rect.height) * canvas.height));

    setDragStart({ x, y });
    setDragCurrent({ x, y });
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;

    const x = Math.max(0, Math.min(canvas.width, (rawX / rect.width) * canvas.width));
    const y = Math.max(0, Math.min(canvas.height, (rawY / rect.height) * canvas.height));

    if (dragStart) {
      setDragCurrent({ x, y });
    }

    const curIMin = viewBounds ? viewBounds.iMin : 0;
    const curIMax = viewBounds ? viewBounds.iMax : Math.max(0, nDep - 1);
    const curJMin = viewBounds ? viewBounds.jMin : 0;
    const curJMax = viewBounds ? viewBounds.jMax : Math.max(0, nArr - 1);

    const rangeI = Math.max(1, curIMax - curIMin + 1);
    const rangeJ = Math.max(1, curJMax - curJMin + 1);

    const relX = Math.max(0, Math.min(1, rawX / rect.width));
    const relY = Math.max(0, Math.min(1, rawY / rect.height));

    const floatI = curIMin + relX * rangeI;
    const floatJ = curJMin + (1 - relY) * rangeJ;

    const i = Math.max(0, Math.min(nDep - 1, Math.floor(floatI)));
    const j = Math.max(0, Math.min(nArr - 1, Math.floor(floatJ)));

    if (i >= 0 && i < nDep && j >= 0 && j < nArr) {
      const depDate = seqPorkchop.depDates[i];
      const arrDate = seqPorkchop.arrDates[j];
      const flightTime = seqPorkchop.flightTimeMatrix?.[i]?.[j] ?? (arrDate - depDate);
      const c3DepA = seqPorkchop.c3DepMatrix?.[i]?.[j];
      const c3ArrFinal = seqPorkchop.c3ArrMatrix?.[i]?.[j];
      const totalPoweredDv = seqPorkchop.totalPoweredDvMatrix?.[i]?.[j] ?? Infinity;
      const minPhysicalDt = 3600 * Math.max(1, instanceCount - 1);
      const dt = arrDate - depDate;
      const isPhysical = seqPorkchop.physicalValidMatrix
        ? !!seqPorkchop.physicalValidMatrix[i]?.[j]
        : dt >= minPhysicalDt;

      const isConstraint = seqPorkchop.constraintValidMatrix
        ? !!seqPorkchop.constraintValidMatrix[i]?.[j]
        : false;

      const isValid = isConstraint;

      let statusText = 'Valid Sequence Transfer';
      if (!isPhysical) {
        statusText = dt < minPhysicalDt ? 'Physically Impossible (Arrival ≤ Departure)' : 'Physically Impossible (Sub-leg Collision / Infeasible)';
      } else if (!isConstraint) {
        statusText = 'Optimised-out (Exceeds C3 / Powered Δv Limits)';
      }

      const flybyDatesList: { body: string; date: number }[] = [];
      const flybyDvsList: { body: string; dv: number }[] = [];

      if (seqPorkchop.flybys && seqPorkchop.flybys.length > 0) {
        seqPorkchop.flybys.forEach((fb, fbIdx) => {
          const body = fb.instance?.bodyName || flybyBodyNames[fbIdx] || `Flyby ${fbIdx + 1}`;
          flybyDatesList.push({
            body,
            date: fb.dateMatrix?.[i]?.[j] ?? (depDate + arrDate) / 2,
          });
          flybyDvsList.push({
            body,
            dv: fb.poweredDvMatrix?.[i]?.[j] ?? Infinity,
          });
        });
      }

      setHoverData({
        depDate,
        flybyDates: flybyDatesList,
        arrDate,
        flightTime,
        c3DepA : vecMag(c3DepA),
        c3ArrFinal : vecMag(c3ArrFinal),
        flybyDvs: flybyDvsList,
        totalPoweredDv,
        isValid,
        isPhysical,
        isConstraint,
        statusText,
        xPct: relX * 100,
        yPct: relY * 100,
      });
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragStart && dragCurrent && canvasRef.current) {
      const dx = Math.abs(dragCurrent.x - dragStart.x);
      const dy = Math.abs(dragCurrent.y - dragStart.y);

      // Perform box zoom if drag box is larger than 6x6 pixels
      if (dx > 6 && dy > 6) {
        const canvas = canvasRef.current;

        const x1 = Math.min(dragStart.x, dragCurrent.x);
        const x2 = Math.max(dragStart.x, dragCurrent.x);
        const y1 = Math.min(dragStart.y, dragCurrent.y);
        const y2 = Math.max(dragStart.y, dragCurrent.y);

        const curIMin = viewBounds ? viewBounds.iMin : 0;
        const curIMax = viewBounds ? viewBounds.iMax : Math.max(0, nDep - 1);
        const curJMin = viewBounds ? viewBounds.jMin : 0;
        const curJMax = viewBounds ? viewBounds.jMax : Math.max(0, nArr - 1);

        const rangeI = Math.max(1, curIMax - curIMin + 1);
        const rangeJ = Math.max(1, curJMax - curJMin + 1);

        const newIMin = curIMin + (x1 / canvas.width) * rangeI;
        const newIMax = curIMin + (x2 / canvas.width) * rangeI - 1;
        const newJMin = curJMin + (1 - y2 / canvas.height) * rangeJ;
        const newJMax = curJMin + (1 - y1 / canvas.height) * rangeJ - 1;

        const iMin = Math.max(0, Math.floor(newIMin));
        const iMax = Math.min(nDep - 1, Math.max(iMin + 1, Math.ceil(newIMax)));
        const jMin = Math.max(0, Math.floor(newJMin));
        const jMax = Math.min(nArr - 1, Math.max(jMin + 1, Math.ceil(newJMax)));

        setViewBounds({
          iMin,
          iMax,
          jMin,
          jMax,
        });
      } else {
        handleCanvasClick(e);
      }
    }

    setDragStart(null);
    setDragCurrent(null);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !porkchops || nDep === 0 || nArr === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const curIMin = viewBounds ? viewBounds.iMin : 0;
    const curIMax = viewBounds ? viewBounds.iMax : Math.max(0, nDep - 1);
    const curJMin = viewBounds ? viewBounds.jMin : 0;
    const curJMax = viewBounds ? viewBounds.jMax : Math.max(0, nArr - 1);

    const rangeI = Math.max(1, curIMax - curIMin + 1);
    const rangeJ = Math.max(1, curJMax - curJMin + 1);

    const relX = Math.max(0, Math.min(1, x / rect.width));
    const relY = Math.max(0, Math.min(1, y / rect.height));

    const floatI = curIMin + relX * rangeI;
    const floatJ = curJMin + (1 - relY) * rangeJ;

    const i = Math.max(0, Math.min(nDep - 1, Math.floor(floatI)));
    const j = Math.max(0, Math.min(nArr - 1, Math.floor(floatJ)));

    if (i >= 0 && i < nDep && j >= 0 && j < nArr) {
      if (instanceCount === 3) {
        const data = extractFlybyDebugData(
          seqPorkchop,
          porkchops,
          links || [],
          i,
          j,
          bodies,
          mainBody
        );
        if (data) {
          setDebugPlotData(data);
        }
      } else if (instanceCount > 3 && bodies && mainBody) {
        const multiData = extractMultiInstanceDebugData(
          seqPorkchop,
          porkchops,
          links || [],
          i,
          j,
          bodies,
          mainBody,
          sequencePorkchops
        );
        if (multiData) {
          setMultiInstanceDebugData(multiData);
        }
      }
    }
  };

  // Generate view tabs based on path length
  const tabs: { key: SeqViewTab; label: string; desc: string; unit: string }[] = [];

  if (instanceCount === 3) {
    tabs.push(
      {
        key: 'poweredDvB',
        label: `Powered Δv (${flybyBodyNames[0]})`,
        desc: `Powered flyby maneuver at ${flybyBodyNames[0]}`,
        unit: 'm/s',
      },
      {
        key: 'c3DepA',
        label: `Dep C3 (${srcBodyName})`,
        desc: `Departure C3 from ${srcBodyName}`,
        unit: 'km²/s²',
      },
      {
        key: 'c3ArrB',
        label: `Arr C3 (${flybyBodyNames[0]})`,
        desc: `Inbound arrival C3 at ${flybyBodyNames[0]}`,
        unit: 'km²/s²',
      },
      {
        key: 'c3DepB',
        label: `Dep C3 (${flybyBodyNames[0]})`,
        desc: `Outbound departure C3 from ${flybyBodyNames[0]}`,
        unit: 'km²/s²',
      },
      {
        key: 'c3ArrC',
        label: `Arr C3 (${tgtBodyName})`,
        desc: `Arrival C3 at ${tgtBodyName}`,
        unit: 'km²/s²',
      }
    );
  } else {
    tabs.push({
      key: 'totalPoweredDv',
      label: `Total Powered Δv`,
      desc: `Sum of all powered flyby maneuvers`,
      unit: 'm/s',
    });

    flybyBodyNames.forEach((fbName, idx) => {
      tabs.push({
        key: `flybyDv_${idx}`,
        label: `Flyby ${idx + 1} Δv (${fbName})`,
        desc: `Powered flyby maneuver at ${fbName}`,
        unit: 'm/s',
      });
    });

    tabs.push(
      {
        key: 'c3DepA',
        label: `Dep C3 (${srcBodyName})`,
        desc: `Departure C3 from ${srcBodyName}`,
        unit: 'km²/s²',
      },
      {
        key: 'c3ArrFinal',
        label: `Arr C3 (${tgtBodyName})`,
        desc: `Arrival C3 at ${tgtBodyName}`,
        unit: 'km²/s²',
      }
    );
  }

  const handleRecomputePointCell = (depIndex: number, arrIndex: number) => {
    if (!seqPorkchop || !bodies || !mainBody) return;

    const tDep = seqPorkchop.depDates[depIndex];
    const tArr = seqPorkchop.arrDates[arrIndex];

    const N = resolvedPathInsts.length;
    let result = null;
    if (N === 3) {
      result = evaluateSequenceTransferFromDirectPorkchops(
        resolvedPathInsts,
        tDep,
        tArr,
        bodies,
        mainBody,
        porkchops,
        links,
      );
    } else if (N > 3) {
      const suffixPath = resolvedPathInsts.slice(1, N);
      const suffixKey = suffixPath.map(i => i.id).join('-');
      const suffixSeqId = `seq-pc-${suffixKey}`;
      const hasSuffix = !!(sequencePorkchops && (sequencePorkchops[suffixSeqId] || sequencePorkchops[suffixKey]));

      const prefixPath = resolvedPathInsts.slice(0, N - 1);
      const prefixKey = prefixPath.map(i => i.id).join('-');
      const prefixSeqId = `seq-pc-${prefixKey}`;
      const hasPrefix = !!(sequencePorkchops && (sequencePorkchops[prefixSeqId] || sequencePorkchops[prefixKey]));

      // =========================================================================
      // TODO: MASSIVE ARCHITECTURAL IMPROVEMENT NEEDED HERE
      // When neither sub-chain (prefix vs. suffix) is pre-calculated in cache,
      // the choice of sub-chain direction should be improved and dynamically chosen
      // according to the estimated computational cost of each option.
      // (e.g. comparing the product of date window samples or orbital periods of the
      // remaining legs: leg (0 -> 1) + suffix (1..N-1) vs. prefix (0..N-2) + leg (N-2 -> N-1)).
      // Currently, defaulting to 'suffix' (evaluateHigherOrderSequenceTransferAddFirstLeg)
      // when neither is pre-calculated.
      // =========================================================================
      if (hasPrefix && !hasSuffix) {
        result = evaluateHigherOrderSequenceTransferAddLastLeg(
          resolvedPathInsts,
          tDep,
          tArr,
          bodies,
          mainBody,
          porkchops || {},
          links || [],
          sequencePorkchops || {}
        );
      } else {
        result = evaluateHigherOrderSequenceTransferAddFirstLeg(
          resolvedPathInsts,
          tDep,
          tArr,
          bodies,
          mainBody,
          porkchops || {},
          links || [],
          sequencePorkchops || {}
        );
      }
    }

    if (result) {
      if (seqPorkchop.totalPoweredDvMatrix && seqPorkchop.totalPoweredDvMatrix[depIndex]) {
        seqPorkchop.totalPoweredDvMatrix[depIndex][arrIndex] = result.totalDv;
      }
      if (seqPorkchop.c3DepMatrix && seqPorkchop.c3DepMatrix[depIndex]) {
        seqPorkchop.c3DepMatrix[depIndex][arrIndex] = result.c3DepA;
      }
      if (seqPorkchop.c3ArrMatrix && seqPorkchop.c3ArrMatrix[depIndex]) {
        seqPorkchop.c3ArrMatrix[depIndex][arrIndex] = result.c3ArrFinal;
      }
      if (seqPorkchop.flybys) {
        seqPorkchop.flybys.forEach((fb, fbIdx) => {
          if (fb.poweredDvMatrix && fb.poweredDvMatrix[depIndex]) {
            fb.poweredDvMatrix[depIndex][arrIndex] = result.flybyDvs[fbIdx] ?? Infinity;
          }
          if (fb.dateMatrix && fb.dateMatrix[depIndex]) {
            fb.dateMatrix[depIndex][arrIndex] = result.flybyDates[fbIdx] ?? 0;
          }
          const c3Arr = result.flybyC3Arrs?.[fbIdx] ?? (fbIdx === 0 ? result.c3ArrB : undefined);
          if (c3Arr && fb.c3ArrMatrix && fb.c3ArrMatrix[depIndex]) {
            fb.c3ArrMatrix[depIndex][arrIndex] = c3Arr;
          }
          const c3Dep = result.flybyC3Deps?.[fbIdx] ?? (fbIdx === 0 ? result.c3DepB : undefined);
          if (c3Dep && fb.c3DepMatrix && fb.c3DepMatrix[depIndex]) {
            fb.c3DepMatrix[depIndex][arrIndex] = c3Dep;
          }
        });
      }
      if (seqPorkchop.physicalValidMatrix && seqPorkchop.physicalValidMatrix[depIndex]) {
        seqPorkchop.physicalValidMatrix[depIndex][arrIndex] = true;
      }
      if (seqPorkchop.constraintValidMatrix && seqPorkchop.constraintValidMatrix[depIndex]) {
        seqPorkchop.constraintValidMatrix[depIndex][arrIndex] = result.isConstraintValid ?? false;
      }
      setRenderEpoch(e => e + 1);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4">
      <div className="bg-[#18181B] border border-[#27272A] rounded-xl shadow-2xl max-w-4xl w-full flex flex-col max-h-[96vh] overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#27272A] bg-[#09090B]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-[#2563EB]/20 text-[#60A5FA]">
              <Compass className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span>{instanceCount}-Instance Sequence Porkchop Plot</span>
                {seqPorkchop.isFullPath ? (
                  <span className="bg-[#38BDF8]/20 text-[#38BDF8] text-[10px] px-2 py-0.5 rounded border border-[#38BDF8]/30 font-bold uppercase tracking-wider">
                    Full Path
                  </span>
                ) : (
                  <span className="bg-purple-500/20 text-purple-300 text-[10px] px-2 py-0.5 rounded border border-purple-500/30 font-bold uppercase tracking-wider">
                    Subsequence
                  </span>
                )}
                <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded border border-emerald-500/30 font-semibold flex items-center gap-1">
                  <Zap className="w-3 h-3 text-emerald-400" />
                  <span>Possible departure date for free flyby: <strong>{freeFlybyDepDatesCount}</strong></span>
                </span>
              </h2>
              <div className="flex flex-col gap-1">
                <p className="text-[11px] text-[#A1A1AA]">
                  <span className="text-[#60A5FA] font-semibold">{seqPorkchop.sequenceLabel}</span>
                </p>

                {/* Subtask dependency progress indicator under main title */}
                {isComputing && currentSubtask && (
                  <div className="flex items-center gap-2 mt-0.5 px-2 py-0.5 rounded bg-blue-950/80 border border-blue-500/40 text-[11px] font-mono text-cyan-300 shadow-sm max-w-lg">
                    <RefreshCw className="w-3 h-3 animate-spin text-cyan-400 shrink-0" />
                    <span className="text-slate-400 font-semibold text-[10px] uppercase tracking-wider">Dependency:</span>
                    <span className="truncate text-cyan-200 font-medium">{currentSubtask.subtaskName}</span>
                    <div className="flex items-center gap-1.5 ml-auto shrink-0 font-bold">
                      <span className="bg-cyan-900/90 text-cyan-200 px-1.5 py-0.2 rounded text-[10px] border border-cyan-500/30">
                        {currentSubtask.progressPct}%
                      </span>
                      {currentSubtask.totalSamples > 0 && (
                        <span className="text-[10px] text-slate-400 font-normal">
                          ({currentSubtask.computedSamples}/{currentSubtask.totalSamples})
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {seqPorkchop.profiling && seqPorkchop.profiling.totalComputationTimeMs > 0 && (
              <button
                onClick={() => setIsProfilingFolded(prev => !prev)}
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-semibold bg-[#18181B] hover:bg-[#27272A] border border-[#27272A] text-emerald-400 transition cursor-pointer"
                title="Toggle Method Timing & Block Instrumentation Breakdown panel"
              >
                <Timer className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  {seqPorkchop.profiling.totalComputationTimeMs >= 1000
                    ? `${(seqPorkchop.profiling.totalComputationTimeMs / 1000).toFixed(2)}s`
                    : `${seqPorkchop.profiling.totalComputationTimeMs.toFixed(0)}ms`}
                </span>
                <span className="text-[#71717A] text-[10px]">
                  ({seqPorkchop.profiling.pointsEvaluated} pts)
                </span>
              </button>
            )}

            {/* Debug Mode Toggle: Show Filtered / Optimised-Out */}
            <button
              onClick={() => setShowOptimisedOut(!showOptimisedOut)}
              className={`px-2 py-1 rounded text-[10px] font-mono border transition ${
                showOptimisedOut
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  : 'bg-[#18181B] text-[#94A3B8] hover:text-white border-[#27272A]'
              }`}
              title="Toggle display of physically possible but optimised-out / filtered sequence transfers"
            >
              {showOptimisedOut ? 'Debug: Filtered ON' : 'Debug: Filtered OFF'}
            </button>

            {onRecomputePorkchop && (
              <button
                onClick={onRecomputePorkchop}
                disabled={isComputing}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-75 text-white transition-all shadow"
                title="Recompute this specific sequence porkchop plot directly"
              >
                {isComputing ? (
                  <span className="font-mono font-bold text-[#93C5FD] bg-[#1E40AF] px-1.5 py-0.5 rounded text-[11px]">
                    {computedPct}%
                  </span>
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                <span>{isComputing ? `Computing (${computedPct}%)` : 'Recompute Porkchop'}</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="p-1 rounded-lg text-[#A1A1AA] hover:text-white hover:bg-[#27272A] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* View Mode Tabs */}
        <div className="flex flex-wrap bg-[#09090B] border-b border-[#27272A] p-1.5 gap-1 overflow-x-auto">
          {tabs.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex-1 min-w-[90px] flex flex-col items-center px-1.5 py-1 rounded text-[11px] font-medium transition-all ${
                  isActive
                    ? 'bg-[#2563EB] text-white shadow-md font-semibold'
                    : 'text-[#A1A1AA] hover:text-white hover:bg-[#18181B]'
                }`}
                title={tab.desc}
              >
                <span className="truncate w-full text-center leading-tight">{tab.label}</span>
                <span className={`text-[9px] mt-0.5 ${isActive ? 'text-blue-200' : 'text-[#71717A]'}`}>
                  {tab.unit}
                </span>
              </button>
            );
          })}
        </div>

        {/* Heatmap & Plot Container with Y-Axis and X-Axis Legends */}
        <div className="p-2.5 sm:p-3 flex flex-col gap-2 overflow-y-auto">
          <div className="bg-[#09090B] p-2.5 sm:p-3 rounded-lg border border-[#27272A] flex flex-col items-center w-full">
            
            {/* Top Title & Zoom Reset Button */}
            <div className="w-full flex items-center justify-between text-[11px] text-[#A1A1AA] mb-1.5 font-mono">
              <div className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-[#38BDF8]" />
                Arrival at <span className="text-white font-semibold">{tgtBodyName}</span> vs Departure at <span className="text-white font-semibold">{srcBodyName}</span>
              </div>
              <div className="flex items-center gap-2">
                {viewBounds && (
                  <button
                    onClick={() => setViewBounds(null)}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-[#2563EB]/20 hover:bg-[#2563EB]/40 text-[#60A5FA] rounded border border-[#2563EB]/40 transition"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset Zoom</span>
                  </button>
                )}
                <span className="text-[10px] text-[#71717A] italic hidden sm:inline">
                  Click & drag box on heatmap to zoom
                </span>
              </div>
            </div>

            {/* Canvas Row with Left Y-Axis Legend */}
            <div className="flex items-stretch gap-2 sm:gap-3 w-full max-w-[680px] justify-center">
              
              {/* Compact Left Y-Axis Legend Column */}
              <div className="w-20 sm:w-24 shrink-0 flex flex-col justify-between items-end text-[10px] text-[#A1A1AA] font-mono py-1 select-none pr-2 border-r border-[#27272A]">
                <div className="text-right leading-tight">
                  <span className="text-[9px] text-[#71717A] uppercase font-bold block">Arr Max</span>
                  <span className="text-[#38BDF8] font-semibold text-[10px] block truncate">
                    {nArr > 0
                      ? formatShortUT(
                          seqPorkchop.arrDates[
                            Math.min(
                              nArr - 1,
                              Math.max(0, Math.round(viewBounds ? viewBounds.jMax : nArr - 1))
                            )
                          ],
                          timeFormatMode
                        )
                      : '--'}
                  </span>
                </div>
                
                <div className="rotate-[-90deg] whitespace-nowrap text-[9px] tracking-wider text-slate-300 font-bold uppercase my-auto transform origin-center">
                  Arrival at {tgtBodyName}
                </div>

                <div className="text-right leading-tight">
                  <span className="text-[9px] text-[#71717A] uppercase font-bold block">Arr Min</span>
                  <span className="text-[#38BDF8] font-semibold text-[10px] block truncate">
                    {nArr > 0
                      ? formatShortUT(
                          seqPorkchop.arrDates[
                            Math.min(
                              nArr - 1,
                              Math.max(0, Math.round(viewBounds ? viewBounds.jMin : 0))
                            )
                          ],
                          timeFormatMode
                        )
                      : '--'}
                  </span>
                </div>
              </div>

              {/* Heatmap Canvas Box - Wide rectangular aspect ratio (2:1) */}
              <div className="relative flex-1 h-[210px] sm:h-[240px] max-w-[560px]">
                <canvas
                  ref={canvasRef}
                  width={800}
                  height={400}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={() => {
                    setHoverData(null);
                    setDragStart(null);
                    setDragCurrent(null);
                  }}
                  className="w-full h-full rounded border border-[#27272A] cursor-crosshair object-fill select-none"
                />

                {/* Computing Live Indicator Overlay */}
                {isComputing && nDep > 0 && nArr > 0 && (
                  <div className="absolute top-2 right-2 flex flex-col items-end gap-1 px-2.5 py-1.5 rounded bg-black/90 border border-blue-500/50 text-[11px] font-mono text-blue-400 backdrop-blur-sm shadow-md z-10">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-[#38BDF8] bg-blue-950/80 px-1.5 py-0.5 rounded border border-blue-500/30">
                        {computedPct}%
                      </span>
                      <span>Main Task</span>
                    </div>
                    {currentSubtask && (
                      <div className="flex items-center gap-1.5 text-[10px] text-cyan-300">
                        <RefreshCw className="w-3 h-3 animate-spin text-cyan-400 shrink-0" />
                        <span className="truncate max-w-[170px]">Sub: {currentSubtask.subtaskName}</span>
                        <span className="font-bold text-cyan-200 bg-cyan-950/90 px-1 py-0.2 rounded border border-cyan-500/30">
                          {currentSubtask.progressPct}%
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Empty / Initial Loading Overlay */}
                {(nDep === 0 || nArr === 0) && (
                  <div className="absolute inset-0 bg-[#09090B]/90 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center rounded border border-[#27272A] z-20">
                    <div className="text-3xl font-mono font-bold text-[#38BDF8] mb-1">{computedPct}%</div>
                    <span className="text-xs font-mono font-bold text-white mb-2">
                      Computing {instanceCount}-Instance Sequence ({seqPorkchop.sequenceLabel})
                    </span>
                    {currentSubtask ? (
                      <div className="w-full max-w-sm bg-[#18181B] border border-blue-500/40 rounded-lg p-3 flex flex-col gap-2 shadow-lg">
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-cyan-300 font-bold flex items-center gap-1.5 truncate">
                            <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />
                            Dependency: {currentSubtask.subtaskName}
                          </span>
                          <span className="text-cyan-200 font-bold bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-500/30 shrink-0 ml-2">
                            {currentSubtask.progressPct}%
                          </span>
                        </div>
                        <div className="w-full bg-[#27272A] h-2 rounded-full overflow-hidden border border-[#3F3F46]">
                          <div
                            className="bg-gradient-to-r from-blue-500 to-cyan-400 h-full transition-all duration-150"
                            style={{ width: `${currentSubtask.progressPct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                          <span>{currentSubtask.statusText || 'Evaluating prerequisite transfers...'}</span>
                          {currentSubtask.totalSamples > 0 && (
                            <span>{currentSubtask.computedSamples} / {currentSubtask.totalSamples} samples</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[10px] font-mono text-[#94A3B8] mt-1">
                        Evaluating multi-body trajectories and flybys...
                      </span>
                    )}
                  </div>
                )}

                {/* Hover Crosshair Overlay */}
                {hoverData && (
                  <>
                    <div
                      className="absolute top-0 bottom-0 border-l border-dashed border-white/70 pointer-events-none"
                      style={{ left: `${hoverData.xPct}%` }}
                    />
                    <div
                      className="absolute left-0 right-0 border-t border-dashed border-white/70 pointer-events-none"
                      style={{ top: `${hoverData.yPct}%` }}
                    />
                  </>
                )}
              </div>
            </div>

            {/* Bottom X-Axis Legend Row */}
            <div className="w-full max-w-[680px] pl-20 sm:pl-24 flex items-center justify-between text-[10px] text-[#A1A1AA] font-mono mt-1.5 pt-1 border-t border-[#27272A]">
              <span>
                Dep Min:{' '}
                <strong className="text-[#38BDF8]">
                  {nDep > 0
                    ? formatShortUT(
                        seqPorkchop.depDates[
                          Math.min(
                            nDep - 1,
                            Math.max(0, Math.round(viewBounds ? viewBounds.iMin : 0))
                          )
                        ],
                        timeFormatMode
                      )
                    : '--'}
                </strong>
              </span>
              <span className="text-slate-300 font-bold uppercase tracking-wider text-[10px]">
                Departure at {srcBodyName} (X-Axis)
              </span>
              <span>
                Dep Max:{' '}
                <strong className="text-[#38BDF8]">
                  {nDep > 0
                    ? formatShortUT(
                        seqPorkchop.depDates[
                          Math.min(
                            nDep - 1,
                            Math.max(0, Math.round(viewBounds ? viewBounds.iMax : nDep - 1))
                          )
                        ],
                        timeFormatMode
                      )
                    : '--'}
                </strong>
              </span>
            </div>
          </div>

          {/* Color Scale Bar */}
          <div className="flex items-center justify-between text-[10px] text-[#A1A1AA] bg-[#09090B] px-2.5 py-1.5 rounded-lg border border-[#27272A]">
            <span className="font-semibold text-blue-400">Min: {effectiveMin.toFixed(1)} {tabs.find(t => t.key === activeTab)?.unit}</span>
            <div className="flex-1 mx-3 h-2 rounded bg-gradient-to-r from-blue-600 via-cyan-400 via-green-500 via-yellow-400 to-red-600 border border-[#27272A]" />
            <span className="font-semibold text-red-400">Red Cap: &ge;{redCap.toFixed(1)} {tabs.find(t => t.key === activeTab)?.unit}</span>
          </div>

          {/* Fixed-Height Hover Inspection Card - ALWAYS Visible to prevent canvas shifting */}
          <div className="bg-[#09090B] border border-[#27272A] rounded-lg p-2.5 font-mono text-[11px] min-h-[105px] flex flex-col justify-between">
            <div className="flex items-center justify-between border-b border-[#27272A] pb-1 mb-1.5 text-[10px]">
              <span className="text-[#A1A1AA] font-semibold flex items-center gap-1">
                <Compass className="w-3 h-3 text-[#38BDF8]" /> Trajectory Inspection
              </span>
              <span className="text-[#71717A]">
                {hoverData ? (hoverData.isValid ? 'Valid Solution' : 'Invalid / Violation') : 'Hover over heatmap to inspect'}
              </span>
            </div>

            {/* Row 1: Key Dates & Flight Time */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <span className="text-[#71717A] block text-[9px]">Dep ({srcBodyName}):</span>
                <span className="text-white font-semibold">
                  {hoverData ? formatShortUT(hoverData.depDate, timeFormatMode) : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">
                  Flyby ({flybyBodyNames.join(', ') || 'Intermediate'}):
                </span>
                <span className="text-[#38BDF8] font-semibold">
                  {hoverData && hoverData.flybyDates.length > 0
                    ? hoverData.flybyDates.map(f => `${f.body}: ${formatShortUT(f.date, timeFormatMode)}`).join(' | ')
                    : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Arr ({tgtBodyName}):</span>
                <span className="text-white font-semibold">
                  {hoverData ? formatShortUT(hoverData.arrDate, timeFormatMode) : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Total Flight Time:</span>
                <span className="text-white font-semibold">
                  {hoverData ? formatDuration(hoverData.flightTime, timeFormatMode) : '--'}
                </span>
              </div>
            </div>

            {/* Row 2: Metrics breakdown */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 border-t border-[#27272A] pt-1.5 mt-1.5 text-[10px]">
              <div>
                <span className="text-[#71717A] block text-[9px]">Dep C3 ({srcBodyName}):</span>
                <span className={activeTab === 'c3DepA' ? 'text-[#38BDF8] font-bold' : 'text-slate-200'}>
                  {hoverData && (hoverData.isConstraint || showOptimisedOut) && isFinite(hoverData.c3DepA) ? `${hoverData.c3DepA.toFixed(1)} km²/s²` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Arr C3 ({tgtBodyName}):</span>
                <span className={activeTab === 'c3ArrFinal' || activeTab === 'c3ArrD' || activeTab === 'c3ArrC' ? 'text-[#38BDF8] font-bold' : 'text-slate-200'}>
                  {hoverData && (hoverData.isConstraint || showOptimisedOut) && isFinite(hoverData.c3ArrFinal) ? `${hoverData.c3ArrFinal.toFixed(1)} km²/s²` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Flyby Powered Δv:</span>
                <span className={activeTab.includes('powered') || activeTab.includes('flyby') ? 'text-[#38BDF8] font-bold' : 'text-slate-200'}>
                  {hoverData && (hoverData.isConstraint || showOptimisedOut) && hoverData.flybyDvs.length > 0
                    ? hoverData.flybyDvs.map(f => `${f.body}: ${f.dv.toFixed(1)} m/s`).join(', ') || `${hoverData.totalPoweredDv.toFixed(1)} m/s`
                    : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Total Powered Δv:</span>
                <span className={activeTab === 'totalPoweredDv' ? 'text-[#38BDF8] font-bold' : 'text-emerald-400 font-semibold'}>
                  {hoverData && (hoverData.isConstraint || showOptimisedOut) && isFinite(hoverData.totalPoweredDv) ? `${hoverData.totalPoweredDv.toFixed(1)} m/s` : '--'}
                </span>
              </div>

              <div className="col-span-2 sm:col-span-1">
                <span className="text-[#71717A] block text-[9px] uppercase">Solution Status:</span>
                <span className={`text-[10px] font-mono font-bold leading-tight ${
                  !hoverData
                    ? 'text-[#64748B]'
                    : !hoverData.isPhysical
                    ? 'text-rose-400'
                    : hoverData.isConstraint
                    ? 'text-[#60A5FA]'
                    : 'text-amber-400'
                }`}>
                  {hoverData ? hoverData.statusText : '--'}
                </span>
              </div>
            </div>

            {/* Row 3: Feasible Date Windows & Free Flyby Dates */}
            <div className="border-t border-[#27272A] pt-1.5 mt-1.5 text-[10px] flex flex-wrap items-center justify-between gap-2 text-[#A1A1AA]">
              <div className="flex items-center gap-1.5 font-semibold text-[#60A5FA]">
                <Calendar className="w-3 h-3 text-[#60A5FA]" />
                <span>Feasible Windows:</span>
              </div>
              {dateWindows ? (
                <div className="flex flex-wrap items-center gap-3 font-mono text-[10px]">
                  <div>
                    <span className="text-[#71717A] mr-1">Dep:</span>
                    <strong className="text-white">{formatShortUT(dateWindows.depStart, timeFormatMode)} ➔ {formatShortUT(dateWindows.depEnd, timeFormatMode)}</strong>
                    <span className="text-[#38BDF8] ml-1">({formatDuration(dateWindows.depDuration, timeFormatMode)})</span>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Arr:</span>
                    <strong className="text-white">{formatShortUT(dateWindows.arrStart, timeFormatMode)} ➔ {formatShortUT(dateWindows.arrEnd, timeFormatMode)}</strong>
                    <span className="text-[#38BDF8] ml-1">({formatDuration(dateWindows.arrDuration, timeFormatMode)})</span>
                  </div>
                </div>
              ) : (
                <span className="italic text-[#71717A]">No feasible transfers found in this range.</span>
              )}
            </div>

            {/* Row 4: Possible departure date for free flyby */}
            <div className="border-t border-[#27272A] pt-1.5 mt-1.5 text-[10px] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-semibold text-emerald-400">
                <Zap className="w-3 h-3 text-emerald-400" />
                <span>possible departure date for free flyby:</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <span className="bg-emerald-950/80 text-emerald-300 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                  {freeFlybyDepDatesCount} {freeFlybyDepDatesCount === 1 ? 'date' : 'dates'}
                </span>
                <span className="text-[#71717A] text-[9px]">
                  (Δv cost ≤ 1 m/s out of {nDep} departure samples)
                </span>
              </div>
            </div>

          </div>

          {/* Block Timing & Instrumentation Profiling Section */}
          {seqPorkchop.profiling ? (
            <div className="bg-[#09090B] border border-[#27272A] rounded-lg p-2.5 font-mono text-[11px] flex flex-col gap-2">
              {/* Profiling Header */}
              <div className="flex items-center justify-between border-b border-[#27272A] pb-1.5 text-[10px]">
                <div className="flex items-center gap-1.5">
                  <Timer className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-white font-bold uppercase tracking-wider">
                    Method Block Timing &amp; Performance Instrumentation
                  </span>
                  <span className="text-[#71717A] hidden md:inline">
                    (evaluateSequenceTransferFromDirectPorkchops)
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400 font-bold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-500/40 text-[10px]">
                    Total Time: {seqPorkchop.profiling.totalComputationTimeMs >= 1000
                      ? `${(seqPorkchop.profiling.totalComputationTimeMs / 1000).toFixed(2)} s`
                      : `${seqPorkchop.profiling.totalComputationTimeMs.toFixed(1)} ms`}
                  </span>
                  <span className="text-[#94A3B8] text-[10px] hidden sm:inline">
                    {seqPorkchop.profiling.pointsEvaluated} pts evaluated
                  </span>
                  <button
                    onClick={() => setIsProfilingFolded(prev => !prev)}
                    className="p-0.5 rounded text-[#A1A1AA] hover:text-white hover:bg-[#27272A] transition"
                    title={isProfilingFolded ? 'Expand Block Profiling Breakdown' : 'Collapse Block Profiling Breakdown'}
                  >
                    {isProfilingFolded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Multi-Segment Proportional Progress Bar */}
              {!isProfilingFolded && seqPorkchop.profiling.blocks && seqPorkchop.profiling.blocks.length > 0 && (
                <div className="w-full h-2.5 rounded bg-[#18181B] border border-[#27272A] overflow-hidden flex">
                  {seqPorkchop.profiling.blocks.map((block) => {
                    const pct = Math.max(0, Math.min(100, block.percentage || 0));
                    if (pct <= 0) return null;
                    const blockId = block.id;
                    const colorClass =
                      blockId === 'matrix_lookup' ? 'bg-sky-400' :
                      blockId === 'candidate_pooling' ? 'bg-amber-400' :
                      blockId === 'sampling_physics' ? 'bg-emerald-400' :
                      blockId === 'local_minima' ? 'bg-purple-400' :
                      'bg-blue-500';

                    const timeVal = block.timeMs ?? 0;
                    return (
                      <div
                        key={block.id}
                        style={{ width: `${pct}%` }}
                        className={`${colorClass} h-full transition-all duration-300`}
                        title={`${block.name}: ${timeVal.toFixed(1)} ms (${pct.toFixed(1)}%)`}
                      />
                    );
                  })}
                </div>
              )}

              {/* Expanded Detailed Block Cards */}
              {!isProfilingFolded && seqPorkchop.profiling.blocks && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-1">
                  {seqPorkchop.profiling.blocks.map((block, idx) => {
                    const pct = Math.max(0, Math.min(100, block.percentage || 0));
                    const blockId = block.id;
                    const colorBadge =
                      blockId === 'matrix_lookup' ? 'bg-sky-500/20 text-sky-300 border-sky-500/40' :
                      blockId === 'candidate_pooling' ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' :
                      blockId === 'sampling_physics' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' :
                      blockId === 'local_minima' ? 'bg-purple-500/20 text-purple-300 border-purple-500/40' :
                      'bg-blue-500/20 text-blue-300 border-blue-500/40';

                    const barColor =
                      blockId === 'matrix_lookup' ? 'bg-sky-400' :
                      blockId === 'candidate_pooling' ? 'bg-amber-400' :
                      blockId === 'sampling_physics' ? 'bg-emerald-400' :
                      blockId === 'local_minima' ? 'bg-purple-400' :
                      'bg-blue-500';

                    const timeVal = block.timeMs ?? 0;
                    const avgVal = block.avgTimeUs ?? 0;
                    const callCount = block.callCount ?? 0;

                    return (
                      <div
                        key={block.id}
                        className="bg-[#18181B] border border-[#27272A] rounded p-2 flex flex-col justify-between gap-1.5 shadow-sm"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className={`text-[9px] px-1.5 py-0.2 rounded border font-bold uppercase ${colorBadge}`}>
                            Step {idx + 1}: {block.name}
                          </span>
                          <span className="text-white font-bold text-[10px]">
                            {pct.toFixed(1)}%
                          </span>
                        </div>

                        <p className="text-[9px] text-[#A1A1AA] line-clamp-2 leading-tight">
                          {block.description}
                        </p>

                        {/* Progress Bar for Block */}
                        <div className="w-full h-1 rounded bg-[#27272A] overflow-hidden">
                          <div
                            style={{ width: `${pct}%` }}
                            className={`${barColor} h-full transition-all duration-300`}
                          />
                        </div>

                        <div className="flex items-center justify-between text-[9px] text-[#71717A] pt-0.5 border-t border-[#27272A]/60">
                          <span>
                            Time: <strong className="text-slate-200">{timeVal.toFixed(1)} ms</strong>
                          </span>
                          <span>
                            Avg: <strong className="text-slate-200">
                              {avgVal >= 1000
                                ? `${(avgVal / 1000).toFixed(2)} ms`
                                : `${avgVal.toFixed(1)} µs`}
                            </strong>
                          </span>
                          <span>
                            Calls: <strong className="text-slate-200">{callCount.toLocaleString()}</strong>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-[#09090B] border border-[#27272A] rounded-lg p-2.5 font-mono text-[11px] flex items-center justify-between text-[#A1A1AA]">
              <div className="flex items-center gap-2">
                <Timer className="w-3.5 h-3.5 text-[#38BDF8]" />
                <span>Method block timing instrumentation is active. Recompute this porkchop to record live profiling stats.</span>
              </div>
              {onRecomputePorkchop && (
                <button
                  onClick={onRecomputePorkchop}
                  disabled={isComputing}
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-70 text-white transition"
                >
                  {isComputing ? 'Profiling...' : 'Recompute to Profile'}
                </button>
              )}
            </div>
          )}

        </div>

      </div>

      {/* 3-Instance Flyby Matplotlib Debug Plot Modal */}
      {debugPlotData && (
        <FlybyDebugPlotModal
          initialData={debugPlotData}
          seqPorkchop={seqPorkchop}
          porkchops={porkchops}
          links={links}
          bodies={bodies}
          mainBody={mainBody}
          timeFormatMode={timeFormatMode}
          onClose={() => setDebugPlotData(null)}
          onRecomputePoint={handleRecomputePointCell}
        />
      )}

      {/* Multi-Instance (N > 3) Debug Table & Inspector Modal */}
      {multiInstanceDebugData && (
        <MultiInstanceDebugModal
          initialData={multiInstanceDebugData}
          seqPorkchop={seqPorkchop}
          porkchops={porkchops}
          links={links}
          bodies={bodies}
          mainBody={mainBody}
          sequencePorkchops={sequencePorkchops}
          timeFormatMode={timeFormatMode}
          onClose={() => setMultiInstanceDebugData(null)}
          onRecomputePoint={handleRecomputePointCell}
        />
      )}
    </div>
  );
};
