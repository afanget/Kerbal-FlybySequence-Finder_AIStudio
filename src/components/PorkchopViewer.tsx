/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { PorkchopPlotData } from '../types';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import { X, Activity, Layers, Crosshair, RefreshCw, Calendar, RotateCcw } from 'lucide-react';

interface PorkchopViewerProps {
  porkchop: PorkchopPlotData;
  timeFormatMode: 'ksp' | 'earth';
  isComputing?: boolean;
  onRecompute?: () => void;
  onClose: () => void;
}

export const PorkchopViewer: React.FC<PorkchopViewerProps> = ({
  porkchop,
  timeFormatMode,
  isComputing,
  onRecompute,
  onClose,
}) => {
  const [viewMode, setViewMode] = useState<'c3Dep' | 'c3Arr' | 'dvTotal'>('c3Dep');
  const [showOptimisedOut, setShowOptimisedOut] = useState<boolean>(false);
  const [hoverData, setHoverData] = useState<{
    depDate: number;
    arrDate: number;
    flightTime: number;
    val: number;
    c3Dep: number;
    c3Arr: number;
    dvTotal: number;
    isValid: boolean;
    isPhysical: boolean;
    isConstraint: boolean;
    statusText: string;
    xPct: number;
    yPct: number;
  } | null>(null);

  // View bounds for click-and-drag box zoom
  const [viewBounds, setViewBounds] = useState<{
    iMin: number;
    iMax: number;
    jMin: number;
    jMax: number;
  } | null>(null);

  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const nDep = porkchop.depDates.length;
  const nArr = porkchop.arrDates.length;
  const totalSamples = porkchop.totalSamples ?? (nDep * nArr);
  const computedSamples = porkchop.computedSamples ?? (isComputing ? 0 : totalSamples);
  const computedPct = totalSamples > 0
    ? Math.min(100, Math.max(0, Math.round((computedSamples / totalSamples) * 100)))
    : (isComputing ? 0 : 100);

  // Find min & max values for scale mapping (memoized for high performance)
  const { minVal, maxVal, effectiveMin, redCap, logRange } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;

    const constrValid = porkchop.constraintValidMatrix;
    const physValid = porkchop.physicalValidMatrix;
    let matrix = porkchop.dvMatrix;
    if (viewMode === 'c3Dep') matrix = porkchop.c3DepMatrix;
    else if (viewMode === 'c3Arr') matrix = porkchop.c3ArrMatrix;

    if (matrix) {
      for (let i = 0; i < nDep; i++) {
        const cRow = constrValid ? constrValid[i] : null;
        const pRow = physValid ? physValid[i] : null;
        const mRow = matrix[i];
        if (!mRow) continue;
        for (let j = 0; j < nArr; j++) {
          const isEligible = showOptimisedOut
            ? (pRow ? pRow[j] : false)
            : (cRow ? cRow[j] : false);

          if (isEligible) {
            const val = mRow[j];
            if (Number.isFinite(val) && val > 0) {
              if (val < min) min = val;
              if (val > max) max = val;
            }
          }
        }
      }
    }

    if (min === Infinity) {
      min = 0;
      max = 100;
    }

    const effMin = Math.max(1e-4, min);
    const red = effMin * Math.pow(1.1, 16);
    const range = Math.log(red / effMin);

    return { minVal: min, maxVal: max, effectiveMin: effMin, redCap: red, logRange: range };
  }, [porkchop, viewMode, showOptimisedOut, nDep, nArr]);

  // Compute departure & arrival date windows based on first/last feasible columns (departure) and lines (arrival)
  const dateWindows = useMemo(() => {
    const vMatrix = porkchop.constraintValidMatrix || porkchop.physicalValidMatrix;
    if (!vMatrix || nDep === 0 || nArr === 0) {
      return null;
    }

    let firstDepIdx = -1;
    let lastDepIdx = -1;
    let firstArrIdx = -1;
    let lastArrIdx = -1;

    // First and last departure columns (i) with at least one feasible sample
    for (let i = 0; i < nDep; i++) {
      const row = vMatrix[i];
      if (row && row.some(Boolean)) {
        if (firstDepIdx === -1) firstDepIdx = i;
        lastDepIdx = i;
      }
    }

    // First and last arrival lines (j) with at least one feasible sample
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

    const depStart = porkchop.depDates[firstDepIdx];
    const depEnd = porkchop.depDates[lastDepIdx];
    const arrStart = porkchop.arrDates[firstArrIdx];
    const arrEnd = porkchop.arrDates[lastArrIdx];

    return {
      depStart,
      depEnd,
      depDuration: depEnd - depStart,
      arrStart,
      arrEnd,
      arrDuration: arrEnd - arrStart,
    };
  }, [porkchop, nDep, nArr]);

  // Draw Heatmap Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

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

    for (let i = startI; i <= endI; i++) {
      const x1 = ((i - curIMin) / rangeI) * width;
      const x2 = ((i + 1 - curIMin) / rangeI) * width;
      const cellW = Math.max(0.5, x2 - x1);

      for (let j = startJ; j <= endJ; j++) {
        const y1 = height - ((j + 1 - curJMin) / rangeJ) * height;
        const y2 = height - ((j - curJMin) / rangeJ) * height;
        const cellH = Math.max(0.5, y2 - y1);

        const dt = porkchop.arrDates[j] - porkchop.depDates[i];
        const isPhysical = porkchop.physicalValidMatrix
          ? !!porkchop.physicalValidMatrix[i]?.[j]
          : dt >= 3600;

        const isConstraint = porkchop.constraintValidMatrix
          ? !!porkchop.constraintValidMatrix[i]?.[j]
          : false;

        // Physically impossible transfers are strictly hidden (never displayed as viable paths)
        if (!isPhysical) {
          ctx.fillStyle = '#0B0F19'; // Dark void for physically impossible points
          ctx.fillRect(x1, y1, cellW + 0.5, cellH + 0.5);
          continue;
        }

        // If physically possible but filtered out (optimised-out) by C3/duration constraints
        if (!isConstraint && !showOptimisedOut) {
          ctx.fillStyle = '#0F172A'; // Dark background when debug mode is off
          ctx.fillRect(x1, y1, cellW + 0.5, cellH + 0.5);
          continue;
        }

        let val = 0;
        if (viewMode === 'c3Dep') val = porkchop.c3DepMatrix[i]?.[j] ?? 0;
        else if (viewMode === 'c3Arr') val = porkchop.c3ArrMatrix[i]?.[j] ?? 0;
        else val = porkchop.dvMatrix[i]?.[j] ?? 0;

        // Logarithmic normalization to [0, 1] where minVal -> 0 (blue) and redCap -> 1 (red)
        let norm = 0;
        if (val <= effectiveMin) {
          norm = 0;
        } else if (val >= redCap) {
          norm = 1;
        } else if (logRange > 0) {
          norm = Math.log(val / effectiveMin) / logRange;
        }
        norm = Math.max(0, Math.min(1, norm));

        // HSL Color gradient: Blue (240) -> Cyan (180) -> Green (120) -> Yellow (60) -> Red (0)
        const hue = (1 - norm) * 240;
        if (isConstraint) {
          ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
        } else {
          // Subdued hue for optimised-out solutions during debug inspection
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

      ctx.fillStyle = 'rgba(96, 165, 250, 0.25)';
      ctx.strokeStyle = '#60A5FA';
      ctx.lineWidth = 2;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    }
  }, [porkchop, viewMode, showOptimisedOut, minVal, effectiveMin, redCap, logRange, nDep, nArr, viewBounds, dragStart, dragCurrent]);

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
      const depDate = porkchop.depDates[i];
      const arrDate = porkchop.arrDates[j];
      const flightTime = porkchop.flightTimeMatrix[i]?.[j] || (arrDate - depDate);
      const c3Dep = porkchop.c3DepMatrix[i]?.[j] || 0;
      const c3Arr = porkchop.c3ArrMatrix[i]?.[j] || 0;
      const dt = arrDate - depDate;

      const isPhysical = porkchop.physicalValidMatrix
        ? !!porkchop.physicalValidMatrix[i]?.[j]
        : dt >= 3600;

      const isConstraint = porkchop.constraintValidMatrix
        ? !!porkchop.constraintValidMatrix[i]?.[j]
        : false;

      const isValid = isConstraint;

      let statusText = 'Valid Solution';
      if (!isPhysical) {
        statusText = dt < 3600 ? 'Physically Impossible (Arrival ≤ Departure)' : 'Physically Impossible (Orbit Collision)';
      } else if (!isConstraint) {
        statusText = 'Optimised-out (Exceeds C3/Duration Bounds)';
      }

      const dvTotal = porkchop.dvMatrix[i]?.[j] || 0;

      let val = 0;
      if (viewMode === 'c3Dep') val = c3Dep;
      else if (viewMode === 'c3Arr') val = c3Arr;
      else val = dvTotal;

      setHoverData({
        depDate,
        arrDate,
        flightTime,
        val,
        c3Dep,
        c3Arr,
        dvTotal,
        isValid,
        isPhysical,
        isConstraint,
        statusText,
        xPct: relX * 100,
        yPct: relY * 100,
      });
    }
  };

  const handleCanvasMouseUp = () => {
    if (dragStart && dragCurrent && canvasRef.current) {
      const dx = Math.abs(dragCurrent.x - dragStart.x);
      const dy = Math.abs(dragCurrent.y - dragStart.y);

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
      }
    }

    setDragStart(null);
    setDragCurrent(null);
  };

  return (
    <div id="porkchop-modal-backdrop" className="fixed inset-0 z-50 bg-[#0D0D0E]/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div id="porkchop-modal-dialog" className="bg-[#1A1B1E] border border-[#2D2E33] rounded-lg w-full max-w-3xl shadow-2xl overflow-hidden text-[#E2E8F0] flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#1A1B1E] border-b border-[#2D2E33]">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#60A5FA]" />
            <h2 className="font-serif text-sm uppercase tracking-wider text-[#E2E8F0] flex items-center gap-2">
              Porkchop Plot: <span className="text-[#60A5FA] font-mono">{porkchop.sourceBody}</span> ➔ <span className="text-[#60A5FA] font-mono">{porkchop.targetBody}</span>
            </h2>
          </div>

          <div className="flex items-center gap-2">
            {onRecompute ? (
              <button
                onClick={onRecompute}
                disabled={isComputing}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono transition border ${
                  isComputing
                    ? 'bg-[#38BDF8]/15 text-[#38BDF8] border-[#38BDF8]/40 cursor-wait'
                    : 'bg-[#25262B] hover:bg-[#334155] border-[#2D2E33] text-[#94A3B8] hover:text-white cursor-pointer'
                }`}
                title={isComputing ? `Computing... (${computedSamples}/${totalSamples} samples - ${computedPct}%)` : 'Recompute this single transfer plot'}
              >
                {isComputing ? (
                  <span className="font-bold text-[#38BDF8] bg-[#38BDF8]/20 px-1.5 py-0.5 rounded">
                    {computedPct}%
                  </span>
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                <span>
                  {isComputing
                    ? `Computing (${computedPct}%)`
                    : 'Recompute'}
                </span>
              </button>
            ) : isComputing ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-[#38BDF8]/10 border border-[#38BDF8]/30 text-[#38BDF8] rounded text-[11px] font-mono">
                <span className="font-bold text-[#38BDF8] bg-[#38BDF8]/20 px-1.5 py-0.5 rounded">{computedPct}%</span>
                <span>Computing ({computedPct}%)</span>
              </span>
            ) : null}

            {/* View Mode Toggle */}
            <div className="flex bg-[#25262B] p-1 rounded border border-[#2D2E33] text-[11px] font-mono uppercase tracking-wider">
              <button
                onClick={() => setViewMode('c3Dep')}
                className={`px-2.5 py-1 rounded transition ${viewMode === 'c3Dep' ? 'bg-[#334155] text-white shadow' : 'text-[#94A3B8] hover:text-white'}`}
              >
                Departure C3
              </button>
              <button
                onClick={() => setViewMode('c3Arr')}
                className={`px-2.5 py-1 rounded transition ${viewMode === 'c3Arr' ? 'bg-[#334155] text-white shadow' : 'text-[#94A3B8] hover:text-white'}`}
              >
                Arrival C3
              </button>
              <button
                onClick={() => setViewMode('dvTotal')}
                className={`px-2.5 py-1 rounded transition ${viewMode === 'dvTotal' ? 'bg-[#334155] text-white shadow' : 'text-[#94A3B8] hover:text-white'}`}
              >
                Total Δv
              </button>
            </div>

            {/* Debug Mode Toggle: Show Filtered / Optimised-Out */}
            <button
              onClick={() => setShowOptimisedOut(!showOptimisedOut)}
              className={`px-2 py-1 rounded text-[10px] font-mono border transition ${
                showOptimisedOut
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                  : 'bg-[#25262B] text-[#94A3B8] hover:text-white border-[#2D2E33]'
              }`}
              title="Toggle display of physically possible but optimised-out / filtered solutions"
            >
              {showOptimisedOut ? 'Debug: Filtered ON' : 'Debug: Filtered OFF'}
            </button>

            <button onClick={onClose} className="p-1 hover:bg-[#25262B] rounded text-[#94A3B8] hover:text-white transition">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Porkchop Heatmap Canvas */}
        <div className="p-5 flex flex-col md:flex-row gap-5 overflow-y-auto">
          {/* Main Heatmap Canvas */}
          <div className="flex-1 flex flex-col items-center w-full">
            {/* Top Zoom Control Bar */}
            <div className="w-full max-w-[510px] flex items-center justify-between text-[11px] text-[#94A3B8] font-mono mb-1.5">
              <span className="text-[10px] italic">
                Click & drag box to zoom
              </span>
              {viewBounds && (
                <button
                  onClick={() => setViewBounds(null)}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] bg-[#60A5FA]/20 hover:bg-[#60A5FA]/30 text-[#60A5FA] rounded border border-[#60A5FA]/40 transition"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset Zoom</span>
                </button>
              )}
            </div>

            <div className="w-full max-w-[510px] flex gap-2 items-stretch">
              {/* Y-Axis Legend */}
              <div className="flex flex-col justify-between items-end text-[10px] text-[#94A3B8] font-mono py-0.5 select-none w-20 shrink-0">
                <span className="text-right truncate text-[10px]">
                  {formatShortUT(
                    porkchop.arrDates[
                      Math.min(
                        nArr - 1,
                        Math.max(0, Math.round(viewBounds ? viewBounds.jMax : nArr - 1))
                      )
                    ],
                    timeFormatMode
                  )}
                </span>
                <div className="rotate-[-90deg] whitespace-nowrap uppercase font-serif text-[10px] tracking-wider text-[#60A5FA] my-auto">
                  Arrival Date ➔
                </div>
                <span className="text-right truncate text-[10px]">
                  {formatShortUT(
                    porkchop.arrDates[
                      Math.min(
                        nArr - 1,
                        Math.max(0, Math.round(viewBounds ? viewBounds.jMin : 0))
                      )
                    ],
                    timeFormatMode
                  )}
                </span>
              </div>

              {/* Canvas Container */}
              <div className="relative flex-1 aspect-square bg-[#0D0D0E] border border-[#2D2E33] rounded overflow-hidden shadow-inner group">
                <canvas
                  ref={canvasRef}
                  width={400}
                  height={400}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={() => {
                    setHoverData(null);
                    setDragStart(null);
                    setDragCurrent(null);
                  }}
                  className="w-full h-full cursor-crosshair select-none"
                />

                {/* Live computing indicator */}
                {isComputing && nDep > 0 && nArr > 0 && (
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/85 border border-[#38BDF8]/40 text-[10px] font-mono text-[#38BDF8] backdrop-blur-sm shadow-md">
                    <span className="font-bold bg-[#38BDF8]/20 px-1 py-0.2 rounded">{computedPct}%</span>
                    <span>Computing...</span>
                  </div>
                )}

                {/* Crosshair indicator on hover */}
                {hoverData && (
                  <div
                    className="absolute pointer-events-none border-l border-t border-white/80 w-full h-full"
                    style={{ left: `${hoverData.xPct}%`, top: `${hoverData.yPct}%` }}
                  />
                )}
              </div>
            </div>

            {/* X-Axis Labels */}
            <div className="w-full max-w-[510px] flex pl-22 mt-2 text-[10px] text-[#94A3B8] font-mono justify-between items-center">
              <span>
                Dep:{' '}
                {formatShortUT(
                  porkchop.depDates[
                    Math.min(
                      nDep - 1,
                      Math.max(0, Math.round(viewBounds ? viewBounds.iMin : 0))
                    )
                  ],
                  timeFormatMode
                )}
              </span>
              <span className="uppercase font-serif text-[10px] tracking-wider text-[#60A5FA]">Departure Date ➔</span>
              <span>
                {formatShortUT(
                  porkchop.depDates[
                    Math.min(
                      nDep - 1,
                      Math.max(0, Math.round(viewBounds ? viewBounds.iMax : nDep - 1))
                    )
                  ],
                  timeFormatMode
                )}
              </span>
            </div>
          </div>

          {/* Side Info & Legend Panel */}
          <div className="w-full md:w-64 flex flex-col gap-3">
            {/* Value scale gradient bar */}
            <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] text-xs">
              <span className="font-serif uppercase tracking-wider text-[11px] text-[#E2E8F0] block mb-1.5 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5 text-[#60A5FA]" />
                Log Color Scale ({viewMode === 'dvTotal' ? 'm/s' : 'km²/s²'})
              </span>
              <div className="h-3 w-full rounded bg-gradient-to-r from-blue-500 via-cyan-400 via-green-400 via-yellow-400 to-red-500 shadow-inner" />
              <div className="flex justify-between text-[10px] text-[#94A3B8] mt-1 font-mono">
                <span>Min: {minVal.toFixed(1)}</span>
                <span>Red (≥): {redCap < 1e6 ? redCap.toFixed(1) : redCap.toExponential(1)}</span>
              </div>
            </div>

            {/* Hover details inspector - Fixed height reserved */}
            <div className="bg-[#25262B] p-3.5 rounded border border-[#2D2E33] text-xs flex-1 flex flex-col justify-between min-h-[210px]">
              <div>
                <span className="font-serif uppercase tracking-wider text-[11px] text-[#E2E8F0] flex items-center justify-between mb-2">
                  <span className="flex items-center gap-1">
                    <Crosshair className="w-3.5 h-3.5 text-[#60A5FA]" /> Hover Inspector
                  </span>
                  <span className="text-[10px] font-mono text-[#94A3B8]">
                    {hoverData ? (hoverData.isValid ? 'Valid' : 'Infeasible') : 'Hover heatmap'}
                  </span>
                </span>

                <div className="space-y-1.5 font-mono text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">Dep Date:</span>
                    <strong className="text-[#60A5FA]">{hoverData ? formatShortUT(hoverData.depDate, timeFormatMode) : '--'}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">Arr Date:</span>
                    <strong className="text-[#60A5FA]">{hoverData ? formatShortUT(hoverData.arrDate, timeFormatMode) : '--'}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">Flight Duration:</span>
                    <strong className="text-[#60A5FA]">{hoverData ? formatDuration(hoverData.flightTime, timeFormatMode) : '--'}</strong>
                  </div>
                  <div className="pt-2 border-t border-[#2D2E33] flex justify-between">
                    <span className="text-[#94A3B8]">Dep C3:</span>
                    <strong className="text-[#E2E8F0]">{hoverData ? `${hoverData.c3Dep.toFixed(2)} km²/s²` : '--'}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">Arr C3:</span>
                    <strong className="text-[#E2E8F0]">{hoverData ? `${hoverData.c3Arr.toFixed(2)} km²/s²` : '--'}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#94A3B8]">Total Δv:</span>
                    <strong className="text-[#38BDF8] font-bold">{hoverData ? `${hoverData.dvTotal.toFixed(1)} m/s` : '--'}</strong>
                  </div>
                  <div className="flex flex-col gap-0.5 pt-1.5 border-t border-[#2D2E33]">
                    <span className="text-[#94A3B8] text-[10px] uppercase">Solution Status:</span>
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
              </div>

              <div className="mt-3 pt-2 border-t border-[#2D2E33] text-[10px] text-[#94A3B8]">
                Minimum energy transfer: <strong className="text-[#60A5FA] font-mono">{minVal.toFixed(2)} {viewMode === 'dvTotal' ? 'm/s' : 'km²/s²'}</strong>
              </div>
            </div>

            {/* Feasible Date Windows */}
            <div className="bg-[#25262B] p-3.5 rounded border border-[#2D2E33] text-xs">
              <span className="font-serif uppercase tracking-wider text-[11px] text-[#E2E8F0] flex items-center gap-1 mb-2">
                <Calendar className="w-3.5 h-3.5 text-[#60A5FA]" /> Feasible Date Windows
              </span>

              {dateWindows ? (
                <div className="space-y-2.5 font-mono text-[11px]">
                  <div>
                    <div className="text-[#94A3B8] text-[10px] uppercase tracking-wider mb-0.5 flex items-center justify-between">
                      <span>Departure Window</span>
                      <span className="text-[#60A5FA]">{formatDuration(dateWindows.depDuration, timeFormatMode)}</span>
                    </div>
                    <div className="text-[#E2E8F0] text-[11px] bg-[#1A1B1E] px-2 py-1 rounded border border-[#2D2E33]">
                      {formatShortUT(dateWindows.depStart, timeFormatMode)} ➔ {formatShortUT(dateWindows.depEnd, timeFormatMode)}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-[#2D2E33]">
                    <div className="text-[#94A3B8] text-[10px] uppercase tracking-wider mb-0.5 flex items-center justify-between">
                      <span>Arrival Window</span>
                      <span className="text-[#60A5FA]">{formatDuration(dateWindows.arrDuration, timeFormatMode)}</span>
                    </div>
                    <div className="text-[#E2E8F0] text-[11px] bg-[#1A1B1E] px-2 py-1 rounded border border-[#2D2E33]">
                      {formatShortUT(dateWindows.arrStart, timeFormatMode)} ➔ {formatShortUT(dateWindows.arrEnd, timeFormatMode)}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-[#64748B] italic text-[11px]">
                  {isComputing ? 'Computing feasible windows...' : 'No feasible transfers found in this range.'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
