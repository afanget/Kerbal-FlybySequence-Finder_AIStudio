/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { FlyableSequenceResult, ResultTableColumn, ResultTableColumnKey, CelestialBody, PorkchopPlotData, SequencePorkchopData, DirectionalLink, InstanceNode } from '../types';
import { formatUT, formatShortUT, formatDuration, daysToSeconds } from '../utils/timeFormat';
import { computeStochasticDvForFlyby, debugStochasticDvCalculation, StochasticDvDebugInfo, recomputeFlybyDetailsSequentially, SequentialFlybyDebugInfo } from '../physics/flyby';
import { getBodyStateAtUT, getGravitationalParameter, stateToOrbitalElements, Vector3D } from '../physics/kepler';
import { SolarSystemTrajectoryView } from './SolarSystemTrajectoryView';
import * as XLSX from 'xlsx';
import { Download, ArrowUpDown, ChevronLeft, ChevronRight, Eye, ShieldCheck, Sliders, SlidersHorizontal, RefreshCw, Terminal, CheckCircle2, XCircle, Compass, Activity, Plus, Trash2, ArrowUp, ArrowDown, Layers, ListFilter, X, ChevronUp, ChevronDown } from 'lucide-react';

export interface SortRule {
  id: string;
  key: ResultTableColumnKey;
  direction: 'asc' | 'desc';
}

interface ResultsTableProps {
  results: FlyableSequenceResult[];
  timeFormatMode: 'ksp' | 'earth';
  onSearchSequences: () => void;
  onSearchSequencesAlt?: () => void;
  onStopSearch?: () => void;
  onRemoveResult?: (seqId: string) => void;
  onClearResults?: () => void;
  isSearching: boolean;
  searchStatusText?: string;
  bodies?: CelestialBody[];
  mainBody?: CelestialBody;
  porkchops?: Record<string, PorkchopPlotData>;
  sequencePorkchops?: Record<string, SequencePorkchopData>;
  onOpenSequencePorkchop?: (seqPcId: string) => void;
  links?: DirectionalLink[];
  instances?: InstanceNode[];
}

const DEFAULT_COLUMNS: ResultTableColumn[] = [
  { key: 'sequence', label: 'Flyby Sequence Path', visible: true },
  { key: 'depDate', label: 'Departure Date', visible: true },
  { key: 'arrDate', label: 'Arrival Date', visible: true },
  { key: 'flightTime', label: 'Total Flight Time', visible: true },
  { key: 'depC3', label: 'Departure C3 (km²/s²)', visible: true },
  { key: 'arrC3', label: 'Arrival C3 (km²/s²)', visible: true },
  { key: 'totalStochasticDv', label: 'Stochastic Δv (m/s)', visible: true },
  { key: 'c3PlusStochDv2', label: 'Sum C3 + Stoch Δv² (km²/s²)', visible: true },
  { key: 'flybyHeight', label: 'Flyby Height', visible: true },
  { key: 'flybyDeflection', label: 'Flyby Deflection Angle (°)', visible: true },
  { key: 'flybyC3', label: 'Flyby C3 (km²/s²)', visible: true },
];

export const ResultsTable: React.FC<ResultsTableProps> = ({
  results,
  timeFormatMode,
  onSearchSequences,
  onSearchSequencesAlt,
  onStopSearch,
  onRemoveResult,
  onClearResults,
  isSearching,
  searchStatusText,
  bodies = [],
  mainBody,
  porkchops,
  sequencePorkchops,
  onOpenSequencePorkchop,
  links,
  instances,
}) => {
  const [columns, setColumns] = useState<ResultTableColumn[]>(DEFAULT_COLUMNS);
  const [sortRules, setSortRules] = useState<SortRule[]>([
    { id: 'rule-1', key: 'c3PlusStochDv2', direction: 'asc' }
  ]);
  const [isSortPanelOpen, setIsSortPanelOpen] = useState<boolean>(false);
  const [expandedSeqId, setExpandedSeqId] = useState<string | null>(null);
  const [selectedPathFilter, setSelectedPathFilter] = useState<string>('ALL');
  const [selectedInstanceFilter, setSelectedInstanceFilter] = useState<string>('ALL');

  const groupedSequencePorkchops = useMemo(() => {
    if (!sequencePorkchops) return {};
    const groups: Record<number, SequencePorkchopData[]> = {};
    (Object.values(sequencePorkchops) as SequencePorkchopData[]).forEach(seqPc => {
      const parts = seqPc.sequenceLabel.split(/➔|->|→/).map(s => s.trim()).filter(Boolean);
      const count = parts.length > 0 ? parts.length : (seqPc.is4Body ? 4 : 3);
      if (!groups[count]) {
        groups[count] = [];
      }
      groups[count].push(seqPc);
    });
    return groups;
  }, [sequencePorkchops]);

  const instanceCounts = useMemo(() => {
    return Object.keys(groupedSequencePorkchops).map(Number).sort((a, b) => a - b);
  }, [groupedSequencePorkchops]);

  const uniqueSequencePaths = useMemo(() => {
    const set = new Set<string>();
    results.forEach(r => set.add(r.bodyNames.join(' ➔ ')));
    return Array.from(set);
  }, [results]);

  // Multi-level sort rule management helpers
  const handleAddSortRule = () => {
    const usedKeys = new Set(sortRules.map(r => r.key));
    const availableCol = DEFAULT_COLUMNS.find(c => !usedKeys.has(c.key)) || DEFAULT_COLUMNS[0];
    setSortRules(prev => [
      ...prev,
      { id: `rule-${Date.now()}-${Math.random()}`, key: availableCol.key, direction: 'asc' }
    ]);
  };

  const handleRemoveSortRule = (id: string) => {
    if (sortRules.length <= 1) return; // Keep at least 1 rule
    setSortRules(prev => prev.filter(r => r.id !== id));
  };

  const handleUpdateSortRule = (id: string, updates: Partial<SortRule>) => {
    setSortRules(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const handleMoveSortRule = (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= sortRules.length) return;
    const copy = [...sortRules];
    const temp = copy[index];
    copy[index] = copy[targetIdx];
    copy[targetIdx] = temp;
    setSortRules(copy);
  };

  const handleResetSortRules = () => {
    setSortRules([{ id: 'rule-1', key: 'c3PlusStochDv2', direction: 'asc' }]);
  };

  const handleHeaderSortClick = (key: ResultTableColumnKey, event: React.MouseEvent) => {
    if (event.shiftKey) {
      // Shift-click: Append column as next sort level, or toggle if already present
      const existingIdx = sortRules.findIndex(r => r.key === key);
      if (existingIdx >= 0) {
        const curr = sortRules[existingIdx];
        handleUpdateSortRule(curr.id, { direction: curr.direction === 'asc' ? 'desc' : 'asc' });
      } else {
        setSortRules(prev => [...prev, { id: `rule-${Date.now()}`, key, direction: 'asc' }]);
      }
    } else {
      // Normal click: Set as primary sort rule, or toggle if already primary
      if (sortRules.length > 0 && sortRules[0].key === key) {
        handleUpdateSortRule(sortRules[0].id, { direction: sortRules[0].direction === 'asc' ? 'desc' : 'asc' });
      } else {
        setSortRules([{ id: `rule-${Date.now()}`, key, direction: 'asc' }]);
      }
    }
  };

  // Pre-flyby position & speed error parameters (default 10 km and 1.0 m/s)
  const [stochasticAltErrorKm, setStochasticAltErrorKm] = useState<number>(10);
  const [stochasticVelErrorMs, setStochasticVelErrorMs] = useState<number>(1.0);

  // Debug state for user trigger on specific sequence lines
  const [debugLogMap, setDebugLogMap] = useState<Record<string, StochasticDvDebugInfo[]>>({});
  const [sequentialFlybyDebugMap, setSequentialFlybyDebugMap] = useState<Record<string, SequentialFlybyDebugInfo[]>>({});
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleRecomputeFlybys = (seq: FlyableSequenceResult) => {
    const altErrMeters = Math.max(0, stochasticAltErrorKm * 1000);
    const velErrMs = Math.max(0, stochasticVelErrorMs);

    const mBody = mainBody || bodies[0];
    if (!mBody) return;

    const flybySampling = seq.flybys[0]?.flybyDateSampling || 86400;
    const flybyDebugs = recomputeFlybyDetailsSequentially(
      seq,
      bodies,
      mBody,
      altErrMeters,
      velErrMs,
      flybySampling,
      porkchops,
      links,
      instances
    );
    setSequentialFlybyDebugMap(prev => ({ ...prev, [seq.id]: flybyDebugs }));
    setExpandedSeqId(seq.id);

    console.log(`[DEBUG RECOMPUTE FLYBYS] Sequence ${seq.bodyNames.join(' -> ')}:`, flybyDebugs);

    setToastMessage(`Recomputed flybys sequentially for ${seq.bodyNames.join(' ➔ ')} (${flybyDebugs.length} flyby bodies evaluated)`);
    setTimeout(() => setToastMessage(null), 4500);
  };

  // Column reordering helper: move column left/right
  const moveColumn = (index: number, direction: 'left' | 'right') => {
    const newCols = [...columns];
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= newCols.length) return;
    const temp = newCols[index];
    newCols[index] = newCols[targetIndex];
    newCols[targetIndex] = temp;
    setColumns(newCols);
  };

  // Toggle column visibility
  const toggleColumnVisible = (key: ResultTableColumnKey) => {
    setColumns(cols => cols.map(c => c.key === key ? { ...c, visible: !c.visible } : c));
  };

  // Recompute stochastic Δv and totals reactively when error parameters change without re-running sequence search
  const recomputedResults = useMemo(() => {
    const altErrMeters = Math.max(0, stochasticAltErrorKm * 1000);
    const velErrMs = Math.max(0, stochasticVelErrorMs);

    return results.map(seq => {
      let updatedTotalStochDv = 0;
      const updatedFlybys = seq.flybys.map(f => {
        const body = bodies.find(b => b.name === f.bodyName);
        const newStochDv = computeStochasticDvForFlyby(f, body, altErrMeters, velErrMs);
        updatedTotalStochDv += newStochDv;
        return {
          ...f,
          stochasticDv: newStochDv
        };
      });

      return {
        ...seq,
        totalStochasticDv: updatedTotalStochDv,
        flybys: updatedFlybys
      };
    });
  }, [results, stochasticAltErrorKm, stochasticVelErrorMs, bodies]);

  // Multi-Column Sorting Logic
  const sortedResults = useMemo(() => {
    return [...recomputedResults].sort((a, b) => {
      if (sortRules.length === 0) return 0;

      for (const rule of sortRules) {
        let valA: any = 0;
        let valB: any = 0;

        switch (rule.key) {
          case 'sequence':
            valA = a.bodyNames.join('->');
            valB = b.bodyNames.join('->');
            break;
          case 'depDate':
            valA = a.depDate;
            valB = b.depDate;
            break;
          case 'arrDate':
            valA = a.arrDate;
            valB = b.arrDate;
            break;
          case 'flightTime':
            valA = a.totalFlightTime;
            valB = b.totalFlightTime;
            break;
          case 'depC3':
            valA = a.depC3;
            valB = b.depC3;
            break;
          case 'arrC3':
            valA = a.arrC3;
            valB = b.arrC3;
            break;
          case 'totalStochasticDv':
            valA = a.totalStochasticDv;
            valB = b.totalStochasticDv;
            break;
          case 'c3PlusStochDv2':
            valA = a.depC3 + a.arrC3 + (a.totalStochasticDv / 1000) ** 2;
            valB = b.depC3 + b.arrC3 + (b.totalStochasticDv / 1000) ** 2;
            break;
          case 'flybyHeight':
            valA = a.flybys[0]?.periapsisAlt ?? -Infinity;
            valB = b.flybys[0]?.periapsisAlt ?? -Infinity;
            break;
          case 'flybyDeflection':
            valA = a.flybys[0]?.deflectionAngle ?? -Infinity;
            valB = b.flybys[0]?.deflectionAngle ?? -Infinity;
            break;
          case 'flybyC3':
            valA = a.flybys[0] ? (a.flybys[0].vInfInMag / 1000) ** 2 : -Infinity;
            valB = b.flybys[0] ? (b.flybys[0].vInfInMag / 1000) ** 2 : -Infinity;
            break;
        }

        if (typeof valA === 'number' && typeof valB === 'number') {
          const diff = valA - valB;
          if (Math.abs(diff) > 1e-6) {
            return rule.direction === 'asc' ? (diff < 0 ? -1 : 1) : (diff > 0 ? -1 : 1);
          }
        } else {
          if (valA < valB) return rule.direction === 'asc' ? -1 : 1;
          if (valA > valB) return rule.direction === 'asc' ? 1 : -1;
        }
      }

      return 0;
    });
  }, [recomputedResults, sortRules]);

  const filteredResults = useMemo(() => {
    if (selectedPathFilter === 'ALL') return sortedResults;
    return sortedResults.filter(r => r.bodyNames.join(' ➔ ') === selectedPathFilter);
  }, [sortedResults, selectedPathFilter]);

  // Export Results to ODS format
  const exportToODS = () => {
    if (results.length === 0) {
      alert('No flyable sequences available to export.');
      return;
    }

    const exportRows = filteredResults.map((seq, idx) => {
      const isLongFlight = seq.totalFlightTime > daysToSeconds(10, timeFormatMode);
      const depCal = isLongFlight ? formatShortUT(seq.depDate, timeFormatMode) : formatUT(seq.depDate, timeFormatMode);
      const arrCal = isLongFlight ? formatShortUT(seq.arrDate, timeFormatMode) : formatUT(seq.arrDate, timeFormatMode);

      const flybyHeights = seq.flybys.length > 0
        ? seq.flybys.map(f => `${seq.flybys.length > 1 ? f.bodyName + ': ' : ''}${(f.periapsisAlt / 1000).toFixed(0)} km`).join('; ')
        : 'N/A';
      const flybyDeflections = seq.flybys.length > 0
        ? seq.flybys.map(f => `${seq.flybys.length > 1 ? f.bodyName + ': ' : ''}${f.deflectionAngle.toFixed(1)}°`).join('; ')
        : 'N/A';
      const flybyC3s = seq.flybys.length > 0
        ? seq.flybys.map(f => `${seq.flybys.length > 1 ? f.bodyName + ': ' : ''}${((f.vInfInMag / 1000) ** 2).toFixed(2)} km²/s²`).join('; ')
        : 'N/A';

      const sumC3Stoch = seq.depC3 + seq.arrC3 + (seq.totalStochasticDv / 1000) ** 2;

      return {
        'Index': idx + 1,
        'Sequence Path': seq.bodyNames.join(' -> '),
        'Departure Date (UT s)': Math.round(seq.depDate),
        'Departure Date (Calendar)': depCal,
        'Arrival Date (UT s)': Math.round(seq.arrDate),
        'Arrival Date (Calendar)': arrCal,
        'Flight Duration': formatDuration(seq.totalFlightTime, timeFormatMode),
        'Departure C3 (km²/s²)': seq.depC3.toFixed(2),
        'Arrival C3 (km²/s²)': seq.arrC3.toFixed(2),
        'Stochastic Δv (m/s)': seq.totalStochasticDv.toFixed(1),
        'Sum C3 + Stoch Δv² (km²/s²)': sumC3Stoch.toFixed(3),
        'Flyby Height': flybyHeights,
        'Flyby Deflection Angle (°)': flybyDeflections,
        'Flyby C3 (km²/s²)': flybyC3s
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(exportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Flyby Sequences');

    XLSX.writeFile(workbook, `KSP_Flyby_Sequences_${Date.now()}.ods`, { bookType: 'ods' });
  };

  return (
    <div id="results-section" className="bg-[#1A1B1E] border border-[#2D2E33] rounded-lg p-5 shadow-2xl flex flex-col gap-4 text-[#E2E8F0] w-full min-w-full">
      {/* Toast Notification for Debug Trigger */}
      {toastMessage && (
        <div className="bg-amber-500/20 border border-amber-500/50 text-amber-200 px-4 py-2.5 rounded text-xs font-mono flex items-center gap-2 animate-fade-in shadow-md">
          <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Search Button & Controls Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#2D2E33] pb-4">
        <div>
          <h2 className="font-serif text-base uppercase tracking-widest text-[#E2E8F0] flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-[#60A5FA]" /> Validated Sequences
          </h2>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Trajectory optimizer searches for valid gravitational assists, Lambert transfers & minimum Δv flyby paths
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search Action or Stop Button */}
          {isSearching ? (
            <button
              id="btn-stop-search"
              onClick={onStopSearch}
              className="flex items-center gap-2 px-5 py-2.5 rounded font-serif text-xs uppercase tracking-widest text-white bg-rose-600 hover:bg-rose-500 border border-rose-400/50 shadow-lg transition active:scale-95 cursor-pointer font-semibold"
              title="Stop current trajectory search and keep all intermediate results"
            >
              <XCircle className="w-4 h-4 text-white flex-shrink-0" />
              <span>Stop Search</span>
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                id="btn-search-sequences"
                onClick={onSearchSequences}
                className="search-btn flex items-center gap-2 px-5 py-2.5 rounded font-serif text-xs uppercase tracking-widest text-white bg-[#334155] hover:bg-[#475569] border border-[#475569] shadow-lg transition active:scale-95 cursor-pointer"
              >
                <span>Search Possible Sequences</span>
              </button>
              {onSearchSequencesAlt && (
                <button
                  id="btn-search-sequences-alt"
                  onClick={onSearchSequencesAlt}
                  className="search-btn-alt flex items-center gap-2 px-5 py-2.5 rounded font-serif text-xs uppercase tracking-widest text-white bg-sky-700 hover:bg-sky-600 border border-sky-500 shadow-lg transition active:scale-95 cursor-pointer font-semibold"
                  title="Direct trajectory search & optimization without grid pruning. Sorted by sum(C3d, C3a, stocDv²)"
                >
                  <Compass className="w-4 h-4 text-sky-200" />
                  <span>Search possible sequences (another way)</span>
                </button>
              )}
            </div>
          )}

          {/* ODS Export Button */}
          <button
            id="btn-export-ods"
            onClick={exportToODS}
            disabled={results.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2.5 bg-[#25262B] hover:bg-[#2D2E33] text-[#94A3B8] hover:text-[#E2E8F0] border border-[#2D2E33] rounded text-xs font-mono uppercase tracking-wider shadow transition disabled:opacity-40"
            title="Export trajectory results to ODS spreadsheet format"
          >
            <Download className="w-3.5 h-3.5 text-[#60A5FA]" />
            <span>Export ODS</span>
          </button>

          {onClearResults && results.length > 0 && (
            <button
              id="btn-clear-all-results"
              onClick={onClearResults}
              className="flex items-center gap-1.5 px-3.5 py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded text-xs font-mono uppercase tracking-wider shadow transition cursor-pointer"
              title="Clear all search results"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span>Clear All</span>
            </button>
          )}
        </div>
      </div>

      {/* Live Trajectory Search Step Indicator Banner */}
      {isSearching && (
        <div className="bg-[#1E293B]/90 border border-[#38BDF8]/40 p-3.5 rounded flex items-center justify-between gap-3 text-xs text-[#38BDF8] shadow-md">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-4 h-4 border-2 border-[#38BDF8]/30 border-t-[#38BDF8] rounded-full animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="font-semibold uppercase tracking-wider text-[11px] text-[#94A3B8] block">Current Search Step:</span>
              <span className="font-mono text-xs sm:text-sm text-[#E2E8F0] font-medium truncate block">
                {searchStatusText || 'Computing transfers...'}
              </span>
            </div>
          </div>
          {onStopSearch && (
            <button
              onClick={onStopSearch}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-rose-600/90 hover:bg-rose-500 text-white rounded text-xs font-semibold uppercase tracking-wider transition shadow flex-shrink-0 cursor-pointer"
              title="Stop trajectory search"
            >
              <XCircle className="w-3.5 h-3.5" /> Stop Search
            </button>
          )}
        </div>
      )}

      {/* Pre-Flyby Position & Speed Error Controls */}
      <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-[#60A5FA]" />
          <span className="font-semibold text-[#E2E8F0] uppercase tracking-wider text-[11px]">
            Pre-Flyby Navigation Error Parameters
          </span>
          <span className="text-[#94A3B8] text-[11px] hidden sm:inline">
            (Updates stochastic Δv & C3 sum instantly without re-searching)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 font-mono text-xs">
          <div className="flex items-center gap-2">
            <label className="text-[#94A3B8] font-sans">Position Error:</label>
            <div className="flex items-center bg-[#1A1B1E] border border-[#2D2E33] rounded px-2.5 py-1">
              <input
                id="input-pos-error"
                type="number"
                min="0"
                max="100000"
                step="1"
                value={stochasticAltErrorKm}
                onChange={(e) => setStochasticAltErrorKm(parseFloat(e.target.value) || 0)}
                className="w-16 bg-transparent text-[#60A5FA] font-bold text-right outline-none"
              />
              <span className="text-[#64748B] ml-1">km</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[#94A3B8] font-sans">Speed Error:</label>
            <div className="flex items-center bg-[#1A1B1E] border border-[#2D2E33] rounded px-2.5 py-1">
              <input
                id="input-speed-error"
                type="number"
                min="0"
                max="1000"
                step="0.1"
                value={stochasticVelErrorMs}
                onChange={(e) => setStochasticVelErrorMs(parseFloat(e.target.value) || 0)}
                className="w-16 bg-transparent text-[#60A5FA] font-bold text-right outline-none"
              />
              <span className="text-[#64748B] ml-1">m/s</span>
            </div>
          </div>
        </div>
      </div>

      {/* Separated Sequence Porkchops Banners by Instance Count */}
      {instanceCounts.length > 0 && (
        <div className="flex flex-col gap-3">
          {/* Instance Count Filter Bar when multiple counts exist */}
          {instanceCounts.length > 1 && (
            <div className="bg-[#25262B] px-3 py-2 rounded border border-[#2D2E33] flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider">
                <Compass className="w-4 h-4 text-[#38BDF8]" />
                <span>Sequence Porkchops by Length</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setSelectedInstanceFilter('ALL')}
                  className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition cursor-pointer ${
                    selectedInstanceFilter === 'ALL'
                      ? 'bg-[#38BDF8] text-black font-bold'
                      : 'bg-[#1A1B1E] text-[#94A3B8] hover:text-white border border-[#2D2E33]'
                  }`}
                >
                  All ({Object.keys(sequencePorkchops!).length})
                </button>
                {instanceCounts.map(count => (
                  <button
                    key={count}
                    onClick={() => setSelectedInstanceFilter(String(count))}
                    className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition cursor-pointer ${
                      selectedInstanceFilter === String(count)
                        ? 'bg-[#38BDF8] text-black font-bold'
                        : 'bg-[#1A1B1E] text-[#94A3B8] hover:text-white border border-[#2D2E33]'
                    }`}
                  >
                    {count}-Instance ({groupedSequencePorkchops[count].length})
                  </button>
                ))}
              </div>
            </div>
          )}

          {instanceCounts
            .filter(count => selectedInstanceFilter === 'ALL' || selectedInstanceFilter === String(count))
            .map(count => {
              const plots = groupedSequencePorkchops[count];
              return (
                <div key={count} className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-col gap-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider">
                      <Compass className="w-4 h-4 text-[#38BDF8]" />
                      <span>{count}-Instance Sequence Porkchops</span>
                    </div>
                    <span className="text-[11px] font-mono text-[#94A3B8]">
                      {plots.length} plot(s) available
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {plots.map(seqPc => (
                      <button
                        key={seqPc.id}
                        onClick={() => onOpenSequencePorkchop?.(seqPc.id)}
                        className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#1E293B] hover:bg-[#334155] border border-[#38BDF8]/40 text-[#38BDF8] transition text-xs font-mono font-medium shadow-sm cursor-pointer"
                      >
                        <Activity className="w-3.5 h-3.5" />
                        <span>{seqPc.sequenceLabel} Porkchop Plot</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Sequence Path Filter (if multiple distinct paths exist) */}
      {uniqueSequencePaths.length > 1 && (
        <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <Compass className="w-4 h-4 text-[#38BDF8]" />
            <span className="font-semibold text-[#E2E8F0] uppercase tracking-wider text-[11px]">
              Sequence Path Filter:
            </span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedPathFilter}
              onChange={(e) => setSelectedPathFilter(e.target.value)}
              className="bg-[#1A1B1E] border border-[#2D2E33] text-[#38BDF8] rounded px-3 py-1.5 text-xs font-mono font-bold focus:outline-none focus:border-[#38BDF8]"
            >
              <option value="ALL">All Sequence Paths ({results.length} total solutions)</option>
              {uniqueSequencePaths.map(pathStr => {
                const count = results.filter(r => r.bodyNames.join(' ➔ ') === pathStr).length;
                return (
                  <option key={pathStr} value={pathStr}>
                    {pathStr} ({count} solution{count === 1 ? '' : 's'})
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      {/* Column Reordering, Visibility Controls, & Multi-Level Sort Rules */}
      <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium text-[#94A3B8] uppercase text-[11px] tracking-wider">Customize Columns:</span>
          <div className="flex flex-wrap gap-1.5">
            {columns.map((col, idx) => (
              <div key={col.key} className="flex items-center bg-[#1A1B1E] border border-[#2D2E33] rounded px-2 py-1 text-[11px]">
                <button
                  onClick={() => moveColumn(idx, 'left')}
                  disabled={idx === 0}
                  className="p-0.5 hover:text-[#60A5FA] disabled:opacity-30"
                >
                  <ChevronLeft className="w-3 h-3" />
                </button>
                <button
                  onClick={() => toggleColumnVisible(col.key)}
                  className={`mx-1 font-mono ${col.visible ? 'text-[#60A5FA]' : 'text-[#64748B] line-through'}`}
                >
                  {col.label}
                </button>
                <button
                  onClick={() => moveColumn(idx, 'right')}
                  disabled={idx === columns.length - 1}
                  className="p-0.5 hover:text-[#60A5FA] disabled:opacity-30"
                >
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Multi-Column Sort Toggle Button */}
        <button
          id="btn-toggle-sort-rules"
          onClick={() => setIsSortPanelOpen(!isSortPanelOpen)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded font-mono text-xs border transition cursor-pointer shadow-sm ${
            isSortPanelOpen || sortRules.length > 1
              ? 'bg-[#1E293B] border-[#38BDF8] text-[#38BDF8] font-bold'
              : 'bg-[#1A1B1E] border-[#2D2E33] text-[#94A3B8] hover:text-white hover:border-[#475569]'
          }`}
          title="Configure multi-column sorting rules"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-[#38BDF8]" />
          <span>Multi-Column Sort Rules</span>
          <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-[#38BDF8]/20 text-[#38BDF8] font-bold border border-[#38BDF8]/30">
            {sortRules.length} level{sortRules.length === 1 ? '' : 's'}
          </span>
        </button>
      </div>

      {/* Multi-Level Sort Rules Management Panel */}
      {isSortPanelOpen && (
        <div className="bg-[#1A1B1E] p-4 rounded border-2 border-[#38BDF8]/60 flex flex-col gap-3 shadow-xl text-xs animate-fadeIn">
          <div className="flex items-center justify-between border-b border-[#2D2E33] pb-2.5">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-[#38BDF8]" />
              <span className="font-bold text-white text-sm tracking-wide">
                Multi-Level Sorting Rules
              </span>
              <span className="text-[11px] text-[#94A3B8] font-sans">
                (Sorts by Rule 1, then if equal sorts by Rule 2, and so on)
              </span>
            </div>
            <button
              onClick={() => setIsSortPanelOpen(false)}
              className="p-1 rounded text-[#94A3B8] hover:text-white hover:bg-[#25262B]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {sortRules.map((rule, index) => {
              const ruleCol = DEFAULT_COLUMNS.find(c => c.key === rule.key);
              return (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-2 bg-[#25262B] p-2.5 rounded border border-[#2D2E33]"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-[11px] px-2 py-1 rounded bg-[#1A1B1E] text-[#38BDF8] border border-[#38BDF8]/30 w-28 text-center">
                      {index === 0 ? '1st (Primary)' : `${index + 1}nd (Then by)`}
                    </span>

                    {/* Column Selection Dropdown */}
                    <select
                      value={rule.key}
                      onChange={(e) => handleUpdateSortRule(rule.id, { key: e.target.value as ResultTableColumnKey })}
                      className="bg-[#1A1B1E] border border-[#2D2E33] text-white rounded px-3 py-1.5 text-xs font-medium focus:outline-none focus:border-[#38BDF8] min-w-[200px]"
                    >
                      {DEFAULT_COLUMNS.map(col => (
                        <option key={col.key} value={col.key}>
                          {col.label}
                        </option>
                      ))}
                    </select>

                    {/* Order Direction Select */}
                    <div className="flex items-center bg-[#1A1B1E] border border-[#2D2E33] rounded overflow-hidden">
                      <button
                        onClick={() => handleUpdateSortRule(rule.id, { direction: 'asc' })}
                        className={`flex items-center gap-1 px-3 py-1 text-xs font-medium transition ${
                          rule.direction === 'asc'
                            ? 'bg-[#38BDF8] text-[#0F172A] font-bold'
                            : 'text-[#94A3B8] hover:text-white'
                        }`}
                      >
                        <ArrowUp className="w-3 h-3" />
                        <span>Ascending (Low ➔ High)</span>
                      </button>
                      <button
                        onClick={() => handleUpdateSortRule(rule.id, { direction: 'desc' })}
                        className={`flex items-center gap-1 px-3 py-1 text-xs font-medium transition ${
                          rule.direction === 'desc'
                            ? 'bg-[#38BDF8] text-[#0F172A] font-bold'
                            : 'text-[#94A3B8] hover:text-white'
                        }`}
                      >
                        <ArrowDown className="w-3 h-3" />
                        <span>Descending (High ➔ Low)</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {/* Move Up / Down */}
                    <button
                      onClick={() => handleMoveSortRule(index, 'up')}
                      disabled={index === 0}
                      className="p-1.5 rounded bg-[#1A1B1E] border border-[#2D2E33] text-[#94A3B8] hover:text-white disabled:opacity-30 cursor-pointer"
                      title="Move rule priority up"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleMoveSortRule(index, 'down')}
                      disabled={index === sortRules.length - 1}
                      className="p-1.5 rounded bg-[#1A1B1E] border border-[#2D2E33] text-[#94A3B8] hover:text-white disabled:opacity-30 cursor-pointer"
                      title="Move rule priority down"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>

                    {/* Remove Rule */}
                    <button
                      onClick={() => handleRemoveSortRule(rule.id)}
                      disabled={sortRules.length <= 1}
                      className="p-1.5 rounded bg-[#1A1B1E] border border-[#2D2E33] text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 disabled:opacity-30 cursor-pointer ml-2"
                      title="Remove this sort level"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#2D2E33]">
            <div className="flex items-center gap-2">
              <button
                onClick={handleAddSortRule}
                disabled={sortRules.length >= DEFAULT_COLUMNS.length}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#38BDF8]/10 hover:bg-[#38BDF8]/20 text-[#38BDF8] border border-[#38BDF8]/30 text-xs font-bold transition cursor-pointer disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Sort Level</span>
              </button>

              <button
                onClick={handleResetSortRules}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#25262B] hover:bg-[#334155] text-[#94A3B8] border border-[#2D2E33] text-xs font-medium transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reset Rules</span>
              </button>
            </div>

            <span className="text-[11px] text-[#64748B] font-mono italic">
              Tip: Hold Shift and click column headers in table to append new sort levels directly!
            </span>
          </div>
        </div>
      )}

      {/* Results Table */}
      <div className="w-full min-w-full rounded border border-[#2D2E33]">
        <table id="results-table" className="w-full min-w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-[#1A1B1E] text-[#94A3B8] font-semibold uppercase text-[10px] tracking-wider border-b-2 border-[#2D2E33]">
              <th className="p-3 text-center w-12">#</th>
              {columns.filter(c => c.visible).map(col => {
                const sortRuleIndex = sortRules.findIndex(r => r.key === col.key);
                const activeRule = sortRuleIndex >= 0 ? sortRules[sortRuleIndex] : null;

                return (
                  <th
                    key={col.key}
                    onClick={(e) => handleHeaderSortClick(col.key, e)}
                    className={`p-3 cursor-pointer transition select-none ${
                      activeRule ? 'bg-[#1E293B] text-[#38BDF8]' : 'hover:bg-[#25262B]'
                    }`}
                    title="Click to set primary sort, Shift-Click to add secondary sort rule"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>{col.label}</span>
                      {activeRule ? (
                        <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#38BDF8]/20 text-[#38BDF8] border border-[#38BDF8]/40 shadow-sm">
                          #{sortRuleIndex + 1} {activeRule.direction === 'asc' ? '▲' : '▼'}
                        </span>
                      ) : (
                        <ArrowUpDown className="w-3 h-3 text-[#64748B]" />
                      )}
                    </div>
                  </th>
                );
              })}
              <th className="p-3 text-right">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2D2E33] font-mono">
            {filteredResults.length > 0 ? (
              filteredResults.map((seq, index) => {
                const isExpanded = expandedSeqId === seq.id;
                const isLongFlight = seq.totalFlightTime > daysToSeconds(10, timeFormatMode);
                const sumC3Stoch = seq.depC3 + seq.arrC3 + (seq.totalStochasticDv / 1000) ** 2;

                return (
                  <React.Fragment key={seq.id}>
                    <tr className="hover:bg-[#25262B]/50 transition group">
                      <td className="p-3 text-center text-[#64748B] font-bold">{index + 1}</td>

                      {columns.filter(c => c.visible).map(col => {
                        switch (col.key) {
                          case 'sequence':
                            return (
                              <td key={col.key} className="p-3 font-semibold text-[#60A5FA]">
                                {seq.bodyNames.join(' ➔ ')}
                              </td>
                            );
                          case 'depDate':
                            return (
                              <td key={col.key} className="p-3 text-[#E2E8F0]">
                                {isLongFlight ? formatShortUT(seq.depDate, timeFormatMode) : formatUT(seq.depDate, timeFormatMode)}
                              </td>
                            );
                          case 'arrDate':
                            return (
                              <td key={col.key} className="p-3 text-[#E2E8F0]">
                                {isLongFlight ? formatShortUT(seq.arrDate, timeFormatMode) : formatUT(seq.arrDate, timeFormatMode)}
                              </td>
                            );
                          case 'flightTime':
                            return (
                              <td key={col.key} className="p-3 text-[#60A5FA] font-bold">
                                {formatDuration(seq.totalFlightTime, timeFormatMode)}
                              </td>
                            );
                          case 'depC3':
                            return (
                              <td key={col.key} className="p-3 text-[#94A3B8]">
                                {seq.depC3.toFixed(2)}
                              </td>
                            );
                          case 'arrC3':
                            return (
                              <td key={col.key} className="p-3 text-[#94A3B8]">
                                {seq.arrC3.toFixed(2)}
                              </td>
                            );
                          case 'totalStochasticDv':
                            return (
                              <td key={col.key} className="p-3 font-bold">
                                {seq.totalStochasticDv > 0 ? (
                                  <span className="text-amber-400">{seq.totalStochasticDv.toFixed(1)} m/s</span>
                                ) : (
                                  <span className="text-[#60A5FA]">0 m/s (Pure Assist)</span>
                                )}
                              </td>
                            );
                          case 'c3PlusStochDv2':
                            return (
                              <td key={col.key} className="p-3 font-bold text-[#38BDF8]">
                                {sumC3Stoch.toFixed(3)}
                              </td>
                            );
                          case 'flybyHeight':
                            return (
                              <td key={col.key} className="p-3 text-[#94A3B8]">
                                {seq.flybys.length > 0 ? (
                                  seq.flybys.map((f, fIdx) => (
                                    <div key={fIdx}>
                                      {seq.flybys.length > 1 && <span className="text-[#64748B] text-[10px] mr-1">{f.bodyName}:</span>}
                                      {(f.periapsisAlt / 1000).toFixed(0)} km
                                    </div>
                                  ))
                                ) : (
                                  <span className="text-[#64748B]">-</span>
                                )}
                              </td>
                            );
                          case 'flybyDeflection':
                            return (
                              <td key={col.key} className="p-3 text-[#94A3B8]">
                                {seq.flybys.length > 0 ? (
                                  seq.flybys.map((f, fIdx) => (
                                    <div key={fIdx}>
                                      {seq.flybys.length > 1 && <span className="text-[#64748B] text-[10px] mr-1">{f.bodyName}:</span>}
                                      {f.deflectionAngle.toFixed(1)}°
                                    </div>
                                  ))
                                ) : (
                                  <span className="text-[#64748B]">-</span>
                                )}
                              </td>
                            );
                          case 'flybyC3':
                            return (
                              <td key={col.key} className="p-3 text-[#94A3B8]">
                                {seq.flybys.length > 0 ? (
                                  seq.flybys.map((f, fIdx) => {
                                    const c3 = (f.vInfInMag / 1000) ** 2;
                                    return (
                                      <div key={fIdx}>
                                        {seq.flybys.length > 1 && <span className="text-[#64748B] text-[10px] mr-1">{f.bodyName}:</span>}
                                        {c3.toFixed(2)} km²/s²
                                      </div>
                                    );
                                  })
                                ) : (
                                  <span className="text-[#64748B]">-</span>
                                )}
                              </td>
                            );
                          default:
                            return null;
                        }
                      })}

                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            id={`btn-recompute-flybys-${seq.id}`}
                            onClick={() => handleRecomputeFlybys(seq)}
                            className="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 rounded text-[11px] font-sans flex items-center gap-1 border border-amber-500/30 transition shadow-sm cursor-pointer"
                            title="Sequentially recall computeUnpoweredflyby for each flyby body in this sequence"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Recompute Flybys</span>
                          </button>
                          <button
                            onClick={() => setExpandedSeqId(isExpanded ? null : seq.id)}
                            className="px-2.5 py-1 bg-[#25262B] hover:bg-[#2D2E33] text-[#60A5FA] rounded text-[11px] font-sans flex items-center gap-1 border border-[#2D2E33] cursor-pointer"
                          >
                            <Eye className="w-3 h-3" />
                            <span>{isExpanded ? 'Hide' : 'Expand'}</span>
                          </button>
                          {onRemoveResult && (
                            <button
                              id={`btn-remove-solution-${seq.id}`}
                              onClick={() => onRemoveResult(seq.id)}
                              className="px-2 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 rounded text-[11px] font-sans flex items-center gap-1 border border-rose-500/30 transition shadow-sm cursor-pointer"
                              title="Manually remove this trajectory solution"
                            >
                              <Trash2 className="w-3 h-3 text-rose-400" />
                              <span>Remove</span>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>

                    {/* Expanded Detailed Breakdown Row */}
                    {isExpanded && (
                      <tr className="bg-[#1A1B1E]">
                        <td colSpan={columns.filter(c => c.visible).length + 2} className="p-4 space-y-4">
                          {/* Solar System Trajectory Visualizer View */}
                          {bodies.length > 0 && mainBody && (
                            <SolarSystemTrajectoryView
                              sequence={seq}
                              bodies={bodies}
                              mainBody={mainBody}
                              timeFormatMode={timeFormatMode}
                            />
                          )}

                          {/* Sequentially Recomputed Flybys Physics Inspector Card */}
                          {sequentialFlybyDebugMap[seq.id] && sequentialFlybyDebugMap[seq.id].length > 0 && (
                            <div className="bg-[#1E2028] border border-amber-500/40 rounded p-4 space-y-3 font-mono text-xs">
                              <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
                                <span className="font-bold text-amber-400 flex items-center gap-2">
                                  <Terminal className="w-4 h-4 text-amber-400" />
                                  Sequential Unpowered Flyby Physics Debug Inspector
                                </span>
                                <span className="text-[10px] text-[#94A3B8]">
                                  Sequence: {seq.bodyNames.join(' ➔ ')}
                                </span>
                              </div>

                              <div className="grid grid-cols-1 gap-3 text-[11px]">
                                {sequentialFlybyDebugMap[seq.id].map((dbg, dIdx) => (
                                  <div key={dIdx} className="bg-[#14151B] p-3 rounded border border-[#2D2E33] space-y-2 text-[#E2E8F0]">
                                    <div className="flex items-center justify-between border-b border-[#2D2E33] pb-1">
                                      <span className="text-amber-300 font-bold text-sm">
                                        Flyby #{dbg.flybyIndex}: {dbg.bodyName}
                                      </span>
                                      <span className="text-[11px] text-[#94A3B8]">
                                        Date: {formatUT(dbg.flybyDate, timeFormatMode)}
                                      </span>
                                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                        dbg.isValid ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                                      }`}>
                                        {dbg.isValid ? '✓ VALID FLYBY' : '✗ INVALID FLYBY'}
                                      </span>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-[11px]">
                                      {/* Transfer & Central Frame Vectors */}
                                      <div className="space-y-1 bg-[#1A1B1E] p-2 rounded border border-[#25262B]">
                                        <div className="text-[#38BDF8] font-bold text-[10px] uppercase">Central Frame Velocities (m/s)</div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Planet V_body:</span>
                                          <span className="font-mono text-[10px] text-[#E2E8F0]">[ {dbg.vBodyVel.x.toFixed(1)}, {dbg.vBodyVel.y.toFixed(1)}, {dbg.vBodyVel.z.toFixed(1)} ]</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Inbound V_trans:</span>
                                          <span className="font-mono text-[10px] text-[#E2E8F0]">[ {dbg.vTransIn.x.toFixed(1)}, {dbg.vTransIn.y.toFixed(1)}, {dbg.vTransIn.z.toFixed(1)} ]</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Outbound V_trans:</span>
                                          <span className="font-mono text-[10px] text-[#E2E8F0]">[ {dbg.vTransOut.x.toFixed(1)}, {dbg.vTransOut.y.toFixed(1)}, {dbg.vTransOut.z.toFixed(1)} ]</span>
                                        </div>
                                      </div>

                                      {/* Hyperbolic V_infinity Vectors */}
                                      <div className="space-y-1 bg-[#1A1B1E] p-2 rounded border border-[#25262B]">
                                        <div className="text-amber-300 font-bold text-[10px] uppercase">Relative V_infinity Sampling (t₁ & t₂)</div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">V_inf In @ t₁ ({dbg.vInfInMag.toFixed(1)} m/s):</span>
                                        </div>
                                        <div className="text-[10px] font-mono text-amber-200 pl-2">
                                          [ {dbg.vInfInVec.x.toFixed(1)}, {dbg.vInfInVec.y.toFixed(1)}, {dbg.vInfInVec.z.toFixed(1)} ]
                                        </div>
                                        <div className="flex justify-between mt-1">
                                          <span className="text-[#94A3B8]">V_inf In @ t₂ (+{dbg.flybyDateSampling / 86400}d):</span>
                                        </div>
                                        <div className="text-[10px] font-mono text-amber-200 pl-2">
                                          [ {dbg.vInfIn2Vec.x.toFixed(1)}, {dbg.vInfIn2Vec.y.toFixed(1)}, {dbg.vInfIn2Vec.z.toFixed(1)} ]
                                        </div>
                                        <div className="flex justify-between mt-1">
                                          <span className="text-[#94A3B8]">V_inf Out @ t₁:</span>
                                        </div>
                                        <div className="text-[10px] font-mono text-amber-200 pl-2">
                                          [ {dbg.vInfOutVec.x.toFixed(1)}, {dbg.vInfOutVec.y.toFixed(1)}, {dbg.vInfOutVec.z.toFixed(1)} ]
                                        </div>
                                        <div className="flex justify-between mt-1">
                                          <span className="text-[#94A3B8]">V_inf Out @ t₂:</span>
                                        </div>
                                        <div className="text-[10px] font-mono text-amber-200 pl-2">
                                          [ {dbg.vInfOut2Vec.x.toFixed(1)}, {dbg.vInfOut2Vec.y.toFixed(1)}, {dbg.vInfOut2Vec.z.toFixed(1)} ]
                                        </div>
                                      </div>

                                      {/* Deflection & Periapsis Geometry */}
                                      <div className="space-y-1 bg-[#1A1B1E] p-2 rounded border border-[#25262B]">
                                        <div className="text-emerald-400 font-bold text-[10px] uppercase">Flyby Hyperbolic Geometry</div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Deflection Angle δ:</span>
                                          <strong className="text-amber-300">{dbg.deflectionAngleDeg.toFixed(2)}°</strong>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Max Allowed δ (rpMin):</span>
                                          <strong className="text-[#38BDF8]">{dbg.maxDeflectionDeg.toFixed(2)}°</strong>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Periapsis Alt:</span>
                                          <strong className="text-[#E2E8F0]">{dbg.periapsisAltKm.toFixed(1)} km</strong>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-[#94A3B8]">Flyby Margin:</span>
                                          <strong className={dbg.flybyMarginKm >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{dbg.flybyMarginKm.toFixed(1)} km</strong>
                                        </div>
                                        <div className="flex justify-between border-t border-[#2D2E33] pt-1">
                                          <span className="text-[#94A3B8]">Stochastic Δv:</span>
                                          <strong className="text-amber-400">{dbg.stochasticDvMs.toFixed(2)} m/s</strong>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="bg-[#25262B] border border-[#2D2E33] rounded p-4 space-y-3 font-sans text-xs">
                            <h4 className="font-semibold text-[#E2E8F0] border-b border-[#2D2E33] pb-2 flex items-center justify-between">
                              <span>Trajectory Breakdown: {seq.bodyNames.join(' ➔ ')}</span>
                              <div className="flex items-center gap-3 font-mono">
                                <span className="text-[#38BDF8]">
                                  Sum C3 + Stoch Δv²: {sumC3Stoch.toFixed(3)} km²/s²
                                </span>
                                <span className="text-[#60A5FA]">
                                  Total Δv: {seq.totalStochasticDv.toFixed(1)} m/s
                                </span>
                              </div>
                            </h4>

                            {/* Flyby Details Table */}
                            {seq.flybys.length > 0 ? (
                              <div className="space-y-2">
                                <span className="font-medium text-[#94A3B8] uppercase text-[10px] tracking-wider block">Gravity Assist Flybys:</span>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                  {seq.flybys.map((f, fIdx) => (
                                    <div key={fIdx} className="bg-[#1A1B1E] p-3 rounded border border-[#2D2E33] font-mono text-[11px] space-y-1">
                                      <div className="font-semibold text-[#60A5FA] flex justify-between">
                                        <span>Body: {f.bodyName}</span>
                                        <span className="text-[#94A3B8]">{formatUT(f.flybyDate, timeFormatMode)}</span>
                                      </div>
                                      <div className="flex justify-between text-[#E2E8F0]">
                                        <span>Periapsis Alt:</span>
                                        <strong>{(f.periapsisAlt / 1000).toFixed(0)} km</strong>
                                      </div>
                                      <div className="flex justify-between text-[#E2E8F0]">
                                        <span>Atmosphere Margin:</span>
                                        <strong className="text-[#60A5FA]">{(f.flybyMargin / 1000).toFixed(0)} km</strong>
                                      </div>
                                      <div className="flex justify-between text-[#E2E8F0]">
                                        <span>Deflection Angle:</span>
                                        <strong>{f.deflectionAngle.toFixed(1)}° (Max {f.maxDeflectionAngle.toFixed(1)}°)</strong>
                                      </div>
                                      <div className="flex justify-between text-[#E2E8F0]">
                                        <span>Stochastic Δv:</span>
                                        <strong className={f.stochasticDv > 0 ? 'text-amber-400' : 'text-[#60A5FA]'}>
                                          {f.stochasticDv.toFixed(1)} m/s
                                        </strong>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <p className="text-[#64748B] italic">Direct transfer with no intermediate flyby bodies.</p>
                            )}

                            {/* Transfers Between Bodies (Orbital Characteristics) */}
                            {seq.transfers && seq.transfers.length > 0 && (
                              <div className="space-y-2 pt-3 border-t border-[#2D2E33]">
                                <span className="font-medium text-[#94A3B8] uppercase text-[10px] tracking-wider block">
                                  Transfers Between Bodies (Orbital Characteristics):
                                </span>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  {seq.transfers.map((tr, tIdx) => {
                                    const depBodyName = seq.bodyNames[tIdx] || 'Departure';
                                    const arrBodyName = seq.bodyNames[tIdx + 1] || 'Arrival';

                                    const depBody = bodies.find(b => b.name === depBodyName) || mainBody || { name: depBodyName, radius: 100000 };
                                    const mBody = mainBody || { name: 'Sun', stdGravParam: 1.1723328e18, radius: 261600000 };
                                    const muCentral = getGravitationalParameter(mBody);

                                    const depState = getBodyStateAtUT(depBody, mBody, tr.depDate);
                                    const vTransDepVec: Vector3D = { x: tr.vTransDep[0], y: tr.vTransDep[1], z: tr.vTransDep[2] };

                                    const elem = stateToOrbitalElements(depState.pos, vTransDepVec, muCentral, tr.depDate);
                                    const periodSec = 2 * Math.PI * Math.sqrt(Math.pow(Math.abs(elem.semiMajorAxis), 3) / Math.max(1, muCentral));

                                    const periapsisRadiusM = elem.semiMajorAxis * (1 - elem.eccentricity);

                                    const formatDist = (meters: number) => {
                                      const absM = Math.abs(meters);
                                      if (absM >= 1e12) {
                                        return `${(meters / 1e12).toFixed(3)} Tm`;
                                      }
                                      if (absM >= 1e9) {
                                        return `${(meters / 1e9).toFixed(3)} Gm`;
                                      }
                                      if (absM >= 1e6) {
                                        return `${(meters / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
                                      }
                                      return `${meters.toFixed(1)} m`;
                                    };

                                    const incDeg = (elem.inclination * 180) / Math.PI;
                                    const raanDeg = (elem.ascNodeLongitude * 180) / Math.PI;
                                    const argDeg = (elem.argOfPeriapsis * 180) / Math.PI;
                                    const trueAnomalyDeg = (elem.trueAnomalyEpoch * 180) / Math.PI;

                                    return (
                                      <div key={tIdx} className="bg-[#1A1B1E] p-3 rounded border border-[#2D2E33] font-mono text-[11px] space-y-2 text-[#E2E8F0]">
                                        <div className="font-semibold text-[#38BDF8] flex justify-between border-b border-[#2D2E33] pb-1.5">
                                          <span>Transfer Leg {tIdx + 1}: {depBodyName} ➔ {arrBodyName}</span>
                                          <span className="text-[#94A3B8]">{formatDuration(tr.flightTime, timeFormatMode)}</span>
                                        </div>

                                        <div className="flex flex-col space-y-1 text-[11px]">
                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Semi-Major Axis (sma):</span>
                                            <strong className="text-[#E2E8F0]">{formatDist(elem.semiMajorAxis)}</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Periapsis Radius (pe/rp):</span>
                                            <strong className="text-emerald-300">{formatDist(periapsisRadiusM)}</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Eccentricity (e):</span>
                                            <strong className="text-[#38BDF8]">{elem.eccentricity.toFixed(5)}</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Inclination (inc):</span>
                                            <strong>{incDeg.toFixed(3)}°</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">RAAN (raan):</span>
                                            <strong>{raanDeg.toFixed(3)}°</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Arg of Periapsis (arg):</span>
                                            <strong>{argDeg.toFixed(3)}°</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">trueAnomaly@epoch0:</span>
                                            <strong className="text-amber-300">{trueAnomalyDeg.toFixed(3)}°</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Period:</span>
                                            <strong className="text-[#60A5FA]">{formatDuration(periodSec, timeFormatMode)}</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Departure Date (epoch0):</span>
                                            <span>{formatUT(tr.depDate, timeFormatMode)}</span>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Nb of Orbits:</span>
                                            <strong className="text-[#E2E8F0]">0</strong>
                                          </div>

                                          <div className="flex justify-between">
                                            <span className="text-[#94A3B8]">Direction:</span>
                                            <strong className="text-emerald-400">prograde</strong>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={columns.filter(c => c.visible).length + 2} className="p-8 text-center text-[#94A3B8] font-sans">
                  {results.length === 0 ? (
                    <div>
                      <p className="text-[#E2E8F0] font-medium">No trajectory search executed yet or no valid sequences found.</p>
                      <p className="text-xs text-[#94A3B8] mt-1">
                        Click <strong>"Search Possible Sequences"</strong> above to compute Lambert transfers and flyby feasibility!
                      </p>
                    </div>
                  ) : (
                    'No results match selected filter constraints.'
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
