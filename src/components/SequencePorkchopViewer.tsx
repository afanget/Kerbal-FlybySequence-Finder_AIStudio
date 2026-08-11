/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { SequencePorkchopData } from '../types';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import { X, Compass, Calendar, RefreshCw } from 'lucide-react';

interface SequencePorkchopViewerProps {
  seqPorkchop: SequencePorkchopData;
  timeFormatMode: 'ksp' | 'earth';
  onClose: () => void;
  onRecomputePorkchop?: () => void;
  isComputing?: boolean;
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
}) => {
  const bodyNames = seqPorkchop.bodyNames && seqPorkchop.bodyNames.length > 0
    ? seqPorkchop.bodyNames
    : seqPorkchop.sequenceLabel.split(/➔|->|→/).map(s => s.trim()).filter(Boolean);

  const instanceCount = seqPorkchop.instanceCount || bodyNames.length || (seqPorkchop.is4Body ? 4 : 3);
  const srcBodyName = bodyNames[0] || seqPorkchop.sourceBody;
  const tgtBodyName = bodyNames[bodyNames.length - 1] || seqPorkchop.targetBody;
  const flybyBodyNames = bodyNames.slice(1, -1);

  const [activeTab, setActiveTab] = useState<SeqViewTab>(
    instanceCount >= 4 ? 'totalPoweredDv' : 'poweredDvB'
  );

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
    xPct: number;
    yPct: number;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const nDep = seqPorkchop.depDates ? seqPorkchop.depDates.length : 0;
  const nArr = seqPorkchop.arrDates ? seqPorkchop.arrDates.length : 0;

  const getMatrixForTab = (tab: SeqViewTab): number[][] => {
    if (tab === 'totalPoweredDv') return seqPorkchop.totalPoweredDvMatrix || seqPorkchop.poweredDvBMatrix;
    if (tab === 'c3DepA') return seqPorkchop.c3DepAMatrix;
    if (tab === 'c3ArrFinal' || tab === 'c3ArrD') return seqPorkchop.c3ArrFinalMatrix || seqPorkchop.c3ArrDMatrix || seqPorkchop.c3ArrCMatrix;
    if (tab === 'c3ArrB') return seqPorkchop.c3ArrBMatrix;
    if (tab === 'c3DepB') return seqPorkchop.c3DepBMatrix;
    if (tab === 'c3ArrC') return seqPorkchop.c3ArrCMatrix;
    if (tab === 'poweredDvB') return seqPorkchop.poweredDvBMatrix;
    if (tab === 'poweredDvC') return seqPorkchop.poweredDvCMatrix || seqPorkchop.poweredDvBMatrix;

    if (tab.startsWith('flybyDv_')) {
      const idx = parseInt(tab.replace('flybyDv_', ''), 10);
      if (seqPorkchop.flybyPoweredDvs?.[idx]) {
        return seqPorkchop.flybyPoweredDvs[idx].poweredDvMatrix;
      }
    }
    return seqPorkchop.totalPoweredDvMatrix || seqPorkchop.poweredDvBMatrix;
  };

  const currentMatrix = getMatrixForTab(activeTab);

  // Collect valid values for current matrix
  const validValues: number[] = [];
  if (currentMatrix && nDep > 0 && nArr > 0) {
    for (let i = 0; i < nDep; i++) {
      for (let j = 0; j < nArr; j++) {
        if (seqPorkchop.validMatrix?.[i]?.[j]) {
          const val = currentMatrix[i]?.[j];
          if (val !== undefined && isFinite(val)) {
            validValues.push(val);
          }
        }
      }
    }
  }

  validValues.sort((a, b) => a - b);

  const minVal = validValues.length > 0 ? validValues[0] : 0;
  const maxVal = validValues.length > 0 ? validValues[validValues.length - 1] : 100;

  // 2nd decile (20th percentile)
  let decile2 = minVal;
  if (validValues.length > 0) {
    const idx20 = Math.min(validValues.length - 1, Math.floor(0.20 * validValues.length));
    decile2 = validValues[idx20];
  }

  const effectiveMin = Math.max(10, minVal);
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

    const cellW = width / nDep;
    const cellH = height / nArr;

    for (let i = 0; i < nDep; i++) {
      for (let j = 0; j < nArr; j++) {
        const isValid = seqPorkchop.validMatrix[i]?.[j];

        if (!isValid) {
          ctx.fillStyle = '#0F172A';
          ctx.fillRect(i * cellW, (nArr - 1 - j) * cellH, cellW + 0.5, cellH + 0.5);
          continue;
        }

        const val = currentMatrix[i]?.[j] ?? 0;

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
      const flightTime = seqPorkchop.flightTimeMatrix[i]?.[j] || (arrDate - depDate);
      const c3DepA = seqPorkchop.c3DepAMatrix[i]?.[j] || 0;
      const c3ArrFinal = seqPorkchop.c3ArrFinalMatrix?.[i]?.[j] ?? seqPorkchop.c3ArrDMatrix?.[i]?.[j] ?? seqPorkchop.c3ArrCMatrix[i]?.[j] ?? 0;
      const totalPoweredDv = seqPorkchop.totalPoweredDvMatrix?.[i]?.[j] ?? seqPorkchop.poweredDvBMatrix[i]?.[j] ?? 0;
      const isValid = seqPorkchop.validMatrix[i]?.[j] || false;

      const flybyDatesList: { body: string; date: number }[] = [];
      if (seqPorkchop.flybyDates && seqPorkchop.flybyDates.length > 0) {
        seqPorkchop.flybyDates.forEach(f => {
          flybyDatesList.push({
            body: f.flybyBody,
            date: f.dateMatrix[i]?.[j] || (depDate + arrDate) / 2,
          });
        });
      } else {
        if (seqPorkchop.flybyBody) {
          flybyDatesList.push({
            body: seqPorkchop.flybyBody,
            date: seqPorkchop.flybyDateMatrix[i]?.[j] || (depDate + arrDate) / 2,
          });
        }
        if (seqPorkchop.flyby2Body) {
          flybyDatesList.push({
            body: seqPorkchop.flyby2Body,
            date: seqPorkchop.flyby2DateMatrix?.[i]?.[j] || (depDate + arrDate) / 2,
          });
        }
      }

      const flybyDvsList: { body: string; dv: number }[] = [];
      if (seqPorkchop.flybyPoweredDvs && seqPorkchop.flybyPoweredDvs.length > 0) {
        seqPorkchop.flybyPoweredDvs.forEach(f => {
          flybyDvsList.push({
            body: f.flybyBody,
            dv: f.poweredDvMatrix[i]?.[j] || 0,
          });
        });
      } else {
        if (seqPorkchop.flybyBody) {
          flybyDvsList.push({
            body: seqPorkchop.flybyBody,
            dv: seqPorkchop.poweredDvBMatrix[i]?.[j] || 0,
          });
        }
        if (seqPorkchop.flyby2Body) {
          flybyDvsList.push({
            body: seqPorkchop.flyby2Body,
            dv: seqPorkchop.poweredDvCMatrix?.[i]?.[j] || 0,
          });
        }
      }

      setHoverData({
        depDate,
        flybyDates: flybyDatesList,
        arrDate,
        flightTime,
        c3DepA,
        c3ArrFinal,
        flybyDvs: flybyDvsList,
        totalPoweredDv,
        isValid,
        xPct: (x / rect.width) * 100,
        yPct: (y / rect.height) * 100,
      });
    }
  };

  // Generate view tabs based on path length
  const tabs: { key: SeqViewTab; label: string; desc: string; unit: string }[] = [];

  if (instanceCount === 3) {
    tabs.push(
      {
        key: 'poweredDvB',
        label: `Powered Δv (${flybyBodyNames[0] || seqPorkchop.flybyBody})`,
        desc: `Powered flyby maneuver at ${flybyBodyNames[0] || seqPorkchop.flybyBody}`,
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
        label: `Arr C3 (${flybyBodyNames[0] || seqPorkchop.flybyBody})`,
        desc: `Inbound arrival C3 at ${flybyBodyNames[0] || seqPorkchop.flybyBody}`,
        unit: 'km²/s²',
      },
      {
        key: 'c3DepB',
        label: `Dep C3 (${flybyBodyNames[0] || seqPorkchop.flybyBody})`,
        desc: `Outbound departure C3 from ${flybyBodyNames[0] || seqPorkchop.flybyBody}`,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4">
      <div className="bg-[#18181B] border border-[#27272A] rounded-xl shadow-2xl max-w-3xl w-full flex flex-col max-h-[96vh] overflow-hidden">
        
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
              </h2>
              <p className="text-[11px] text-[#A1A1AA]">
                <span className="text-[#60A5FA] font-semibold">{seqPorkchop.sequenceLabel}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onRecomputePorkchop && (
              <button
                onClick={onRecomputePorkchop}
                disabled={isComputing}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-white transition-all shadow"
                title="Recompute this specific sequence porkchop plot directly"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isComputing ? 'animate-spin' : ''}`} />
                {isComputing ? 'Computing...' : 'Recompute Porkchop'}
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
        <div className="p-3 flex flex-col gap-2 overflow-y-auto">
          <div className="bg-[#09090B] p-2.5 rounded-lg border border-[#27272A] flex flex-col items-center">
            
            {/* Top Title */}
            <div className="text-[11px] text-[#A1A1AA] mb-2 font-mono flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-[#38BDF8]" />
              Arrival at <span className="text-white font-semibold">{tgtBodyName}</span> vs Departure at <span className="text-white font-semibold">{srcBodyName}</span>
            </div>

            {/* Canvas Row with Left Y-Axis Legend */}
            <div className="flex items-center gap-3 w-full justify-center">
              
              {/* Left Y-Axis Legend Column */}
              <div className="flex flex-col justify-between items-end h-[280px] sm:h-[310px] text-[10px] text-[#A1A1AA] font-mono py-1 select-none pr-1 border-r border-[#27272A]">
                <span className="text-[#38BDF8] font-semibold text-right">
                  Arr Max:<br />{nArr > 0 ? formatShortUT(seqPorkchop.arrDates[nArr - 1], timeFormatMode) : '--'}
                </span>
                
                <div className="rotate-[-90deg] whitespace-nowrap text-[10px] tracking-wider text-slate-300 font-bold uppercase my-auto transform origin-center">
                  Arrival at {tgtBodyName} (Y-Axis)
                </div>

                <span className="text-[#38BDF8] font-semibold text-right">
                  Arr Min:<br />{nArr > 0 ? formatShortUT(seqPorkchop.arrDates[0], timeFormatMode) : '--'}
                </span>
              </div>

              {/* Heatmap Canvas Box */}
              <div className="relative w-[280px] sm:w-[310px] aspect-square flex-shrink-0">
                <canvas
                  ref={canvasRef}
                  width={400}
                  height={400}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseLeave={() => setHoverData(null)}
                  className="w-full h-full rounded border border-[#27272A] cursor-crosshair"
                />

                {/* Computing Live Indicator Overlay */}
                {isComputing && nDep > 0 && nArr > 0 && (
                  <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2.5 py-1 rounded bg-black/80 border border-blue-500/50 text-[10px] font-mono text-blue-400 backdrop-blur-sm shadow-md animate-pulse">
                    <RefreshCw className="w-3 h-3 animate-spin text-blue-400" />
                    <span>Computing live...</span>
                  </div>
                )}

                {/* Empty / Initial Loading Overlay */}
                {(nDep === 0 || nArr === 0) && (
                  <div className="absolute inset-0 bg-[#09090B]/90 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center rounded border border-[#27272A]">
                    <RefreshCw className="w-8 h-8 text-[#38BDF8] animate-spin mb-2" />
                    <span className="text-xs font-mono font-bold text-white">Computing sequence porkchop plot...</span>
                    <span className="text-[10px] font-mono text-[#94A3B8] mt-1">Evaluating multi-body trajectories and flybys...</span>
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
            <div className="w-full max-w-[380px] sm:max-w-[420px] flex items-center justify-between text-[10px] text-[#A1A1AA] font-mono mt-2 pt-1 border-t border-[#27272A]">
              <span>Dep Min: <strong className="text-[#38BDF8]">{nDep > 0 ? formatShortUT(seqPorkchop.depDates[0], timeFormatMode) : '--'}</strong></span>
              <span className="text-slate-300 font-bold uppercase tracking-wider text-[10px]">
                Departure at {srcBodyName} (X-Axis)
              </span>
              <span>Dep Max: <strong className="text-[#38BDF8]">{nDep > 0 ? formatShortUT(seqPorkchop.depDates[nDep - 1], timeFormatMode) : '--'}</strong></span>
            </div>
          </div>

          {/* Color Scale Bar */}
          <div className="flex items-center justify-between text-[10px] text-[#A1A1AA] bg-[#09090B] p-2 rounded-lg border border-[#27272A]">
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-[#27272A] pt-1.5 mt-1.5 text-[10px]">
              <div>
                <span className="text-[#71717A] block text-[9px]">Dep C3 ({srcBodyName}):</span>
                <span className={activeTab === 'c3DepA' ? 'text-[#38BDF8] font-bold' : 'text-slate-200'}>
                  {hoverData && hoverData.isValid ? `${hoverData.c3DepA.toFixed(1)} km²/s²` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Arr C3 ({tgtBodyName}):</span>
                <span className={activeTab === 'c3ArrFinal' || activeTab === 'c3ArrD' || activeTab === 'c3ArrC' ? 'text-[#38BDF8] font-bold' : 'text-slate-200'}>
                  {hoverData && hoverData.isValid ? `${hoverData.c3ArrFinal.toFixed(1)} km²/s²` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Flyby Powered Δv:</span>
                <span className={activeTab.includes('powered') || activeTab.includes('flyby') ? 'text-[#38BDF8] font-bold' : 'text-slate-200'}>
                  {hoverData && hoverData.isValid
                    ? hoverData.flybyDvs.map(f => `${f.body}: ${f.dv.toFixed(1)} m/s`).join(', ') || `${hoverData.totalPoweredDv.toFixed(1)} m/s`
                    : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9px]">Total Powered Δv:</span>
                <span className={activeTab === 'totalPoweredDv' ? 'text-[#38BDF8] font-bold' : 'text-emerald-400 font-semibold'}>
                  {hoverData && hoverData.isValid ? `${hoverData.totalPoweredDv.toFixed(1)} m/s` : '--'}
                </span>
              </div>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
};
