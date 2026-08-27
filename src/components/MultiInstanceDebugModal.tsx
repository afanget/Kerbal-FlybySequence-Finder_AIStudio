/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import {
  MultiInstanceDebugData,
  MultiInstanceFlybyRow,
  HigherOrderAlgorithmInfo,
  PivotCandidateSample,
  extractMultiInstanceDebugData,
  evaluateMultiInstanceForDates,
  extractHigherOrderAlgorithmInfo,
  optimizeFlybyDateDichotomic,
  optimizeAllFlybyDates,
  getFlybyDateSampleStep,
} from '../utils/multiInstanceDebug';
import { FlybyDebugPlotData } from '../utils/flybyDebugPlot';
import { FlybyDebugPlotModal } from './FlybyDebugPlotModal';
import {
  SequencePorkchopData,
  PorkchopPlotData,
  DirectionalLink,
  CelestialBody,
  OrbitalBody,
  InstanceNode,
} from '../types';
import {
  formatShortUT,
  formatUT,
  formatDuration,
  utToYearDay,
  parseKSPTimeToUT,
  parseDateStringToUT,
} from '../utils/timeFormat';
import {
  X,
  Compass,
  Layers,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronUp,
  Zap,
  ArrowRight,
  ExternalLink,
  Info,
  Calendar,
  Clock,
  Rocket,
  RotateCcw,
  Sparkles,
  GitBranch,
  Filter,
  CheckCircle2,
  AlertCircle,
  Search,
  Check,
  Edit3,
  SlidersHorizontal,
  Hash,
} from 'lucide-react';
import { vecMag } from '../physics/kepler';

interface MultiInstanceDebugModalProps {
  initialData: MultiInstanceDebugData;
  seqPorkchop: SequencePorkchopData;
  porkchops?: Record<string, PorkchopPlotData>;
  links?: DirectionalLink[];
  bodies: OrbitalBody[];
  mainBody: CelestialBody;
  sequencePorkchops: Record<string, SequencePorkchopData>;
  timeFormatMode: 'ksp' | 'earth';
  onClose: () => void;
  onRecomputePoint?: (depIndex: number, arrIndex: number) => void;
}

// ---------------------------------------------------------------------------
// Single Date Edit Modal Component
// ---------------------------------------------------------------------------
interface SingleDateEditModalProps {
  index: number;
  bodyName: string;
  role: 'departure' | 'flyby' | 'arrival';
  currentDate: number;
  minAllowedDate?: number;
  maxAllowedDate?: number;
  timeFormatMode: 'ksp' | 'earth';
  onApply: (newDate: number) => void;
  onClose: () => void;
}

const SingleDateEditModal: React.FC<SingleDateEditModalProps> = ({
  index,
  bodyName,
  role,
  currentDate,
  minAllowedDate,
  maxAllowedDate,
  timeFormatMode,
  onApply,
  onClose,
}) => {
  const initialCal = utToYearDay(currentDate, timeFormatMode);
  const [yearInput, setYearInput] = useState<number>(initialCal.year);
  const [dayInput, setDayInput] = useState<number>(initialCal.day);
  const [utInputStr, setUtInputStr] = useState<string>(Math.round(currentDate).toString());
  const [textInputStr, setTextInputStr] = useState<string>(formatShortUT(currentDate, timeFormatMode));
  const [inputMode, setInputMode] = useState<'calendar' | 'ut' | 'text'>('calendar');

  const daySec = timeFormatMode === 'ksp' ? 21600 : 86400;

  // Calculate the live preview date based on active input
  const previewDate = useMemo(() => {
    if (inputMode === 'calendar') {
      return parseKSPTimeToUT(yearInput, dayInput, 0, 0, 0, timeFormatMode);
    } else if (inputMode === 'ut') {
      const parsed = parseFloat(utInputStr);
      return !isNaN(parsed) ? parsed : currentDate;
    } else {
      const parsed = parseDateStringToUT(textInputStr, timeFormatMode);
      return parsed !== null ? parsed : currentDate;
    }
  }, [inputMode, yearInput, dayInput, utInputStr, textInputStr, timeFormatMode, currentDate]);

  const isValidRange = useMemo(() => {
    if (minAllowedDate !== undefined && previewDate < minAllowedDate) return false;
    if (maxAllowedDate !== undefined && previewDate > maxAllowedDate) return false;
    return true;
  }, [previewDate, minAllowedDate, maxAllowedDate]);

  const handleStepDays = (deltaDays: number) => {
    const newUT = Math.max(0, previewDate + deltaDays * daySec);
    const newCal = utToYearDay(newUT, timeFormatMode);
    setYearInput(newCal.year);
    setDayInput(newCal.day);
    setUtInputStr(Math.round(newUT).toString());
    setTextInputStr(formatShortUT(newUT, timeFormatMode));
  };

  const handleApply = () => {
    if (previewDate !== null && Number.isFinite(previewDate) && previewDate >= 0) {
      onApply(previewDate);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-[#18181B] border border-[#3F3F46] rounded-xl shadow-2xl max-w-md w-full p-5 flex flex-col gap-4 text-xs font-sans">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#27272A]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/30">
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-white text-sm flex items-center gap-1.5">
                <span>Set Date: {bodyName}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 font-normal uppercase">
                  {role}
                </span>
              </h3>
              <p className="text-[11px] text-[#71717A]">Enter any date (including non-sampled values) to solve Lambert transfer</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[#A1A1AA] hover:text-white hover:bg-[#27272A] rounded transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Current & Target Preview */}
        <div className="bg-[#09090B] border border-[#27272A] rounded-lg p-3 flex flex-col gap-1 text-xs">
          <div className="flex items-center justify-between text-[#A1A1AA]">
            <span>Current Date:</span>
            <span className="font-mono text-zinc-300 font-semibold">{formatUT(currentDate, timeFormatMode)}</span>
          </div>
          <div className="flex items-center justify-between text-purple-300 font-semibold">
            <span>New Custom Date:</span>
            <span className="font-mono text-white text-sm bg-purple-950/60 px-2 py-0.5 rounded border border-purple-500/40">
              {formatUT(previewDate, timeFormatMode)}
            </span>
          </div>
        </div>

        {/* Mode Selector */}
        <div className="flex items-center rounded bg-[#09090B] p-1 border border-[#27272A] gap-1">
          <button
            type="button"
            onClick={() => {
              setInputMode('calendar');
              const cal = utToYearDay(previewDate, timeFormatMode);
              setYearInput(cal.year);
              setDayInput(cal.day);
            }}
            className={`flex-1 py-1 text-center rounded text-[11px] font-medium transition cursor-pointer ${
              inputMode === 'calendar' ? 'bg-purple-600 text-white font-semibold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            Year & Day
          </button>
          <button
            type="button"
            onClick={() => {
              setInputMode('ut');
              setUtInputStr(Math.round(previewDate).toString());
            }}
            className={`flex-1 py-1 text-center rounded text-[11px] font-medium transition cursor-pointer ${
              inputMode === 'ut' ? 'bg-purple-600 text-white font-semibold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            Exact UT (s)
          </button>
          <button
            type="button"
            onClick={() => {
              setInputMode('text');
              setTextInputStr(formatShortUT(previewDate, timeFormatMode));
            }}
            className={`flex-1 py-1 text-center rounded text-[11px] font-medium transition cursor-pointer ${
              inputMode === 'text' ? 'bg-purple-600 text-white font-semibold' : 'text-[#A1A1AA] hover:text-white'
            }`}
          >
            Date String
          </button>
        </div>

        {/* Inputs */}
        {inputMode === 'calendar' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-[#A1A1AA]">Year</label>
              <input
                type="number"
                min="1"
                value={yearInput}
                onChange={e => setYearInput(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="bg-[#09090B] border border-[#3F3F46] focus:border-purple-500 rounded px-3 py-1.5 text-white font-mono text-sm outline-none"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-[#A1A1AA]">Day</label>
              <input
                type="number"
                min="1"
                step="0.1"
                value={dayInput}
                onChange={e => setDayInput(Math.max(1, parseFloat(e.target.value) || 1))}
                className="bg-[#09090B] border border-[#3F3F46] focus:border-purple-500 rounded px-3 py-1.5 text-white font-mono text-sm outline-none"
              />
            </div>
          </div>
        )}

        {inputMode === 'ut' && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-[#A1A1AA]">Universal Time (Seconds)</label>
            <input
              type="text"
              value={utInputStr}
              onChange={e => setUtInputStr(e.target.value)}
              placeholder="e.g. 2160000"
              className="bg-[#09090B] border border-[#3F3F46] focus:border-purple-500 rounded px-3 py-1.5 text-white font-mono text-sm outline-none"
            />
          </div>
        )}

        {inputMode === 'text' && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold text-[#A1A1AA]">Date String (e.g. Y1 D205 or 150d)</label>
            <input
              type="text"
              value={textInputStr}
              onChange={e => setTextInputStr(e.target.value)}
              placeholder="e.g. Y1 D205"
              className="bg-[#09090B] border border-[#3F3F46] focus:border-purple-500 rounded px-3 py-1.5 text-white font-mono text-sm outline-none"
            />
          </div>
        )}

        {/* Quick Day Steppers */}
        <div className="flex items-center justify-between gap-1.5">
          <span className="text-[11px] text-[#71717A] font-semibold">Quick Step:</span>
          <div className="flex items-center gap-1">
            {[-100, -10, -1, 1, 10, 100].map(d => (
              <button
                key={d}
                type="button"
                onClick={() => handleStepDays(d)}
                className="px-1.5 py-0.5 rounded bg-[#27272A] hover:bg-purple-600/40 text-slate-300 hover:text-white font-mono text-[10px] transition cursor-pointer border border-[#3F3F46]"
              >
                {d > 0 ? `+${d}d` : `${d}d`}
              </button>
            ))}
          </div>
        </div>

        {/* Chronological Bounds Info */}
        {(minAllowedDate !== undefined || maxAllowedDate !== undefined) && (
          <div className="text-[10px] text-[#71717A] flex items-center justify-between">
            <span>
              {minAllowedDate !== undefined && `Min: ${formatShortUT(minAllowedDate, timeFormatMode)}`}
            </span>
            <span>
              {maxAllowedDate !== undefined && `Max: ${formatShortUT(maxAllowedDate, timeFormatMode)}`}
            </span>
          </div>
        )}

        {!isValidRange && (
          <div className="bg-amber-950/40 border border-amber-500/40 rounded p-2 text-amber-300 text-[11px] flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>Warning: Date is outside the standard chronological window between neighbor bodies.</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#27272A]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-[#27272A] hover:bg-[#3F3F46] text-slate-300 text-xs font-semibold transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition cursor-pointer flex items-center gap-1.5 shadow-lg shadow-purple-900/30"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply & Recalculate</span>
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sequence Dates Manager Modal Component
// ---------------------------------------------------------------------------
interface SequenceDatesManagerModalProps {
  pathInsts: InstanceNode[];
  customDates: number[];
  timeFormatMode: 'ksp' | 'earth';
  onApplyAll: (newDates: number[]) => void;
  onOptimizeAll: () => void;
  onReset: () => void;
  onClose: () => void;
}

const SequenceDatesManagerModal: React.FC<SequenceDatesManagerModalProps> = ({
  pathInsts,
  customDates,
  timeFormatMode,
  onApplyAll,
  onOptimizeAll,
  onReset,
  onClose,
}) => {
  const [datesState, setDatesState] = useState<number[]>([...customDates]);
  const daySec = timeFormatMode === 'ksp' ? 21600 : 86400;

  const handleDateChange = (idx: number, newUT: number) => {
    const updated = [...datesState];
    updated[idx] = Math.max(0, newUT);
    setDatesState(updated);
  };

  const handleYearDayChange = (idx: number, year: number, day: number) => {
    const ut = parseKSPTimeToUT(year, day, 0, 0, 0, timeFormatMode);
    handleDateChange(idx, ut);
  };

  const handleEvenlySpaceFlybys = () => {
    const N = datesState.length;
    if (N <= 2) return;
    const tDep = datesState[0];
    const tArr = datesState[N - 1];
    if (tArr <= tDep) return;
    const dtTotal = tArr - tDep;
    const updated = [...datesState];
    for (let k = 1; k < N - 1; k++) {
      updated[k] = tDep + (k / (N - 1)) * dtTotal;
    }
    setDatesState(updated);
  };

  const totalMissionTime = datesState[datesState.length - 1] - datesState[0];

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#18181B] border border-[#3F3F46] rounded-xl shadow-2xl max-w-2xl w-full p-5 flex flex-col max-h-[90vh] overflow-hidden text-xs">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#27272A]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/30">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-white text-base">Custom Trajectory Dates Manager</h3>
              <p className="text-[#71717A] text-[11px]">
                Directly configure dates for all bodies in the sequence. Any non-sampled date will solve Lambert transfers.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[#A1A1AA] hover:text-white hover:bg-[#27272A] rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quick Toolbar */}
        <div className="py-2.5 flex items-center justify-between gap-2 flex-wrap border-b border-[#27272A]/60">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleEvenlySpaceFlybys}
              className="px-2.5 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] text-slate-200 border border-[#3F3F46] text-[11px] font-semibold transition cursor-pointer"
              title="Linearly interpolate intermediate flyby dates between departure and arrival"
            >
              Evenly Space Intermediate Flybys
            </button>
            <button
              type="button"
              onClick={onReset}
              className="px-2.5 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] text-slate-300 border border-[#3F3F46] text-[11px] transition cursor-pointer flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset to Grid</span>
            </button>
          </div>
          <div className="text-[#A1A1AA] flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span>Mission Flight Time:</span>
            <strong className="font-mono text-white">{formatDuration(totalMissionTime, timeFormatMode)}</strong>
          </div>
        </div>

        {/* Dates Table */}
        <div className="flex-1 overflow-y-auto py-3 space-y-2">
          {datesState.map((ut, idx) => {
            const node = pathInsts[idx];
            const role = idx === 0 ? 'Departure' : idx === datesState.length - 1 ? 'Arrival' : `Flyby ${idx}`;
            const cal = utToYearDay(ut, timeFormatMode);
            const dtFromPrev = idx > 0 ? ut - datesState[idx - 1] : 0;
            const isChronological = idx === 0 || ut > datesState[idx - 1];

            return (
              <div
                key={node?.id || idx}
                className={`bg-[#09090B] border rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition ${
                  isChronological ? 'border-[#27272A]' : 'border-rose-500/60 bg-rose-950/20'
                }`}
              >
                {/* Node info */}
                <div className="flex items-center gap-2.5 sm:w-48 shrink-0">
                  <span className="w-6 h-6 rounded-full bg-purple-500/20 border border-purple-500/40 text-purple-300 font-bold font-mono text-[11px] flex items-center justify-center shrink-0">
                    {idx === 0 ? 'D' : idx === datesState.length - 1 ? 'A' : idx}
                  </span>
                  <div>
                    <div className="font-bold text-white text-sm flex items-center gap-1.5">
                      <span>{node?.bodyName || `Stage ${idx}`}</span>
                    </div>
                    <div className="text-[10px] text-[#71717A] flex items-center gap-1">
                      <span>{role}</span>
                      {idx > 0 && (
                        <>
                          <span>•</span>
                          <span className="text-amber-300/80 font-mono">
                            +{formatDuration(dtFromPrev, timeFormatMode)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Date Controls */}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Year Input */}
                  <div className="flex items-center bg-[#18181B] border border-[#3F3F46] rounded px-2 py-1">
                    <span className="text-[10px] text-[#71717A] font-bold mr-1">Y</span>
                    <input
                      type="number"
                      min="1"
                      value={cal.year}
                      onChange={e => handleYearDayChange(idx, parseInt(e.target.value, 10) || 1, cal.day)}
                      className="w-12 bg-transparent text-white font-mono text-xs outline-none text-right"
                    />
                  </div>

                  {/* Day Input */}
                  <div className="flex items-center bg-[#18181B] border border-[#3F3F46] rounded px-2 py-1">
                    <span className="text-[10px] text-[#71717A] font-bold mr-1">D</span>
                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      value={cal.day}
                      onChange={e => handleYearDayChange(idx, cal.year, parseFloat(e.target.value) || 1)}
                      className="w-14 bg-transparent text-white font-mono text-xs outline-none text-right"
                    />
                  </div>

                  {/* Quick Step Buttons */}
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => handleDateChange(idx, ut - 10 * daySec)}
                      className="px-1.5 py-1 rounded bg-[#27272A] hover:bg-purple-600/40 text-slate-300 text-[10px] font-mono"
                      title="-10 days"
                    >
                      -10d
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDateChange(idx, ut - 1 * daySec)}
                      className="px-1.5 py-1 rounded bg-[#27272A] hover:bg-purple-600/40 text-slate-300 text-[10px] font-mono"
                      title="-1 day"
                    >
                      -1d
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDateChange(idx, ut + 1 * daySec)}
                      className="px-1.5 py-1 rounded bg-[#27272A] hover:bg-purple-600/40 text-slate-300 text-[10px] font-mono"
                      title="+1 day"
                    >
                      +1d
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDateChange(idx, ut + 10 * daySec)}
                      className="px-1.5 py-1 rounded bg-[#27272A] hover:bg-purple-600/40 text-slate-300 text-[10px] font-mono"
                      title="+10 days"
                    >
                      +10d
                    </button>
                  </div>
                </div>

                {/* Formatted Display */}
                <div className="text-right sm:w-28 shrink-0 font-mono text-[11px] text-purple-300 font-semibold">
                  {formatShortUT(ut, timeFormatMode)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-3 pt-3 border-t border-[#27272A]">
          <button
            type="button"
            onClick={() => {
              onOptimizeAll();
              onClose();
            }}
            className="px-3 py-1.5 rounded bg-purple-600/30 hover:bg-purple-600 text-purple-200 hover:text-white border border-purple-500/40 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-purple-300" />
            <span>Optimize All Flybys (Dichotomy)</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded bg-[#27272A] hover:bg-[#3F3F46] text-slate-300 text-xs font-semibold transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onApplyAll(datesState);
                onClose();
              }}
              className="px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition cursor-pointer flex items-center gap-1.5 shadow-lg shadow-purple-900/30"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Apply All Custom Dates</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const MultiInstanceDebugModal: React.FC<MultiInstanceDebugModalProps> = ({
  initialData,
  seqPorkchop,
  porkchops = {},
  links = [],
  bodies = [],
  mainBody,
  sequencePorkchops,
  timeFormatMode,
  onClose,
  onRecomputePoint,
}) => {
  const [currentDepIndex, setCurrentDepIndex] = useState(initialData.clickDepIndex);
  const [currentArrIndex, setCurrentArrIndex] = useState(initialData.clickArrIndex);
  const [data, setData] = useState<MultiInstanceDebugData>(initialData);

  // Full dates array: [tDep, tFlyby_1, ..., tFlyby_{N-2}, tArr] (length N)
  const [customDates, setCustomDates] = useState<number[]>([
    initialData.depDate,
    ...initialData.rows.map(r => r.flybyDate),
    initialData.arrDate,
  ]);

  // Modal states for manual date editing
  const [editingDateInfo, setEditingDateInfo] = useState<{
    index: number;
    bodyName: string;
    role: 'departure' | 'flyby' | 'arrival';
    currentDate: number;
    minAllowedDate?: number;
    maxAllowedDate?: number;
  } | null>(null);

  const [isSequenceDatesModalOpen, setIsSequenceDatesModalOpen] = useState(false);
  const [customPivotInput, setCustomPivotInput] = useState('');

  // Status message for feedback after dichotomic search
  const [optimizingIndex, setOptimizingIndex] = useState<number | null>(null);
  const [isOptimizingAll, setIsOptimizingAll] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Sub-modal state for 3-instance debug plot when a row is clicked
  const [selected3InstanceData, setSelected3InstanceData] = useState<{
    plotData: FlybyDebugPlotData;
    row: MultiInstanceFlybyRow;
  } | null>(null);

  // Foldable section for Higher-Order Algorithm Decomposition & Candidate Array
  const [isAlgorithmSectionOpen, setIsAlgorithmSectionOpen] = useState(true);
  const [candidateFilter, setCandidateFilter] = useState<'all' | 'unpowered' | 'valid'>('all');
  const [candidateSearchQuery, setCandidateSearchQuery] = useState('');

  const filteredCandidates = useMemo(() => {
    if (!data.algorithmInfo?.samples) return [];
    let samples = data.algorithmInfo.samples;
    if (candidateFilter === 'unpowered') {
      samples = samples.filter(s => s.pivotDv < 1.0 && s.totalDv < 1.0);
    } else if (candidateFilter === 'valid') {
      samples = samples.filter(s => s.isValid);
    }
    if (candidateSearchQuery.trim()) {
      const q = candidateSearchQuery.trim().toLowerCase();
      samples = samples.filter(s => {
        const dateStr = formatShortUT(s.tFlyby, timeFormatMode).toLowerCase();
        return dateStr.includes(q) || s.sampleIndex.toString().includes(q);
      });
    }
    return samples;
  }, [data.algorithmInfo?.samples, candidateFilter, candidateSearchQuery, timeFormatMode]);

  const handleApplyPivotSampleDate = (sampleDate: number) => {
    const pivotIndex = data.algorithmInfo?.pivotFlybyIndex ?? 1;
    const newDates = [...customDates];
    newDates[pivotIndex] = sampleDate;
    applyNewDates(newDates);
    const bodyName = data.pathInsts[pivotIndex]?.bodyName || 'Pivot';
    setActionFeedback(`Set ${bodyName} flyby date to candidate ${formatShortUT(sampleDate, timeFormatMode)}`);
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const handleApplyCustomPivotDateText = () => {
    if (!customPivotInput.trim()) return;
    const parsedUT = parseDateStringToUT(customPivotInput, timeFormatMode);
    if (parsedUT !== null && Number.isFinite(parsedUT)) {
      handleApplyPivotSampleDate(parsedUT);
      setCustomPivotInput('');
    } else {
      setActionFeedback('Could not parse date string');
      setTimeout(() => setActionFeedback(null), 2500);
    }
  };

  const applyNewDates = (newDates: number[]) => {
    setCustomDates(newDates);
    const evaluated = evaluateMultiInstanceForDates(
      data.pathInsts,
      newDates,
      bodies,
      mainBody,
      porkchops,
      links
    );
    setData(prev => ({
      ...prev,
      depDate: newDates[0],
      arrDate: newDates[newDates.length - 1],
      totalFlightTime: evaluated.totalFlightTime,
      totalDv: evaluated.totalDv,
      c3DepSource: evaluated.c3DepSource,
      c3ArrTarget: evaluated.c3ArrTarget,
      rows: evaluated.rows,
    }));
  };

  const handleSingleDateApplied = (index: number, newUT: number) => {
    const newDates = [...customDates];
    newDates[index] = newUT;
    applyNewDates(newDates);
    const nodeName = data.pathInsts[index]?.bodyName || `Stage ${index}`;
    setActionFeedback(`Updated ${nodeName} date to ${formatShortUT(newUT, timeFormatMode)} (Lambert evaluated)`);
    setTimeout(() => setActionFeedback(null), 3000);
  };

  const updateIndices = (newDepI: number, newArrI: number) => {
    const clampedDepI = Math.max(0, Math.min(seqPorkchop.depDates.length - 1, newDepI));
    const clampedArrI = Math.max(0, Math.min(seqPorkchop.arrDates.length - 1, newArrI));
    setCurrentDepIndex(clampedDepI);
    setCurrentArrIndex(clampedArrI);

    const fresh = extractMultiInstanceDebugData(
      seqPorkchop,
      porkchops,
      links,
      clampedDepI,
      clampedArrI,
      bodies,
      mainBody,
      sequencePorkchops
    );
    if (fresh) {
      setData(fresh);
      setCustomDates([
        fresh.depDate,
        ...fresh.rows.map(r => r.flybyDate),
        fresh.arrDate,
      ]);
    }
  };

  // Step a single flyby date
  const handleStepFlybyDate = (flybyIndex: number, direction: -1 | 1, multiplier: number = 1) => {
    const step = getFlybyDateSampleStep(data.pathInsts, flybyIndex, porkchops, links);
    const newDates = [...customDates];
    const prevDate = newDates[flybyIndex - 1];
    const nextDate = newDates[flybyIndex + 1];

    let candidateDate = newDates[flybyIndex] + direction * multiplier * step;
    candidateDate = Math.max(prevDate + 3600, Math.min(nextDate - 3600, candidateDate));

    newDates[flybyIndex] = candidateDate;
    applyNewDates(newDates);
  };

  // Optimize a single flyby date using dichotomic / bisection search
  const handleOptimizeSingleFlyby = (flybyIndex: number) => {
    setOptimizingIndex(flybyIndex);
    setActionFeedback(null);

    setTimeout(() => {
      try {
        const optDate = optimizeFlybyDateDichotomic(
          data.pathInsts,
          customDates,
          flybyIndex,
          bodies,
          mainBody,
          porkchops,
          links
        );
        const newDates = [...customDates];
        newDates[flybyIndex] = optDate;
        applyNewDates(newDates);

        const bodyName = data.pathInsts[flybyIndex]?.bodyName || `Flyby ${flybyIndex}`;
        setActionFeedback(`${bodyName} flyby date optimized!`);
        setTimeout(() => setActionFeedback(null), 2500);
      } catch (err) {
        console.error('Error optimizing flyby date:', err);
        setActionFeedback('Optimization failed');
        setTimeout(() => setActionFeedback(null), 2500);
      } finally {
        setOptimizingIndex(null);
      }
    }, 10);
  };

  // Auto-optimize all intermediate flyby dates
  const handleOptimizeAllFlybys = () => {
    setIsOptimizingAll(true);
    setActionFeedback(null);

    setTimeout(() => {
      try {
        const optDates = optimizeAllFlybyDates(
          data.pathInsts,
          customDates,
          bodies,
          mainBody,
          porkchops,
          links
        );
        applyNewDates(optDates);
        setActionFeedback('All flyby dates refined!');
        setTimeout(() => setActionFeedback(null), 2500);
      } catch (err) {
        console.error('Error optimizing all flybys:', err);
        setActionFeedback('Optimization failed');
        setTimeout(() => setActionFeedback(null), 2500);
      } finally {
        setIsOptimizingAll(false);
      }
    }, 10);
  };

  // Reset flyby dates back to solver defaults
  const handleResetFlybyDates = () => {
    updateIndices(currentDepIndex, currentArrIndex);
    setActionFeedback('Flyby dates reset to solver defaults');
    setTimeout(() => setActionFeedback(null), 2000);
  };

  const handleRowClick = (row: MultiInstanceFlybyRow) => {
    if (row.sub3DebugData) {
      setSelected3InstanceData({
        plotData: row.sub3DebugData,
        row,
      });
    }
  };

  const N = data.instanceCount;
  const srcBody = data.pathInsts[0]?.bodyName || 'Departure';
  const tgtBody = data.pathInsts[N - 1]?.bodyName || 'Arrival';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-2 sm:p-4">
      <div className="bg-[#18181B] border border-[#27272A] rounded-xl shadow-2xl max-w-6xl w-full flex flex-col max-h-[96vh] overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#27272A] bg-[#09090B]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <span>{N}-Instance Sequence Trajectory Inspector</span>
                <span className="bg-purple-500/20 text-purple-300 text-[10px] px-2 py-0.5 rounded border border-purple-500/30 font-bold uppercase tracking-wider">
                  Sample ({currentDepIndex}, {currentArrIndex})
                </span>
                {data.totalDv < 1.0 && (
                  <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded border border-emerald-500/30 font-semibold flex items-center gap-1">
                    <Zap className="w-3 h-3 text-emerald-400" />
                    <span>Free Flyby Chain (0 m/s)</span>
                  </span>
                )}
                {actionFeedback && (
                  <span className="bg-blue-500/20 text-cyan-300 text-[10px] px-2 py-0.5 rounded border border-cyan-500/30 font-medium">
                    {actionFeedback}
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-[#A1A1AA] flex items-center gap-1.5 mt-0.5">
                <span className="text-[#60A5FA] font-semibold">{data.pathInsts.map(i => i.bodyName).join(' ➔ ')}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#A1A1AA] hover:text-white hover:bg-[#27272A] transition-colors cursor-pointer"
              title="Close multi-instance debug inspector"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Date & Stepper Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 bg-[#121215] border-b border-[#27272A] text-xs">
          
          {/* Departure Stepper */}
          <div className="flex items-center gap-2">
            <span className="text-[#A1A1AA] font-medium flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-blue-400" />
              <span>Dep ({srcBody}):</span>
            </span>
            <div className="flex items-center bg-[#18181B] border border-[#27272A] rounded">
              <button
                onClick={() => updateIndices(currentDepIndex - 10, currentArrIndex)}
                disabled={currentDepIndex <= 0}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Step departure date -10 samples (--)"
              >
                <ChevronsLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => updateIndices(currentDepIndex - 1, currentArrIndex)}
                disabled={currentDepIndex <= 0}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Previous departure date (-1 sample)"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {/* Clickable Date Display to open single date editor */}
              <button
                type="button"
                onClick={() =>
                  setEditingDateInfo({
                    index: 0,
                    bodyName: srcBody,
                    role: 'departure',
                    currentDate: data.depDate,
                    minAllowedDate: 0,
                    maxAllowedDate: customDates[1] ? customDates[1] - 3600 : undefined,
                  })
                }
                className="flex items-center gap-1 px-2 py-0.5 hover:bg-purple-950/40 text-white hover:text-purple-300 font-mono font-semibold text-[11px] transition cursor-pointer"
                title="Click to set any custom departure date (even non-sampled)"
              >
                <span>{formatShortUT(data.depDate, timeFormatMode)}</span>
                <Edit3 className="w-2.5 h-2.5 text-purple-400/80" />
              </button>

              <button
                onClick={() => updateIndices(currentDepIndex + 1, currentArrIndex)}
                disabled={currentDepIndex >= data.maxDepIndex}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Next departure date (+1 sample)"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => updateIndices(currentDepIndex + 10, currentArrIndex)}
                disabled={currentDepIndex >= data.maxDepIndex}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Step departure date +10 samples (++)"
              >
                <ChevronsRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Arrival Stepper */}
          <div className="flex items-center gap-2">
            <span className="text-[#A1A1AA] font-medium flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              <span>Arr ({tgtBody}):</span>
            </span>
            <div className="flex items-center bg-[#18181B] border border-[#27272A] rounded">
              <button
                onClick={() => updateIndices(currentDepIndex, currentArrIndex - 10)}
                disabled={currentArrIndex <= 0}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Step arrival date -10 samples (--)"
              >
                <ChevronsLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => updateIndices(currentDepIndex, currentArrIndex - 1)}
                disabled={currentArrIndex <= 0}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Previous arrival date (-1 sample)"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>

              {/* Clickable Date Display to open single date editor */}
              <button
                type="button"
                onClick={() =>
                  setEditingDateInfo({
                    index: N - 1,
                    bodyName: tgtBody,
                    role: 'arrival',
                    currentDate: data.arrDate,
                    minAllowedDate: customDates[N - 2] ? customDates[N - 2] + 3600 : undefined,
                  })
                }
                className="flex items-center gap-1 px-2 py-0.5 hover:bg-purple-950/40 text-white hover:text-purple-300 font-mono font-semibold text-[11px] transition cursor-pointer"
                title="Click to set any custom arrival date (even non-sampled)"
              >
                <span>{formatShortUT(data.arrDate, timeFormatMode)}</span>
                <Edit3 className="w-2.5 h-2.5 text-purple-400/80" />
              </button>

              <button
                onClick={() => updateIndices(currentDepIndex, currentArrIndex + 1)}
                disabled={currentArrIndex >= data.maxArrIndex}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Next arrival date (+1 sample)"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => updateIndices(currentDepIndex, currentArrIndex + 10)}
                disabled={currentArrIndex >= data.maxArrIndex}
                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                title="Step arrival date +10 samples (++)"
              >
                <ChevronsRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Total Duration */}
          <div className="flex items-center gap-1.5 text-[#A1A1AA]">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <span>Duration:</span>
            <span className="font-mono font-bold text-white">
              {formatDuration(data.totalFlightTime, timeFormatMode)}
            </span>
          </div>

          {/* Quick Global Actions: Manage All Dates, Optimize All & Reset */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsSequenceDatesModalOpen(true)}
              className="px-2.5 py-1 rounded bg-[#27272A] hover:bg-[#3F3F46] border border-[#3F3F46] text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              title="Open full sequence dates manager: edit any stage date and compute Lambert transfer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" />
              <span>Edit All Dates</span>
            </button>

            <button
              onClick={handleOptimizeAllFlybys}
              disabled={isOptimizingAll}
              className="px-2.5 py-1 rounded bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 text-purple-200 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              title="Dichotomic / Bisection Search: Auto-refine all intermediate flyby dates to find 0 m/s unpowered flybys"
            >
              <Sparkles className="w-3.5 h-3.5 text-purple-300" />
              <span>{isOptimizingAll ? 'Optimizing...' : 'Dichotomy (All Flybys)'}</span>
            </button>

            <button
              onClick={handleResetFlybyDates}
              className="p-1 rounded bg-[#18181B] hover:bg-[#27272A] border border-[#27272A] text-slate-400 hover:text-white transition cursor-pointer"
              title="Reset flyby dates to solver defaults"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Total Delta-V */}
          <div className="flex items-center gap-1.5 bg-blue-950/60 border border-blue-500/30 px-2.5 py-1 rounded">
            <Rocket className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-blue-200">Total Powered Δv:</span>
            <span className="font-mono font-bold text-cyan-300 text-xs">
              {data.totalDv.toFixed(1)} m/s
            </span>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          
          {/* Info Banner */}
          <div className="bg-[#09090B] border border-[#27272A] rounded-lg p-3 flex items-start gap-2.5 text-xs text-[#A1A1AA]">
            <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-slate-200 font-medium leading-relaxed">
                This table breaks down each intermediate flyby body in the <strong className="text-white">{N}-instance sequence</strong>. Flyby dates are <strong className="text-purple-300">fully configurable</strong> with live recalculation of previous, current, and next legs.
              </p>
              <p className="text-[#71717A] text-[11px] mt-0.5">
                Use the <strong className="text-slate-300">&lt; / &gt;</strong> buttons to step a flyby date, or click <strong className="text-purple-400">Dichotomy</strong> on any row to perform a continuous bisection search between samples to find the 0 m/s unpowered flyby date. Click a row to open its 3-instance subsystem plot.
              </p>
            </div>
          </div>

          {/* Table Container */}
          <div className="border border-[#27272A] rounded-lg overflow-hidden bg-[#09090B]">
            <div className="px-3 py-2 bg-[#18181B] border-b border-[#27272A] flex items-center justify-between">
              <span className="text-xs font-bold text-white uppercase tracking-wider">
                Flyby Instances Breakdown ({data.rows.length} Intermediate Bodies)
              </span>
              <span className="text-[11px] text-blue-400 flex items-center gap-1 font-medium">
                <span>Click any row to open 3-instance debug plot</span>
                <ExternalLink className="w-3 h-3" />
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-[#121215] border-b border-[#27272A] text-[11px] text-[#A1A1AA]">
                    <th className="py-2.5 px-3 font-semibold">Instance / Body</th>
                    <th className="py-2.5 px-3 font-semibold min-w-[210px]">Flyby Date (Configurable)</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Arrival C3</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Departure C3</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Deflection Needed</th>
                    <th className="py-2.5 px-3 font-semibold text-right">
                      Deflection Max for min(arrC3, depC3)
                    </th>
                    <th className="py-2.5 px-3 font-semibold text-right">Δv</th>
                    <th className="py-2.5 px-3 font-semibold text-center">Sub-plot</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272A]/60">
                  {data.rows.map((row) => {
                    const isExcessDeflection = row.deflectionNeededDeg > row.deflectionMaxDeg + 0.1;
                    const isOptimizingThis = optimizingIndex === row.flybyIndex;
                    return (
                      <tr
                        key={row.instanceId}
                        onClick={() => handleRowClick(row)}
                        className="hover:bg-blue-600/15 transition cursor-pointer group"
                        title={`Click to inspect 3-instance subsystem: ${row.prevBodyName} ➔ ${row.bodyName} ➔ ${row.nextBodyName}`}
                      >
                        {/* Instance / Body */}
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-purple-500/20 border border-purple-500/40 text-purple-300 font-bold font-mono text-[10px] flex items-center justify-center shrink-0">
                              {row.flybyIndex}
                            </span>
                            <div>
                              <div className="font-bold text-white group-hover:text-blue-300 transition flex items-center gap-1.5">
                                <span>{row.bodyName}</span>
                                {row.instanceName !== row.bodyName && (
                                  <span className="text-[10px] text-[#71717A]">({row.instanceName})</span>
                                )}
                              </div>
                              <div className="text-[10px] text-[#71717A] flex items-center gap-1">
                                <span>From {row.prevBodyName}</span>
                                <ArrowRight className="w-2.5 h-2.5 text-[#52525B]" />
                                <span>To {row.nextBodyName}</span>
                              </div>
                            </div>
                          </div>
                        </td>

                        {/* Flyby Date (Configurable Stepper + Manual Date Editor + Dichotomic Search) */}
                        <td className="py-2 px-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <div className="flex items-center bg-[#18181B] border border-[#27272A] rounded">
                              <button
                                onClick={() => handleStepFlybyDate(row.flybyIndex, -1, 10)}
                                disabled={row.flybyDate <= (row.prevFlybyOrDepDate + 3600)}
                                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                                title={`Step ${row.bodyName} flyby date -10 samples earlier (--)`}
                              >
                                <ChevronsLeft className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleStepFlybyDate(row.flybyIndex, -1, 1)}
                                disabled={row.flybyDate <= (row.prevFlybyOrDepDate + 3600)}
                                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                                title={`Step ${row.bodyName} flyby date -1 sample earlier (-)`}
                              >
                                <ChevronLeft className="w-3 h-3" />
                              </button>

                              {/* Interactive Date badge that triggers manual single date editor */}
                              <button
                                type="button"
                                onClick={() =>
                                  setEditingDateInfo({
                                    index: row.flybyIndex,
                                    bodyName: row.bodyName,
                                    role: 'flyby',
                                    currentDate: row.flybyDate,
                                    minAllowedDate: row.prevFlybyOrDepDate + 3600,
                                    maxAllowedDate: row.nextFlybyOrArrDate - 3600,
                                  })
                                }
                                className="flex items-center gap-1 px-1.5 py-0.5 hover:bg-purple-950/50 text-white hover:text-purple-300 transition font-mono font-semibold text-[11px] whitespace-nowrap cursor-pointer rounded"
                                title="Click to manually enter any date (Lambert solver recalculates)"
                              >
                                <span>{formatShortUT(row.flybyDate, timeFormatMode)}</span>
                                <Edit3 className="w-2.5 h-2.5 text-purple-400" />
                              </button>

                              <button
                                onClick={() => handleStepFlybyDate(row.flybyIndex, 1, 1)}
                                disabled={row.flybyDate >= (row.nextFlybyOrArrDate - 3600)}
                                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                                title={`Step ${row.bodyName} flyby date +1 sample later (+)`}
                              >
                                <ChevronRight className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleStepFlybyDate(row.flybyIndex, 1, 10)}
                                disabled={row.flybyDate >= (row.nextFlybyOrArrDate - 3600)}
                                className="p-1 hover:bg-[#27272A] disabled:opacity-30 text-slate-300 transition cursor-pointer"
                                title={`Step ${row.bodyName} flyby date +10 samples later (++)`}
                              >
                                <ChevronsRight className="w-3 h-3" />
                              </button>
                            </div>

                            <button
                              onClick={() => handleOptimizeSingleFlyby(row.flybyIndex)}
                              disabled={isOptimizingThis}
                              className="px-2 py-1 rounded bg-purple-600/20 hover:bg-purple-600/40 text-purple-300 border border-purple-500/30 text-[10px] font-semibold flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
                              title="Dichotomic / Bisection Search between samples: optimize flyby date for 0 m/s unpowered flyby"
                            >
                              <Zap className="w-3 h-3 text-purple-400" />
                              <span>{isOptimizingThis ? '...' : 'Dichotomy'}</span>
                            </button>
                          </div>
                        </td>

                        {/* Arrival C3 */}
                        <td className="py-2.5 px-3 font-mono text-right text-emerald-400 font-medium">
                          {Number.isFinite(row.c3Arr) ? (
                            <>
                              {row.c3Arr.toFixed(2)}{' '}
                              <span className="text-[10px] text-[#71717A]">km²/s²</span>
                            </>
                          ) : (
                            <span className="text-[#71717A]">—</span>
                          )}
                        </td>

                        {/* Departure C3 */}
                        <td className="py-2.5 px-3 font-mono text-right text-blue-400 font-medium">
                          {Number.isFinite(row.c3Dep) ? (
                            <>
                              {row.c3Dep.toFixed(2)}{' '}
                              <span className="text-[10px] text-[#71717A]">km²/s²</span>
                            </>
                          ) : (
                            <span className="text-[#71717A]">—</span>
                          )}
                        </td>

                        {/* Deflection Needed */}
                        <td className="py-2.5 px-3 font-mono text-right">
                          {Number.isFinite(row.deflectionNeededDeg) && row.deflectionNeededDeg > 0 ? (
                            <span
                              className={`font-semibold ${
                                isExcessDeflection ? 'text-amber-400' : 'text-slate-200'
                              }`}
                            >
                              {row.deflectionNeededDeg.toFixed(2)}°
                            </span>
                          ) : (
                            <span className="text-[#71717A]">—</span>
                          )}
                        </td>

                        {/* Deflection Max for min(arrC3, depC3) */}
                        <td className="py-2.5 px-3 font-mono text-right text-purple-300 font-medium">
                          {Number.isFinite(row.deflectionMaxDeg) && row.deflectionMaxDeg > 0 ? (
                            `${row.deflectionMaxDeg.toFixed(2)}°`
                          ) : (
                            <span className="text-[#71717A]">—</span>
                          )}
                        </td>

                        {/* Delta-V */}
                        <td className="py-2.5 px-3 font-mono text-right">
                          {!Number.isFinite(row.dvMps) ? (
                            <span className="text-red-400 font-semibold text-[11px]">Invalid / N/A</span>
                          ) : row.dvMps < 1.0 ? (
                            <span className="inline-flex items-center gap-1 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded font-bold text-[10px]">
                              <Zap className="w-2.5 h-2.5 text-emerald-400" />
                              <span>0 m/s (Free)</span>
                            </span>
                          ) : (
                            <span className="font-bold text-amber-300">
                              {row.dvMps.toFixed(1)} m/s
                            </span>
                          )}
                        </td>

                        {/* Sub-plot CTA */}
                        <td className="py-2.5 px-3 text-center">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-600/30 hover:bg-blue-600 border border-blue-500/40 text-blue-200 hover:text-white text-[10px] font-semibold transition cursor-pointer"
                          >
                            <span>Inspect</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Foldable Section: Algorithm Breakdown & Pivot Candidate Flyby Date Costs */}
          {data.algorithmInfo && (
            <div className="bg-[#121215] border border-[#27272A] rounded-lg overflow-hidden flex flex-col transition-all">
              {/* Header Toggle */}
              <button
                type="button"
                onClick={() => setIsAlgorithmSectionOpen(prev => !prev)}
                className="w-full px-4 py-3 bg-[#18181B] hover:bg-[#202025] flex items-center justify-between gap-3 text-left transition cursor-pointer border-b border-[#27272A]/50"
              >
                <div className="flex items-center gap-2.5 flex-wrap">
                  <div className="p-1 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
                    <GitBranch className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-bold text-[#E4E4E7] tracking-tight">
                    Algorithm & Pivot Body Cost Array ({data.algorithmInfo.pivotBodyName})
                  </span>

                  {/* Algorithm Type Badge */}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-950/60 border border-purple-500/40 text-purple-300">
                    <span>Algorithm:</span>
                    <strong className="font-mono text-purple-200">{data.algorithmInfo.algorithmName}</strong>
                  </span>

                  {/* Subsequence Badge */}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#27272A]/60 border border-[#3F3F46] text-[#A1A1AA]">
                    <span>Sub-sequence:</span>
                    <strong className="text-[#E4E4E7]">{data.algorithmInfo.subSequenceLabel}</strong>
                  </span>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                    {data.algorithmInfo.samples.length} candidate dates sampled
                  </span>
                  <div className="p-1 rounded bg-[#27272A] text-[#A1A1AA]">
                    {isAlgorithmSectionOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </div>
                </div>
              </button>

              {/* Foldable Content */}
              {isAlgorithmSectionOpen && (
                <div className="p-3.5 flex flex-col gap-3">
                  {/* Algorithmic Physics & Grid Insight Banner */}
                  <div className="bg-purple-950/20 border border-purple-500/20 rounded-md p-2.5 text-xs text-purple-200/90 leading-relaxed flex items-start gap-2.5">
                    <Info className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="text-purple-300">Why Porkchop Grid vs. Continuous Dichotomy: </strong>
                      The porkchop search operates hierarchically on fixed date grids. In an N-body sequence (such as Kerbin ➔ Jool ➔ Urlum ➔ Grannus), it samples flyby dates for the pivot body (<strong>{data.algorithmInfo.pivotBodyName}</strong>) and looks up corresponding downstream flyby dates (e.g. Urlum) from the pre-computed sub-sequence grid. When intermediate flybys require precise continuous synchronization, the discrete grid points may miss the razor-thin 0 m/s ballistic corridor. The <strong>Dichotomy (All Flybys)</strong> tool jointly refines all intermediate flybys continuously to discover the true 0 m/s trajectory.
                    </div>
                  </div>

                  {/* Controls, Filter Bar & Custom Pivot Tester */}
                  <div className="flex items-center justify-between gap-3 flex-wrap text-xs bg-[#09090B] p-2.5 rounded-lg border border-[#27272A]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] text-[#A1A1AA] font-semibold flex items-center gap-1">
                        <Filter className="w-3 h-3" /> Filter:
                      </span>
                      <button
                        type="button"
                        onClick={() => setCandidateFilter('all')}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer ${
                          candidateFilter === 'all'
                            ? 'bg-blue-600 text-white font-semibold'
                            : 'bg-[#27272A] text-[#A1A1AA] hover:text-white'
                        }`}
                      >
                        All ({data.algorithmInfo.samples.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCandidateFilter('unpowered')}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer ${
                          candidateFilter === 'unpowered'
                            ? 'bg-emerald-600 text-white font-semibold'
                            : 'bg-[#27272A] text-[#A1A1AA] hover:text-white'
                        }`}
                      >
                        0 m/s Unpowered ({data.algorithmInfo.samples.filter(s => s.pivotDv < 1.0 && s.totalDv < 1.0).length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCandidateFilter('valid')}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer ${
                          candidateFilter === 'valid'
                            ? 'bg-cyan-700 text-white font-semibold'
                            : 'bg-[#27272A] text-[#A1A1AA] hover:text-white'
                        }`}
                      >
                        Valid (&lt;10 km/s) ({data.algorithmInfo.samples.filter(s => s.isValid).length})
                      </button>
                    </div>

                    {/* Custom Pivot Date Test Input & Filter Search */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Test Custom Date for Pivot */}
                      <div className="flex items-center gap-1 bg-[#18181B] border border-purple-500/40 rounded px-2 py-0.5">
                        <span className="text-[10px] text-purple-300 font-semibold">Test Pivot Date:</span>
                        <input
                          type="text"
                          placeholder="e.g. Y1 D205"
                          value={customPivotInput}
                          onChange={e => setCustomPivotInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleApplyCustomPivotDateText();
                          }}
                          className="bg-transparent w-24 text-white font-mono text-[11px] outline-none placeholder-[#71717A]"
                        />
                        <button
                          type="button"
                          onClick={handleApplyCustomPivotDateText}
                          className="px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-[10px] font-bold transition cursor-pointer"
                        >
                          Apply
                        </button>
                      </div>

                      {/* Search Input */}
                      <div className="relative">
                        <Search className="w-3 h-3 text-[#71717A] absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          placeholder="Search sample..."
                          value={candidateSearchQuery}
                          onChange={e => setCandidateSearchQuery(e.target.value)}
                          className="bg-[#18181B] border border-[#27272A] focus:border-purple-500 rounded pl-7 pr-2.5 py-1 text-[11px] text-[#E4E4E7] placeholder-[#71717A] outline-none"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Long Array Scrollable Table */}
                  <div className="border border-[#27272A] rounded-lg overflow-hidden bg-[#09090B]">
                    <div className="max-h-72 overflow-y-auto overflow-x-auto">
                      <table className="w-full text-left text-xs border-collapse font-mono">
                        <thead className="bg-[#18181B] text-[#A1A1AA] text-[10px] uppercase font-bold sticky top-0 z-10 border-b border-[#27272A]">
                          <tr>
                            <th className="py-2 px-2.5 text-center w-12">#</th>
                            <th className="py-2 px-3">Flyby Date ({data.algorithmInfo.pivotBodyName})</th>
                            <th className="py-2 px-2.5 text-right">Inbound C3</th>
                            <th className="py-2 px-2.5 text-right">Outbound C3</th>
                            <th className="py-2 px-2.5 text-right">Turn Needed</th>
                            <th className="py-2 px-2.5 text-right">Max Turn</th>
                            <th className="py-2 px-2.5 text-right">Pivot Δv</th>
                            <th className="py-2 px-2.5 text-right">Sub-Seq Δv</th>
                            <th className="py-2 px-2.5 text-right">Total Δv</th>
                            <th className="py-2 px-3">Subsequence Flybys</th>
                            <th className="py-2 px-2.5 text-center">Status</th>
                            <th className="py-2 px-2.5 text-center">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#27272A]/50 text-[11px]">
                          {filteredCandidates.length === 0 ? (
                            <tr>
                              <td colSpan={12} className="py-6 text-center text-[#71717A] italic">
                                No candidate samples match current filter criteria.
                              </td>
                            </tr>
                          ) : (
                            filteredCandidates.map(sample => {
                              const isUnpowered = sample.pivotDv < 1.0 && sample.totalDv < 1.0;
                              const isSelected = Math.abs(sample.tFlyby - customDates[data.algorithmInfo?.pivotFlybyIndex ?? 1]) < 86400 * 2;
                              const isOptimal = !!sample.isOptimal;

                              return (
                                <tr
                                  key={`sample-${sample.sampleIndex}`}
                                  className={`transition hover:bg-zinc-850 ${
                                    isSelected
                                      ? 'bg-purple-950/30'
                                      : isOptimal
                                      ? 'bg-blue-950/20'
                                      : ''
                                  }`}
                                >
                                  {/* Sample Index */}
                                  <td className="py-1.5 px-2.5 text-center text-[#71717A] text-[10px]">
                                    {sample.sampleIndex}
                                  </td>

                                  {/* Flyby Date */}
                                  <td className="py-1.5 px-3">
                                    <div className="flex items-center gap-1.5">
                                      <span className={`font-semibold ${isSelected ? 'text-purple-300' : 'text-[#E4E4E7]'}`}>
                                        {formatShortUT(sample.tFlyby, timeFormatMode)}
                                      </span>
                                      {isSelected && (
                                        <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-purple-500/30 text-purple-300 border border-purple-500/40">
                                          CURRENT
                                        </span>
                                      )}
                                      {isOptimal && !isSelected && (
                                        <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-blue-500/30 text-blue-300 border border-blue-500/40">
                                          PORKCHOP MIN
                                        </span>
                                      )}
                                    </div>
                                  </td>

                                  {/* Inbound C3 */}
                                  <td className="py-1.5 px-2.5 text-right text-blue-300">
                                    {Number.isFinite(sample.c3ArrPivot) ? `${sample.c3ArrPivot.toFixed(2)}` : '—'}
                                  </td>

                                  {/* Outbound C3 */}
                                  <td className="py-1.5 px-2.5 text-right text-emerald-300">
                                    {Number.isFinite(sample.c3DepPivot) ? `${sample.c3DepPivot.toFixed(2)}` : '—'}
                                  </td>

                                  {/* Turn Needed */}
                                  <td className="py-1.5 px-2.5 text-right text-[#E4E4E7]">
                                    {Number.isFinite(sample.deflectionAngleDeg) ? `${sample.deflectionAngleDeg.toFixed(1)}°` : '—'}
                                  </td>

                                  {/* Turn Max */}
                                  <td className="py-1.5 px-2.5 text-right text-[#A1A1AA]">
                                    {Number.isFinite(sample.maxDeflectionAngleDeg) ? `${sample.maxDeflectionAngleDeg.toFixed(1)}°` : '—'}
                                  </td>

                                  {/* Pivot Δv */}
                                  <td className={`py-1.5 px-2.5 text-right font-semibold ${
                                    sample.pivotDv < 1.0 ? 'text-emerald-400' : sample.pivotDv < 500 ? 'text-amber-400' : 'text-rose-400'
                                  }`}>
                                    {Number.isFinite(sample.pivotDv) ? `${sample.pivotDv.toFixed(0)} m/s` : '—'}
                                  </td>

                                  {/* Sub-Seq Δv */}
                                  <td className="py-1.5 px-2.5 text-right text-[#A1A1AA]">
                                    {Number.isFinite(sample.subSequenceDv) ? `${sample.subSequenceDv.toFixed(0)} m/s` : '—'}
                                  </td>

                                  {/* Total Δv */}
                                  <td className={`py-1.5 px-2.5 text-right font-bold ${
                                    sample.totalDv < 1.0 ? 'text-emerald-300' : sample.totalDv < 1000 ? 'text-cyan-300' : 'text-rose-400'
                                  }`}>
                                    {Number.isFinite(sample.totalDv) ? `${sample.totalDv.toFixed(0)} m/s` : '—'}
                                  </td>

                                  {/* Subsequence Dates */}
                                  <td className="py-1.5 px-3 text-[10px] text-[#A1A1AA]">
                                    {sample.otherFlybyDates.length > 0 ? (
                                      <div className="flex items-center gap-1 flex-wrap">
                                        {sample.otherFlybyDates.map((fd, fIdx) => (
                                          <span key={fIdx} className="px-1 py-0.5 rounded bg-[#18181B] border border-[#27272A] text-zinc-300">
                                            {formatShortUT(fd, timeFormatMode)}
                                          </span>
                                        ))}
                                      </div>
                                    ) : (
                                      '—'
                                    )}
                                  </td>

                                  {/* Status */}
                                  <td className="py-1.5 px-2.5 text-center">
                                    {isUnpowered ? (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-950/60 text-emerald-300 border border-emerald-500/40">
                                        <CheckCircle2 className="w-2.5 h-2.5" />
                                        <span>0 m/s Free</span>
                                      </span>
                                    ) : sample.isValid ? (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-950/40 text-amber-300 border border-amber-500/30">
                                        <span>Powered</span>
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium bg-rose-950/40 text-rose-300 border border-rose-500/30">
                                        <AlertCircle className="w-2.5 h-2.5" />
                                        <span>Excess</span>
                                      </span>
                                    )}
                                  </td>

                                  {/* Action */}
                                  <td className="py-1.5 px-2.5 text-center">
                                    <button
                                      type="button"
                                      onClick={() => handleApplyPivotSampleDate(sample.tFlyby)}
                                      disabled={isSelected}
                                      className={`px-2 py-0.5 rounded text-[10px] font-semibold transition cursor-pointer ${
                                        isSelected
                                          ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                          : 'bg-purple-600/30 hover:bg-purple-600 border border-purple-500/40 text-purple-200 hover:text-white'
                                      }`}
                                      title={`Set ${data.algorithmInfo?.pivotBodyName} date to ${formatShortUT(sample.tFlyby, timeFormatMode)}`}
                                    >
                                      {isSelected ? 'Applied' : 'Apply'}
                                    </button>
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Sequence Overview Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
            <div className="bg-[#09090B] border border-[#27272A] rounded p-2.5 flex flex-col gap-0.5">
              <span className="text-[10px] uppercase font-bold text-[#A1A1AA]">Departure C3</span>
              <span className="font-mono text-sm font-bold text-blue-400">
                {`${vecMag(data.c3DepSource).toFixed(2)} km²/s²`}
              </span>
              <span className="text-[10px] text-[#71717A] truncate">From {srcBody}</span>
            </div>

            <div className="bg-[#09090B] border border-[#27272A] rounded p-2.5 flex flex-col gap-0.5">
              <span className="text-[10px] uppercase font-bold text-[#A1A1AA]">Arrival C3</span>
              <span className="font-mono text-sm font-bold text-emerald-400">
                {`${vecMag(data.c3ArrTarget).toFixed(2)} km²/s²`}
              </span>
              <span className="text-[10px] text-[#71717A] truncate">At {tgtBody}</span>
            </div>

            <div className="bg-[#09090B] border border-[#27272A] rounded p-2.5 flex flex-col gap-0.5">
              <span className="text-[10px] uppercase font-bold text-[#A1A1AA]">Total Powered Δv</span>
              <span className="font-mono text-sm font-bold text-cyan-300">
                {Number.isFinite(data.totalDv) ? `${data.totalDv.toFixed(1)} m/s` : '—'}
              </span>
              <span className="text-[10px] text-[#71717A]">
                {data.rows.filter(r => r.dvMps < 1.0).length} of {data.rows.length} flybys free
              </span>
            </div>

            <div className="bg-[#09090B] border border-[#27272A] rounded p-2.5 flex flex-col gap-0.5">
              <span className="text-[10px] uppercase font-bold text-[#A1A1AA]">Mission Duration</span>
              <span className="font-mono text-sm font-bold text-amber-400">
                {formatDuration(data.totalFlightTime, timeFormatMode)}
              </span>
              <span className="text-[10px] text-[#71717A]">Total flight time</span>
            </div>
          </div>

        </div>

      </div>

      {/* Single Date Edit Modal */}
      {editingDateInfo && (
        <SingleDateEditModal
          index={editingDateInfo.index}
          bodyName={editingDateInfo.bodyName}
          role={editingDateInfo.role}
          currentDate={editingDateInfo.currentDate}
          minAllowedDate={editingDateInfo.minAllowedDate}
          maxAllowedDate={editingDateInfo.maxAllowedDate}
          timeFormatMode={timeFormatMode}
          onApply={(newDate) => {
            handleSingleDateApplied(editingDateInfo.index, newDate);
          }}
          onClose={() => setEditingDateInfo(null)}
        />
      )}

      {/* Sequence Dates Manager Modal */}
      {isSequenceDatesModalOpen && (
        <SequenceDatesManagerModal
          pathInsts={data.pathInsts}
          customDates={customDates}
          timeFormatMode={timeFormatMode}
          onApplyAll={(newDates) => {
            applyNewDates(newDates);
            setActionFeedback('Custom sequence dates applied and evaluated');
            setTimeout(() => setActionFeedback(null), 2500);
          }}
          onOptimizeAll={handleOptimizeAllFlybys}
          onReset={handleResetFlybyDates}
          onClose={() => setIsSequenceDatesModalOpen(false)}
        />
      )}

      {/* 3-Instance Debug Plot Modal opened on row click */}
      {selected3InstanceData && (
        <FlybyDebugPlotModal
          initialData={selected3InstanceData.plotData}
          seqPorkchop={selected3InstanceData.row.sub3Seq || {
            id: `seq-pc-${selected3InstanceData.row.prevBodyName}-${selected3InstanceData.row.bodyName}-${selected3InstanceData.row.nextBodyName}`,
            sequenceLabel: `${selected3InstanceData.row.prevBodyName} ➔ ${selected3InstanceData.row.bodyName} ➔ ${selected3InstanceData.row.nextBodyName}`,
            isFullPath: false,
            instanceCount: 3,
            sourceBody: data.pathInsts[selected3InstanceData.row.instanceIndex - 1] || {
              id: `inst-${selected3InstanceData.row.prevBodyName}`,
              bodyName: selected3InstanceData.row.prevBodyName,
              label: selected3InstanceData.row.prevBodyName,
              x: 0,
              y: 0,
            },
            targetBody: data.pathInsts[selected3InstanceData.row.instanceIndex + 1] || {
              id: `inst-${selected3InstanceData.row.nextBodyName}`,
              bodyName: selected3InstanceData.row.nextBodyName,
              label: selected3InstanceData.row.nextBodyName,
              x: 0,
              y: 0,
            },
            //depDates: selected3InstanceData.plotData.depDates || [selected3InstanceData.row.prevFlybyOrDepDate],
            //arrDates: selected3InstanceData.plotData.arrDates || [selected3InstanceData.row.nextFlybyOrArrDate],
            depDates: [selected3InstanceData.row.prevFlybyOrDepDate],
            arrDates: [selected3InstanceData.row.nextFlybyOrArrDate],
            flybys: [{
              instance: data.pathInsts[selected3InstanceData.row.instanceIndex] || {
                id: `inst-${selected3InstanceData.row.bodyName}`,
                bodyName: selected3InstanceData.row.bodyName,
                label: selected3InstanceData.row.bodyName,
                x: 0,
                y: 0,
              },
              poweredDvMatrix: [],
              c3ArrMatrix: [],
              c3DepMatrix: [],
              dateMatrix: [],
            }],
            flightTimeMatrix: [],
            physicalValidMatrix: [],
            constraintValidMatrix: [],
            totalPoweredDvMatrix: [],
            c3DepMatrix: [],
            c3ArrMatrix: [],
            computedSamples: 0,
            totalSamples: 0,
          }}
          porkchops={porkchops}
          links={links}
          bodies={bodies}
          mainBody={mainBody}
          timeFormatMode={timeFormatMode}
          onClose={() => setSelected3InstanceData(null)}
          onRecomputePoint={onRecomputePoint}
        />
      )}
    </div>
  );
};

