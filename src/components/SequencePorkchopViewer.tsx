/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { SequencePorkchopData } from '../types';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import { X, Activity, Compass, Rocket, Calendar } from 'lucide-react';

interface SequencePorkchopViewerProps {
  seqPorkchop: SequencePorkchopData;
  timeFormatMode: 'ksp' | 'earth';
  onClose: () => void;
}

export type SeqViewTab = 'c3DepA' | 'c3ArrB' | 'c3DepB' | 'c3ArrC' | 'poweredDvB';

export const SequencePorkchopViewer: React.FC<SequencePorkchopViewerProps> = ({
  seqPorkchop,
  timeFormatMode,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<SeqViewTab>('poweredDvB');
  const [hoverData, setHoverData] = useState<{
    depDate: number;
    flybyDate: number;
    arrDate: number;
    flightTime: number;
    c3DepA: number;
    c3ArrB: number;
    c3DepB: number;
    c3ArrC: number;
    poweredDvB: number;
    isValid: boolean;
    xPct: number;
    yPct: number;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const nDep = seqPorkchop.depDates.length;
  const nArr = seqPorkchop.arrDates.length;

  const getMatrixForTab = (tab: SeqViewTab): number[][] => {
    switch (tab) {
      case 'c3DepA': return seqPorkchop.c3DepAMatrix;
      case 'c3ArrB': return seqPorkchop.c3ArrBMatrix;
      case 'c3DepB': return seqPorkchop.c3DepBMatrix;
      case 'c3ArrC': return seqPorkchop.c3ArrCMatrix;
      case 'poweredDvB': return seqPorkchop.poweredDvBMatrix;
    }
  };

  const currentMatrix = getMatrixForTab(activeTab);

  // Find min and max value for logarithmic scale mapping
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (let i = 0; i < nDep; i++) {
    for (let j = 0; j < nArr; j++) {
      if (seqPorkchop.validMatrix[i]?.[j]) {
        const val = currentMatrix[i]?.[j] ?? 0;
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }
    }
  }

  if (minVal === Infinity) {
    minVal = 0;
    maxVal = 100;
  }

  const effectiveMin = Math.max(activeTab === 'poweredDvB' ? 1.0 : 1e-4, minVal);
  const redCap = activeTab === 'poweredDvB' ? Math.max(effectiveMin + 100, effectiveMin * 5) : effectiveMin * Math.pow(1.1, 16);
  const logRange = Math.log(Math.max(1.001, redCap / effectiveMin));

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
        const isValid = seqPorkchop.validMatrix[i]?.[j];

        if (!isValid) {
          ctx.fillStyle = '#0F172A'; // Dark slate for invalid
          ctx.fillRect(i * cellW, (nArr - 1 - j) * cellH, cellW + 0.5, cellH + 0.5);
          continue;
        }

        const val = currentMatrix[i]?.[j] ?? 0;

        let norm = 0;
        if (activeTab === 'poweredDvB') {
          // Linear / soft scale for powered dV
          const dvRange = Math.max(1, maxVal - minVal);
          norm = Math.min(1, Math.max(0, (val - minVal) / dvRange));
        } else {
          // Logarithmic scale for C3
          if (val <= effectiveMin) {
            norm = 0;
          } else if (val >= redCap) {
            norm = 1;
          } else if (logRange > 0) {
            norm = Math.log(val / effectiveMin) / logRange;
          }
          norm = Math.max(0, Math.min(1, norm));
        }

        // HSL Color gradient: Blue (240) -> Cyan (180) -> Green (120) -> Yellow (60) -> Red (0)
        const hue = (1 - norm) * 240;
        ctx.fillStyle = `hsl(${hue}, 85%, 50%)`;
        ctx.fillRect(i * cellW, (nArr - 1 - j) * cellH, cellW + 0.5, cellH + 0.5);
      }
    }
  }, [seqPorkchop, activeTab, currentMatrix, minVal, maxVal, effectiveMin, redCap, logRange, nDep, nArr]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const i = Math.floor((x / rect.width) * nDep);
    const j = Math.floor((1 - y / rect.height) * nArr);

    if (i >= 0 && i < nDep && j >= 0 && j < nArr) {
      const depDate = seqPorkchop.depDates[i];
      const arrDate = seqPorkchop.arrDates[j];
      const flybyDate = seqPorkchop.flybyDateMatrix[i]?.[j] || (depDate + arrDate) / 2;
      const flightTime = seqPorkchop.flightTimeMatrix[i]?.[j] || (arrDate - depDate);
      const c3DepA = seqPorkchop.c3DepAMatrix[i]?.[j] || 0;
      const c3ArrB = seqPorkchop.c3ArrBMatrix[i]?.[j] || 0;
      const c3DepB = seqPorkchop.c3DepBMatrix[i]?.[j] || 0;
      const c3ArrC = seqPorkchop.c3ArrCMatrix[i]?.[j] || 0;
      const poweredDvB = seqPorkchop.poweredDvBMatrix[i]?.[j] || 0;
      const isValid = seqPorkchop.validMatrix[i]?.[j] || false;

      setHoverData({
        depDate,
        flybyDate,
        arrDate,
        flightTime,
        c3DepA,
        c3ArrB,
        c3DepB,
        c3ArrC,
        poweredDvB,
        isValid,
        xPct: (x / rect.width) * 100,
        yPct: (y / rect.height) * 100,
      });
    }
  };

  const tabs: { key: SeqViewTab; label: string; desc: string; unit: string }[] = [
    {
      key: 'c3DepA',
      label: `Dep C3 (${seqPorkchop.sourceBody})`,
      desc: `Departure C3 from ${seqPorkchop.sourceBody}`,
      unit: 'km²/s²',
    },
    {
      key: 'c3ArrB',
      label: `Arr C3 (${seqPorkchop.flybyBody})`,
      desc: `Inbound arrival C3 at ${seqPorkchop.flybyBody}`,
      unit: 'km²/s²',
    },
    {
      key: 'c3DepB',
      label: `Dep C3 (${seqPorkchop.flybyBody})`,
      desc: `Outbound departure C3 from ${seqPorkchop.flybyBody}`,
      unit: 'km²/s²',
    },
    {
      key: 'c3ArrC',
      label: `Arr C3 (${seqPorkchop.targetBody})`,
      desc: `Arrival C3 at ${seqPorkchop.targetBody}`,
      unit: 'km²/s²',
    },
    {
      key: 'poweredDvB',
      label: `Powered Flyby Δv (${seqPorkchop.flybyBody})`,
      desc: `Minimum powered flyby maneuver at ${seqPorkchop.flybyBody}`,
      unit: 'm/s',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#18181B] border border-[#27272A] rounded-xl shadow-2xl max-w-4xl w-full flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#27272A] bg-[#09090B]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[#2563EB]/20 text-[#60A5FA]">
              <Compass className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                3-Instance Sequence Porkchop Plot
              </h2>
              <p className="text-xs text-[#A1A1AA]">
                <span className="text-[#60A5FA] font-semibold">{seqPorkchop.sequenceLabel}</span>
                {' · '}Departure: {seqPorkchop.sourceBody} | Flyby: {seqPorkchop.flybyBody} | Arrival: {seqPorkchop.targetBody}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#A1A1AA] hover:text-white hover:bg-[#27272A] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 5 View Mode Tabs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 bg-[#09090B] border-b border-[#27272A] p-2 gap-1.5">
          {tabs.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex flex-col items-center px-2 py-2 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-[#2563EB] text-white shadow-md font-semibold'
                    : 'text-[#A1A1AA] hover:text-white hover:bg-[#18181B]'
                }`}
                title={tab.desc}
              >
                <span className="truncate w-full text-center">{tab.label}</span>
                <span className={`text-[10px] mt-0.5 ${isActive ? 'text-blue-200' : 'text-[#71717A]'}`}>
                  {tab.unit}
                </span>
              </button>
            );
          })}
        </div>

        {/* Heatmap Section */}
        <div className="flex-1 p-4 flex flex-col gap-4 overflow-y-auto">
          <div className="relative flex flex-col items-center justify-center bg-[#09090B] p-4 rounded-lg border border-[#27272A]">
            
            {/* Axis Label Top */}
            <div className="text-xs text-[#A1A1AA] mb-2 font-mono flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 text-[#38BDF8]" />
              Arrival Date at <span className="text-white font-semibold">{seqPorkchop.targetBody}</span> (Y-Axis) vs Departure Date at <span className="text-white font-semibold">{seqPorkchop.sourceBody}</span> (X-Axis)
            </div>

            {/* Canvas Container */}
            <div className="relative w-full max-w-2xl aspect-square">
              <canvas
                ref={canvasRef}
                width={500}
                height={500}
                onMouseMove={handleCanvasMouseMove}
                onMouseLeave={() => setHoverData(null)}
                className="w-full h-full rounded border border-[#27272A] cursor-crosshair"
              />

              {/* Hover Crosshair Overlay */}
              {hoverData && (
                <>
                  <div
                    className="absolute top-0 bottom-0 border-l border-dashed border-white/60 pointer-events-none"
                    style={{ left: `${hoverData.xPct}%` }}
                  />
                  <div
                    className="absolute left-0 right-0 border-t border-dashed border-white/60 pointer-events-none"
                    style={{ top: `${hoverData.yPct}%` }}
                  />
                </>
              )}
            </div>

            {/* X-Axis Date Range Display */}
            <div className="w-full max-w-2xl flex justify-between text-[11px] text-[#A1A1AA] mt-2 font-mono">
              <span>Dep Min: {formatShortUT(seqPorkchop.depDates[0], timeFormatMode)}</span>
              <span className="text-center text-[#38BDF8]">Departure Date ({seqPorkchop.sourceBody})</span>
              <span>Dep Max: {formatShortUT(seqPorkchop.depDates[nDep - 1], timeFormatMode)}</span>
            </div>
          </div>

          {/* Interactive Inspection Card */}
          {hoverData && (
            <div className="bg-[#09090B] border border-[#27272A] rounded-lg p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
              <div>
                <span className="text-[#71717A] block">Dep Date ({seqPorkchop.sourceBody}):</span>
                <span className="text-white font-semibold">{formatShortUT(hoverData.depDate, timeFormatMode)}</span>
              </div>
              <div>
                <span className="text-[#71717A] block">Flyby Date ({seqPorkchop.flybyBody}):</span>
                <span className="text-[#38BDF8] font-semibold">{formatShortUT(hoverData.flybyDate, timeFormatMode)}</span>
              </div>
              <div>
                <span className="text-[#71717A] block">Arr Date ({seqPorkchop.targetBody}):</span>
                <span className="text-white font-semibold">{formatShortUT(hoverData.arrDate, timeFormatMode)}</span>
              </div>
              <div>
                <span className="text-[#71717A] block">Total Flight Time:</span>
                <span className="text-white font-semibold">{formatDuration(hoverData.flightTime, timeFormatMode)}</span>
              </div>

              <div className="border-t border-[#27272A] pt-2 col-span-2 sm:col-span-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
                <div className={activeTab === 'c3DepA' ? 'text-[#38BDF8] font-bold' : ''}>
                  <span className="text-[#71717A] block text-[10px]">Dep C3 ({seqPorkchop.sourceBody})</span>
                  <span>{hoverData.isValid ? `${hoverData.c3DepA.toFixed(2)} km²/s²` : 'N/A'}</span>
                </div>
                <div className={activeTab === 'c3ArrB' ? 'text-[#38BDF8] font-bold' : ''}>
                  <span className="text-[#71717A] block text-[10px]">Arr C3 ({seqPorkchop.flybyBody})</span>
                  <span>{hoverData.isValid ? `${hoverData.c3ArrB.toFixed(2)} km²/s²` : 'N/A'}</span>
                </div>
                <div className={activeTab === 'c3DepB' ? 'text-[#38BDF8] font-bold' : ''}>
                  <span className="text-[#71717A] block text-[10px]">Dep C3 ({seqPorkchop.flybyBody})</span>
                  <span>{hoverData.isValid ? `${hoverData.c3DepB.toFixed(2)} km²/s²` : 'N/A'}</span>
                </div>
                <div className={activeTab === 'c3ArrC' ? 'text-[#38BDF8] font-bold' : ''}>
                  <span className="text-[#71717A] block text-[10px]">Arr C3 ({seqPorkchop.targetBody})</span>
                  <span>{hoverData.isValid ? `${hoverData.c3ArrC.toFixed(2)} km²/s²` : 'N/A'}</span>
                </div>
                <div className={activeTab === 'poweredDvB' ? 'text-[#38BDF8] font-bold' : ''}>
                  <span className="text-[#71717A] block text-[10px]">Powered Δv ({seqPorkchop.flybyBody})</span>
                  <span>{hoverData.isValid ? `${hoverData.poweredDvB.toFixed(1)} m/s` : 'N/A'}</span>
                </div>
              </div>
            </div>
          )}

          {/* Color Scale Legend */}
          <div className="flex items-center justify-between text-xs text-[#A1A1AA] bg-[#09090B] p-2.5 rounded-lg border border-[#27272A]">
            <span className="font-semibold text-blue-400">Low Cost / Optimal ({minVal.toFixed(1)} {tabs.find(t=>t.key===activeTab)?.unit})</span>
            <div className="flex-1 mx-4 h-2.5 rounded bg-gradient-to-r from-blue-600 via-green-500 via-yellow-400 to-red-600 border border-[#27272A]" />
            <span className="font-semibold text-red-400">High Cost / Suboptimal</span>
          </div>
        </div>

      </div>
    </div>
  );
};
