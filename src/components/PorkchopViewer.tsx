/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { PorkchopPlotData } from '../types';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import { X, Activity, Layers, Crosshair, RefreshCw } from 'lucide-react';

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
  const [hoverData, setHoverData] = useState<{
    depDate: number;
    arrDate: number;
    flightTime: number;
    val: number;
    c3Dep: number;
    c3Arr: number;
    isValid: boolean;
    xPct: number;
    yPct: number;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const nDep = porkchop.depDates.length;
  const nArr = porkchop.arrDates.length;
  const totalSamples = porkchop.totalSamples ?? (nDep * nArr);
  const computedSamples = porkchop.computedSamples ?? (isComputing ? 0 : totalSamples);

  // Find min & max values for scale mapping
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (let i = 0; i < nDep; i++) {
    for (let j = 0; j < nArr; j++) {
      if (porkchop.validMatrix[i]?.[j]) {
        let val = 0;
        if (viewMode === 'c3Dep') val = porkchop.c3DepMatrix[i][j];
        else if (viewMode === 'c3Arr') val = porkchop.c3ArrMatrix[i][j];
        else val = porkchop.dvMatrix[i][j];

        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }
    }
  }

  if (minVal === Infinity) {
    minVal = 0;
    maxVal = 100;
  }

  const effectiveMin = Math.max(1e-4, minVal);
  const redCap = effectiveMin * Math.pow(1.1, 16);
  const logRange = Math.log(redCap / effectiveMin);

  // Draw Heatmap Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const cellW = width / nDep;
    const cellH = height / nArr;

    for (let i = 0; i < nDep; i++) {
      for (let j = 0; j < nArr; j++) {
        const isValid = porkchop.validMatrix[i]?.[j];

        if (!isValid) {
          ctx.fillStyle = '#0F172A'; // Dark background for invalid
          ctx.fillRect(i * cellW, (nArr - 1 - j) * cellH, cellW + 0.5, cellH + 0.5);
          continue;
        }

        let val = 0;
        if (viewMode === 'c3Dep') val = porkchop.c3DepMatrix[i][j];
        else if (viewMode === 'c3Arr') val = porkchop.c3ArrMatrix[i][j];
        else val = porkchop.dvMatrix[i][j];

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
        ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
        ctx.fillRect(i * cellW, (nArr - 1 - j) * cellH, cellW + 0.5, cellH + 0.5);
      }
    }
  }, [porkchop, viewMode, minVal, effectiveMin, redCap, logRange, nDep, nArr]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const i = Math.floor((x / rect.width) * nDep);
    const j = Math.floor((1 - y / rect.height) * nArr);

    if (i >= 0 && i < nDep && j >= 0 && j < nArr) {
      const depDate = porkchop.depDates[i];
      const arrDate = porkchop.arrDates[j];
      const flightTime = porkchop.flightTimeMatrix[i]?.[j] || (arrDate - depDate);
      const c3Dep = porkchop.c3DepMatrix[i]?.[j] || 0;
      const c3Arr = porkchop.c3ArrMatrix[i]?.[j] || 0;
      const isValid = porkchop.validMatrix[i]?.[j] || false;

      let val = 0;
      if (viewMode === 'c3Dep') val = c3Dep;
      else if (viewMode === 'c3Arr') val = c3Arr;
      else val = porkchop.dvMatrix[i]?.[j] || 0;

      setHoverData({
        depDate,
        arrDate,
        flightTime,
        val,
        c3Dep,
        c3Arr,
        isValid,
        xPct: (x / rect.width) * 100,
        yPct: (y / rect.height) * 100,
      });
    }
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
                    ? 'bg-[#38BDF8]/10 text-[#38BDF8] border-[#38BDF8]/30 cursor-wait animate-pulse'
                    : 'bg-[#25262B] hover:bg-[#334155] border-[#2D2E33] text-[#94A3B8] hover:text-white cursor-pointer'
                }`}
                title={isComputing ? `Computing... (${computedSamples}/${totalSamples} samples)` : 'Recompute this single transfer plot'}
              >
                <RefreshCw className={`w-3 h-3 ${isComputing ? 'animate-spin text-[#38BDF8]' : ''}`} />
                <span>
                  {isComputing
                    ? `Computing (${computedSamples}/${totalSamples})`
                    : 'Recompute'}
                </span>
              </button>
            ) : isComputing ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-[#38BDF8]/10 border border-[#38BDF8]/30 text-[#38BDF8] rounded text-[11px] font-mono animate-pulse">
                <RefreshCw className="w-3 h-3 animate-spin text-[#38BDF8]" />
                <span>Computing ({computedSamples}/${totalSamples})</span>
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

            <button onClick={onClose} className="p-1 hover:bg-[#25262B] rounded text-[#94A3B8] hover:text-white transition">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Porkchop Heatmap Canvas */}
        <div className="p-5 flex flex-col md:flex-row gap-5 overflow-y-auto">
          {/* Main Heatmap Canvas */}
          <div className="flex-1 flex flex-col items-center w-full">
            <div className="w-full max-w-[510px] flex gap-2 items-stretch">
              {/* Y-Axis Legend */}
              <div className="flex flex-col justify-between items-end text-[10px] text-[#94A3B8] font-mono py-0.5 select-none w-20 shrink-0">
                <span className="text-right truncate text-[10px]">{formatShortUT(porkchop.arrDates[nArr - 1], timeFormatMode)}</span>
                <div className="rotate-[-90deg] whitespace-nowrap uppercase font-serif text-[10px] tracking-wider text-[#60A5FA] my-auto">
                  Arrival Date ➔
                </div>
                <span className="text-right truncate text-[10px]">{formatShortUT(porkchop.arrDates[0], timeFormatMode)}</span>
              </div>

              {/* Canvas Container */}
              <div className="relative flex-1 aspect-square bg-[#0D0D0E] border border-[#2D2E33] rounded overflow-hidden shadow-inner group">
                <canvas
                  ref={canvasRef}
                  width={400}
                  height={400}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseLeave={() => setHoverData(null)}
                  className="w-full h-full cursor-crosshair"
                />

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
              <span>Dep: {formatShortUT(porkchop.depDates[0], timeFormatMode)}</span>
              <span className="uppercase font-serif text-[10px] tracking-wider text-[#60A5FA]">Departure Date ➔</span>
              <span>{formatShortUT(porkchop.depDates[nDep - 1], timeFormatMode)}</span>
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

            {/* Hover details inspector */}
            <div className="bg-[#25262B] p-3.5 rounded border border-[#2D2E33] text-xs flex-1 flex flex-col justify-between">
              <div>
                <span className="font-serif uppercase tracking-wider text-[11px] text-[#E2E8F0] flex items-center gap-1 mb-2">
                  <Crosshair className="w-3.5 h-3.5 text-[#60A5FA]" /> Hover Inspector
                </span>

                {hoverData ? (
                  <div className="space-y-1.5 font-mono text-[11px]">
                    <div className="flex justify-between">
                      <span className="text-[#94A3B8]">Dep Date:</span>
                      <strong className="text-[#60A5FA]">{formatShortUT(hoverData.depDate, timeFormatMode)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#94A3B8]">Arr Date:</span>
                      <strong className="text-[#60A5FA]">{formatShortUT(hoverData.arrDate, timeFormatMode)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#94A3B8]">Flight Duration:</span>
                      <strong className="text-[#60A5FA]">{formatDuration(hoverData.flightTime, timeFormatMode)}</strong>
                    </div>
                    <div className="pt-2 border-t border-[#2D2E33] flex justify-between">
                      <span className="text-[#94A3B8]">Dep C3:</span>
                      <strong className="text-[#E2E8F0]">{hoverData.c3Dep.toFixed(2)} km²/s²</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#94A3B8]">Arr C3:</span>
                      <strong className="text-[#E2E8F0]">{hoverData.c3Arr.toFixed(2)} km²/s²</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#94A3B8]">Feasibility:</span>
                      <span className={hoverData.isValid ? 'text-[#60A5FA] font-bold' : 'text-rose-400 font-bold'}>
                        {hoverData.isValid ? 'Valid' : 'Infeasible'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[#64748B] italic text-[11px] mt-2">
                    Hover your mouse over the porkchop heatmap to inspect exact dates and transfer energies.
                  </p>
                )}
              </div>

              <div className="mt-4 pt-2 border-t border-[#2D2E33] text-[10px] text-[#94A3B8]">
                Minimum energy transfer: <strong className="text-[#60A5FA] font-mono">{minVal.toFixed(2)} {viewMode === 'dvTotal' ? 'm/s' : 'km²/s²'}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
