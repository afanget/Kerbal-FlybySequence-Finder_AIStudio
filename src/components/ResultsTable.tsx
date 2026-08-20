/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { FlyableSequenceResult, ResultTableColumn, ResultTableColumnKey, CelestialBody, OrbitalBody, PorkchopPlotData, SequencePorkchopData, DirectionalLink, InstanceNode, SubtaskProgressInfo } from '../types';
import { formatUT, formatShortUT, formatDuration, daysToSeconds, secondsToDays } from '../utils/timeFormat';
import { computeStochasticDvForFlyby, debugStochasticDvCalculation, StochasticDvDebugInfo, recomputeFlybyDetailsSequentially, SequentialFlybyDebugInfo } from '../physics/flyby';
import { getBodyStateAtUT, stateToOrbitalElements } from '../physics/kepler';
import { findAllPaths, isInstanceSource, findAllSubPathsInGraph, CandidateSequencePath } from '../physics/solver';
import { compute3BodyConsolidatedRangesAsync, LinkEndDateRanges, Sequence3BodyConsolidatedRange } from '../physics/tisserandRanges';
import { SolarSystemTrajectoryView } from './SolarSystemTrajectoryView';
import * as XLSX from 'xlsx';
import { Download, ArrowUpDown, ChevronLeft, ChevronRight, Eye, ShieldCheck, Sliders, SlidersHorizontal, RefreshCw, Terminal, CheckCircle2, XCircle, Compass, Activity, Plus, Trash2, ArrowUp, ArrowDown, Layers, ListFilter, X, ChevronUp, ChevronDown, Calendar, GitMerge } from 'lucide-react';

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
  onSearchSequencesFromPorkchops?: () => void;
  onStopSearch?: () => void;
  onRemoveResult?: (seqId: string) => void;
  onClearResults?: () => void;
  isSearching: boolean;
  searchStatusText?: string;
  bodies?: OrbitalBody[];
  mainBody?: CelestialBody;
  porkchops?: Record<string, PorkchopPlotData>;
  onPorkchopUpdate?: (newPorkchops: Record<string, PorkchopPlotData>) => void;
  sequencePorkchops?: Record<string, SequencePorkchopData>;
  onOpenSequencePorkchop?: (seqPcId: string) => void;
  onComputeSequencePorkchop?: (seqId: string, pathInsts: InstanceNode[], isFullPath?: boolean) => void;
  computingSeqId?: string | null;
  activeSubtask?: SubtaskProgressInfo | null;
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
  onSearchSequencesFromPorkchops,
  onStopSearch,
  onRemoveResult,
  onClearResults,
  isSearching,
  searchStatusText,
  bodies = [],
  mainBody,
  porkchops,
  onPorkchopUpdate,
  sequencePorkchops,
  onOpenSequencePorkchop,
  onComputeSequencePorkchop,
  computingSeqId,
  activeSubtask,
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
  const [isSequencePorkchopsFolded, setIsSequencePorkchopsFolded] = useState<boolean>(true);
  const [isTisserandRangesFolded, setIsTisserandRangesFolded] = useState<boolean>(true);
  const [tisserandRangesTab, setTisserandRangesTab] = useState<'3body' | 'links'>('3body');

  // Asynchronous state for Tisserand date range calculations
  const [linkEndRangesMap, setLinkEndRangesMap] = useState<Record<string, LinkEndDateRanges>>({});
  const [sequence3BodyRangesList, setSequence3BodyRangesList] = useState<Sequence3BodyConsolidatedRange[]>([]);
  const [isCalculatingTisserandRanges, setIsCalculatingTisserandRanges] = useState<boolean>(false);
  const [tisserandProgress, setTisserandProgress] = useState<number>(0);
  const [tisserandStatusText, setTisserandStatusText] = useState<string>('');

  const porkchopsRef = React.useRef(porkchops);
  useEffect(() => {
    porkchopsRef.current = porkchops;
  }, [porkchops]);

  useEffect(() => {
    if (!instances || instances.length === 0 || !links || links.length === 0 || !mainBody) {
      setLinkEndRangesMap({});
      setSequence3BodyRangesList([]);
      setIsCalculatingTisserandRanges(false);
      return;
    }

    let isMounted = true;
    setIsCalculatingTisserandRanges(true);
    setTisserandProgress(0);
    setTisserandStatusText('Initializing Tisserand date range calculation...');

    compute3BodyConsolidatedRangesAsync(
      instances,
      links,
      bodies,
      mainBody,
      timeFormatMode,
      porkchopsRef.current,
      (progress, status) => {
        if (isMounted) {
          setTisserandProgress(progress);
          setTisserandStatusText(status);
        }
      }
    ).then(res => {
      if (isMounted) {
        setLinkEndRangesMap(res.linkEndRangesMap);
        setSequence3BodyRangesList(res.sequence3BodyRangesList);
        setIsCalculatingTisserandRanges(false);
        if (onPorkchopUpdate && res.porkchopsMap && Object.keys(res.porkchopsMap).length > 0) {
          onPorkchopUpdate(res.porkchopsMap);
        }
      }
    }).catch(err => {
      console.error("Failed to compute Tisserand date ranges:", err);
      if (isMounted) {
        setIsCalculatingTisserandRanges(false);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [instances, links, bodies, mainBody, timeFormatMode]);

  const linkEndRangesList = useMemo(() => {
    return Object.values(linkEndRangesMap);
  }, [linkEndRangesMap]);

  const handleExportTisserandRangesToExcel = () => {
    const wb = XLSX.utils.book_new();

    const seqDataForExport = sequence3BodyRangesList.map(item => {
      const daysOver = secondsToDays(item.overlapDurationSec, timeFormatMode).toFixed(2);
      return {
        '3-Body Sequence': item.sequenceLabel,
        'Flyby Body': item.flybyInstance.bodyName,
        'Link 1 Arrival Window': `${formatShortUT(item.link1ArrMin, timeFormatMode)} - ${formatShortUT(item.link1ArrMax, timeFormatMode)}`,
        'Link 2 Departure Window': `${formatShortUT(item.link2DepMin, timeFormatMode)} - ${formatShortUT(item.link2DepMax, timeFormatMode)}`,
        'Consolidated Flyby Window (Intersection)': item.hasFlybyOverlap
          ? `${formatShortUT(item.consolidatedFlybyMin, timeFormatMode)} - ${formatShortUT(item.consolidatedFlybyMax, timeFormatMode)}`
          : 'NO OVERLAP',
        'Flyby Window Overlap Status': item.hasFlybyOverlap ? `Overlap (${daysOver}d)` : `Disjoint (-${daysOver}d gap)`,
        'Consolidated Departure Window': `${formatShortUT(item.consolidatedDepMin, timeFormatMode)} - ${formatShortUT(item.consolidatedDepMax, timeFormatMode)}`,
        'Consolidated Arrival Window': `${formatShortUT(item.consolidatedArrMin, timeFormatMode)} - ${formatShortUT(item.consolidatedArrMax, timeFormatMode)}`
      };
    });
    const ws1 = XLSX.utils.json_to_sheet(seqDataForExport);
    XLSX.utils.book_append_sheet(wb, ws1, '3-Body Consolidated Ranges');

    const linkDataForExport = linkEndRangesList.map(item => {
      return {
        'Link': `${item.sourceBodyName} ➔ ${item.targetBodyName}`,
        'Departure End Target Vinf (m/s)': `${item.depTargetVinfRange.minMs.toFixed(0)} - ${item.depTargetVinfRange.maxMs.toFixed(0)}`,
        'Departure End Date Range': `${formatShortUT(item.depDateMin, timeFormatMode)} - ${formatShortUT(item.depDateMax, timeFormatMode)}`,
        'Departure Vinf Achieved (m/s)': `${item.depVinfMin.toFixed(0)} - ${item.depVinfMax.toFixed(0)}`,
        'Arrival End Target Vinf (m/s)': `${item.arrTargetVinfRange.minMs.toFixed(0)} - ${item.arrTargetVinfRange.maxMs.toFixed(0)}`,
        'Arrival End Date Range': `${formatShortUT(item.arrDateMin, timeFormatMode)} - ${formatShortUT(item.arrDateMax, timeFormatMode)}`,
        'Arrival Vinf Achieved (m/s)': `${item.arrVinfMin.toFixed(0)} - ${item.arrVinfMax.toFixed(0)}`
      };
    });
    const ws2 = XLSX.utils.json_to_sheet(linkDataForExport);
    XLSX.utils.book_append_sheet(wb, ws2, 'Link Ends Date Ranges');

    XLSX.writeFile(wb, `Tisserand_Date_Ranges_${Date.now()}.xlsx`);
  };

  // Compute all candidate sequence paths (N >= 3, full paths and subsequences) directly from input graph
  const candidateSequencePaths = useMemo(() => {
    if (!instances || instances.length === 0 || !links || links.length === 0) return [];
    return findAllSubPathsInGraph(links, instances);
  }, [instances, links]);

  // Group candidate sequence paths by instance count N (3, 4, 5...)
  const groupedCandidatePaths = useMemo(() => {
    const groups: Record<number, CandidateSequencePath[]> = {};
    candidateSequencePaths.forEach(cand => {
      if (!groups[cand.count]) {
        groups[cand.count] = [];
      }
      groups[cand.count].push(cand);
    });
    return groups;
  }, [candidateSequencePaths]);

  const candidateInstanceCounts = useMemo(() => {
    return Object.keys(groupedCandidatePaths).map(Number).sort((a, b) => a - b);
  }, [groupedCandidatePaths]);

  const activeComputingSeq = useMemo(() => {
    if (!computingSeqId) return null;
    return candidateSequencePaths.find(c => c.id === computingSeqId) || null;
  }, [computingSeqId, candidateSequencePaths]);

  const activeComputingPct = useMemo(() => {
    if (!computingSeqId || !sequencePorkchops?.[computingSeqId]) return 0;
    const data = sequencePorkchops[computingSeqId];
    const total = data.totalSamples ?? 0;
    const computed = data.computedSamples ?? 0;
    return total > 0 ? Math.min(100, Math.max(0, Math.round((computed / total) * 100))) : 0;
  }, [computingSeqId, sequencePorkchops]);

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
        const body : CelestialBody = bodies.find(b => b.name === f.bodyName)!;
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
              {onSearchSequencesFromPorkchops && (
                <button
                  id="btn-search-sequences-porkchops"
                  onClick={onSearchSequencesFromPorkchops}
                  className="search-btn-porkchops flex items-center gap-2 px-5 py-2.5 rounded font-serif text-xs uppercase tracking-widest text-white bg-emerald-700 hover:bg-emerald-600 border border-emerald-500 shadow-lg transition active:scale-95 cursor-pointer font-semibold"
                  title="Compute all full-path sequence porkchops and collect all samples with each flyby Δv ≤ 1 m/s into results"
                >
                  <Layers className="w-4 h-4 text-emerald-200" />
                  <span>Search possible sequences (from sequences porkchop)</span>
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

      {/* Live Sequence Porkchop Computation Banner (Main Page Progress & Dependency Subtask Subtitle) */}
      {computingSeqId && activeComputingSeq && (
        <div className="bg-[#0F172A] border border-[#38BDF8]/50 p-3.5 rounded-lg flex flex-col gap-2 shadow-lg">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-4 h-4 border-2 border-[#38BDF8]/30 border-t-[#38BDF8] rounded-full animate-spin flex-shrink-0" />
              <div className="min-w-0">
                <span className="font-semibold uppercase tracking-wider text-[10px] text-[#94A3B8] block">
                  Computing Sequence Porkchop (Main Task):
                </span>
                <span className="font-mono text-xs sm:text-sm text-white font-bold truncate block">
                  {activeComputingSeq.sequenceLabel} ({activeComputingSeq.instanceCount}-Instance {activeComputingSeq.isFullPath ? 'Full Path' : 'Subsequence'})
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 font-mono font-bold text-[#38BDF8] bg-blue-950/90 px-2.5 py-1 rounded border border-blue-500/40 text-xs shadow-inner">
              <span>Main Task: {activeComputingPct}%</span>
            </div>
          </div>

          {/* Dependency Subtask Progress Subtitle & Bar */}
          {activeSubtask && (
            <div className="bg-[#18181B] border border-cyan-500/40 rounded-lg p-2.5 flex flex-col gap-1.5 mt-0.5">
              <div className="flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-cyan-300 font-bold truncate">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />
                  <span className="text-slate-400 font-normal uppercase text-[10px] tracking-wider">Dependency Subtask:</span>
                  <span className="text-cyan-200">{activeSubtask.subtaskName}</span>
                </div>
                <span className="text-cyan-200 font-bold bg-cyan-950/90 px-2 py-0.5 rounded border border-cyan-500/40 text-[11px] shrink-0 ml-2">
                  {activeSubtask.progressPct}%
                </span>
              </div>
              <div className="w-full bg-[#27272A] h-2 rounded-full overflow-hidden border border-[#3F3F46]">
                <div
                  className="bg-gradient-to-r from-blue-500 to-cyan-400 h-full transition-all duration-150"
                  style={{ width: `${activeSubtask.progressPct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                <span>{activeSubtask.statusText || 'Computing prerequisite transfers...'}</span>
                {activeSubtask.totalSamples > 0 && (
                  <span>{activeSubtask.computedSamples} / {activeSubtask.totalSamples} samples</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tisserand-Filtered Date Ranges & 3-Body Sequence Intersections (Foldable - folded by default) */}
      {(isCalculatingTisserandRanges || sequence3BodyRangesList.length > 0 || linkEndRangesList.length > 0) && (
        <div className="bg-[#25262B] rounded border border-[#2D2E33] overflow-hidden flex flex-col shadow-sm">
          {/* Fold Header Toggle Button */}
          <div className="w-full px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-white uppercase tracking-wider bg-[#2D2E33]/40 border-b border-[#2D2E33] select-none">
            <button
              onClick={() => setIsTisserandRangesFolded(!isTisserandRangesFolded)}
              className="flex items-center gap-2 hover:text-[#38BDF8] transition cursor-pointer text-left"
            >
              <GitMerge className="w-4 h-4 text-emerald-400" />
              <span>Tisserand v_inf Filtered Date Ranges & 3-Body Intersections</span>
              <span className="text-[10px] text-[#94A3B8] font-mono font-normal normal-case hidden sm:inline">
                (0.01d dichotomic bisection precision)
              </span>
              {isCalculatingTisserandRanges && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-950/85 border border-blue-500/50 text-[10px] font-mono font-bold text-[#38BDF8] shadow-sm ml-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#38BDF8] animate-ping" />
                  <span>Calculating: {tisserandProgress}%</span>
                </span>
              )}
            </button>

            <div className="flex items-center gap-2">
              {!isTisserandRangesFolded && !isCalculatingTisserandRanges && (
                <>
                  {/* Tab selector */}
                  <div className="flex items-center bg-[#1A1B1E] p-0.5 rounded border border-[#2D2E33]">
                    <button
                      onClick={() => setTisserandRangesTab('3body')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-medium transition cursor-pointer ${
                        tisserandRangesTab === '3body'
                          ? 'bg-[#38BDF8] text-black font-bold'
                          : 'text-[#94A3B8] hover:text-white'
                      }`}
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      <span>3-Body Consolidated ({sequence3BodyRangesList.length})</span>
                    </button>
                    <button
                      onClick={() => setTisserandRangesTab('links')}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-mono font-medium transition cursor-pointer ${
                        tisserandRangesTab === 'links'
                          ? 'bg-[#38BDF8] text-black font-bold'
                          : 'text-[#94A3B8] hover:text-white'
                      }`}
                    >
                      <Calendar className="w-3.5 h-3.5" />
                      <span>Link Ends ({linkEndRangesList.length})</span>
                    </button>
                  </div>

                  {/* Export XLSX button */}
                  <button
                    onClick={handleExportTisserandRangesToExcel}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#1E293B] hover:bg-[#334155] text-cyan-300 border border-cyan-500/40 rounded text-[11px] font-semibold transition cursor-pointer"
                    title="Export Tisserand date ranges to Excel"
                  >
                    <Download className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Export XLSX</span>
                  </button>
                </>
              )}

              <button
                onClick={() => setIsTisserandRangesFolded(!isTisserandRangesFolded)}
                className="flex items-center gap-1 text-[#94A3B8] hover:text-white text-[11px] font-mono font-normal cursor-pointer px-1.5 py-1 rounded hover:bg-[#1E293B] transition"
              >
                <span>{isTisserandRangesFolded ? 'Show / Unfold' : 'Hide / Fold'}</span>
                {isTisserandRangesFolded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Unfolded Content */}
          {!isTisserandRangesFolded && (
            <div className="p-3.5 flex flex-col gap-3">
              {isCalculatingTisserandRanges ? (
            <div className="bg-[#1A1B1E] border border-[#2D2E33] rounded-lg p-5 flex flex-col items-center justify-center gap-2.5 text-slate-300 my-1">
              <div className="flex items-center gap-2 font-mono text-xs text-[#38BDF8] font-semibold">
                <RefreshCw className="w-4 h-4 animate-spin text-[#38BDF8]" />
                <span>Calculating Tisserand v_inf Date Ranges ({tisserandProgress}%)...</span>
              </div>
              <div className="w-full max-w-md bg-[#25262B] h-2.5 rounded-full overflow-hidden border border-[#33353A]">
                <div
                  className="bg-[#38BDF8] h-full transition-all duration-150 ease-out"
                  style={{ width: `${tisserandProgress}%` }}
                />
              </div>
              <div className="text-[11px] font-mono text-[#94A3B8]">
                {tisserandStatusText || 'Evaluating orbital transfers in background thread...'}
              </div>
            </div>
          ) : (
            <>
              {/* Tab 1: 3-Body Sequence Consolidated Date Ranges */}
          {tisserandRangesTab === '3body' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#1D1E22] text-[#94A3B8] font-mono text-[11px] uppercase tracking-wider border-b border-[#2D2E33]">
                    <th className="p-2">3-Body Sequence</th>
                    <th className="p-2">Flyby Body</th>
                    <th className="p-2">Link 1 Arrival Window</th>
                    <th className="p-2">Link 2 Departure Window</th>
                    <th className="p-2">Consolidated Flyby Window (Intersection)</th>
                    <th className="p-2">Overlap Status</th>
                    <th className="p-2">Consolidated Departure</th>
                    <th className="p-2">Consolidated Arrival</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2D2E33]/50 font-mono text-xs">
                  {sequence3BodyRangesList.map(item => {
                    const overlapDays = secondsToDays(item.overlapDurationSec, timeFormatMode).toFixed(2);
                    return (
                      <tr key={item.sequenceId} className="hover:bg-[#2D2E33]/40 transition">
                        <td className="p-2 font-bold text-white whitespace-nowrap">
                          {item.sequenceLabel}
                        </td>
                        <td className="p-2 text-[#38BDF8] font-semibold">
                          {item.flybyInstance.bodyName}
                        </td>
                        <td className="p-2 text-[#94A3B8] whitespace-nowrap">
                          {formatShortUT(item.link1ArrMin, timeFormatMode)} ➔ {formatShortUT(item.link1ArrMax, timeFormatMode)}
                        </td>
                        <td className="p-2 text-[#94A3B8] whitespace-nowrap">
                          {formatShortUT(item.link2DepMin, timeFormatMode)} ➔ {formatShortUT(item.link2DepMax, timeFormatMode)}
                        </td>
                        <td className="p-2 font-bold whitespace-nowrap">
                          {item.hasFlybyOverlap ? (
                            <span className="text-emerald-400">
                              {formatShortUT(item.consolidatedFlybyMin, timeFormatMode)} ➔ {formatShortUT(item.consolidatedFlybyMax, timeFormatMode)}
                            </span>
                          ) : (
                            <span className="text-rose-400 font-normal">
                              No Overlap ({formatShortUT(item.consolidatedFlybyMin, timeFormatMode)} vs {formatShortUT(item.consolidatedFlybyMax, timeFormatMode)})
                            </span>
                          )}
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {item.hasFlybyOverlap ? (
                            <span className="bg-emerald-950/60 text-emerald-300 border border-emerald-500/50 text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider">
                              Overlap ({overlapDays}d)
                            </span>
                          ) : (
                            <span className="bg-rose-950/60 text-rose-300 border border-rose-500/50 text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider">
                              Disjoint (-{overlapDays}d gap)
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-[#E2E8F0] whitespace-nowrap">
                          {formatShortUT(item.consolidatedDepMin, timeFormatMode)} ➔ {formatShortUT(item.consolidatedDepMax, timeFormatMode)}
                        </td>
                        <td className="p-2 text-[#E2E8F0] whitespace-nowrap">
                          {formatShortUT(item.consolidatedArrMin, timeFormatMode)} ➔ {formatShortUT(item.consolidatedArrMax, timeFormatMode)}
                        </td>
                      </tr>
                    );
                  })}
                  {sequence3BodyRangesList.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-4 text-center text-[#94A3B8] italic">
                        No 3-body sequences found in the current graph. Add a 2-hop path (e.g. A ➔ B ➔ C) on the graph editor above to calculate consolidated date ranges!
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Tab 2: Link Ends Date Ranges */}
          {tisserandRangesTab === 'links' && (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#1D1E22] text-[#94A3B8] font-mono text-[11px] uppercase tracking-wider border-b border-[#2D2E33]">
                    <th className="p-2">Link</th>
                    <th className="p-2">Departure Target v_inf</th>
                    <th className="p-2">Departure End Date Range</th>
                    <th className="p-2">Departure v_inf Achieved</th>
                    <th className="p-2">Arrival Target v_inf</th>
                    <th className="p-2">Arrival End Date Range</th>
                    <th className="p-2">Arrival v_inf Achieved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2D2E33]/50 font-mono text-xs">
                  {linkEndRangesList.map(item => (
                    <tr key={item.linkId} className="hover:bg-[#2D2E33]/40 transition">
                      <td className="p-2 font-bold text-white whitespace-nowrap">
                        {item.sourceBodyName} ➔ {item.targetBodyName}
                      </td>
                      <td className="p-2 text-[#38BDF8] whitespace-nowrap">
                        {item.depTargetVinfRange.minMs.toFixed(0)} - {item.depTargetVinfRange.maxMs.toFixed(0)} m/s
                      </td>
                      <td className="p-2 text-emerald-400 font-semibold whitespace-nowrap">
                        {item.hasValidDepRange
                          ? `${formatShortUT(item.depDateMin, timeFormatMode)} ➔ ${formatShortUT(item.depDateMax, timeFormatMode)}`
                          : 'No valid range'}
                      </td>
                      <td className="p-2 text-[#E2E8F0] whitespace-nowrap">
                        {item.depVinfMin.toFixed(0)} - {item.depVinfMax.toFixed(0)} m/s
                      </td>
                      <td className="p-2 text-[#38BDF8] whitespace-nowrap">
                        {item.arrTargetVinfRange.minMs.toFixed(0)} - {item.arrTargetVinfRange.maxMs.toFixed(0)} m/s
                      </td>
                      <td className="p-2 text-emerald-400 font-semibold whitespace-nowrap">
                        {item.hasValidArrRange
                          ? `${formatShortUT(item.arrDateMin, timeFormatMode)} ➔ ${formatShortUT(item.arrDateMax, timeFormatMode)}`
                          : 'No valid range'}
                      </td>
                      <td className="p-2 text-[#E2E8F0] whitespace-nowrap">
                        {item.arrVinfMin.toFixed(0)} - {item.arrVinfMax.toFixed(0)} m/s
                      </td>
                    </tr>
                  ))}
                  {linkEndRangesList.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-4 text-center text-[#94A3B8] italic">
                        No directional links found. Connect nodes on the canvas above to compute link end date ranges!
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
            </div>
          )}
        </div>
      )}

      {/* Sequence Porkchops Banners by Instance Count (Foldable - folded by default) */}
      {candidateInstanceCounts.length > 0 && (
        <div className="bg-[#25262B] rounded border border-[#2D2E33] overflow-hidden flex flex-col shadow-sm">
          {/* Fold Header Toggle Button */}
          <button
            onClick={() => setIsSequencePorkchopsFolded(!isSequencePorkchopsFolded)}
            className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-bold text-white uppercase tracking-wider bg-[#2D2E33]/40 hover:bg-[#2D2E33] transition cursor-pointer select-none"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Compass className="w-4 h-4 text-[#38BDF8]" />
              <span>Multi-Instance / X-Instance Sequence Porkchops</span>
              <span className="text-[10px] text-[#94A3B8] font-normal font-mono lowercase">
                ({candidateSequencePaths.length} sequence path(s) available)
              </span>
              {activeComputingSeq && (
                <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-950/85 border border-blue-500/50 text-[10px] font-mono font-bold text-[#38BDF8] shadow-sm ml-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#38BDF8] animate-ping" />
                  <span>Computing {activeComputingSeq.sequenceLabel}: {activeComputingPct}%</span>
                  {activeSubtask && (
                    <span className="text-cyan-300 ml-1 border-l border-blue-500/40 pl-1.5 text-[9px] font-normal">
                      Subtask ({activeSubtask.subtaskName}): {activeSubtask.progressPct}%
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-[#94A3B8] text-[11px] font-mono font-normal">
              <span>{isSequencePorkchopsFolded ? 'Show / Unfold' : 'Hide / Fold'}</span>
              {isSequencePorkchopsFolded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </div>
          </button>

          {/* Unfolded Content */}
          {!isSequencePorkchopsFolded && (
            <div className="p-3 flex flex-col gap-3">
              {/* Instance Count Filter Bar when multiple counts exist */}
              {candidateInstanceCounts.length > 1 && (
                <div className="bg-[#1E1F23] px-3 py-2 rounded border border-[#2D2E33] flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider">
                    <Compass className="w-4 h-4 text-[#38BDF8]" />
                    <span>Filter by Instance Count:</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => setSelectedInstanceFilter('ALL')}
                      className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition cursor-pointer flex items-center gap-1.5 ${
                        selectedInstanceFilter === 'ALL'
                          ? 'bg-[#38BDF8] text-black font-bold'
                          : 'bg-[#1A1B1E] text-[#94A3B8] hover:text-white border border-[#2D2E33]'
                      }`}
                    >
                      <span>All ({candidateSequencePaths.length})</span>
                      {activeComputingSeq && (
                        <span className={`font-bold px-1.5 py-0.2 rounded text-[10px] font-mono ${
                          selectedInstanceFilter === 'ALL'
                            ? 'bg-black text-[#38BDF8]'
                            : 'bg-blue-950/90 text-[#38BDF8] border border-blue-500/50'
                        }`}>
                          {activeComputingPct}%
                        </span>
                      )}
                    </button>
                    {candidateInstanceCounts.map(count => {
                      const countCands = groupedCandidatePaths[count] || [];
                      const isCountComputing = countCands.some(c => c.id === computingSeqId);
                      const computingDataForCount = isCountComputing && computingSeqId ? sequencePorkchops?.[computingSeqId] : null;
                      const countPct = computingDataForCount?.totalSamples && computingDataForCount.totalSamples > 0
                        ? Math.min(100, Math.max(0, Math.round(((computingDataForCount.computedSamples ?? 0) / computingDataForCount.totalSamples) * 100)))
                        : 0;

                      return (
                        <button
                          key={count}
                          onClick={() => setSelectedInstanceFilter(String(count))}
                          className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition cursor-pointer flex items-center gap-1.5 ${
                            selectedInstanceFilter === String(count)
                              ? 'bg-[#38BDF8] text-black font-bold'
                              : 'bg-[#1A1B1E] text-[#94A3B8] hover:text-white border border-[#2D2E33]'
                          }`}
                        >
                          <span>{count}-Instance ({countCands.length})</span>
                          {isCountComputing && (
                            <span className={`font-bold px-1.5 py-0.2 rounded text-[10px] font-mono ${
                              selectedInstanceFilter === String(count)
                                ? 'bg-black text-[#38BDF8]'
                                : 'bg-blue-950/90 text-[#38BDF8] border border-blue-500/50'
                            }`}>
                              {countPct}%
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {candidateInstanceCounts
                .filter(count => selectedInstanceFilter === 'ALL' || selectedInstanceFilter === String(count))
                .map(count => {
                  const cands = groupedCandidatePaths[count] || [];
                  const isCountComputing = cands.some(c => c.id === computingSeqId);
                  const computingDataForCount = isCountComputing && computingSeqId ? sequencePorkchops?.[computingSeqId] : null;
                  const countPct = computingDataForCount?.totalSamples && computingDataForCount.totalSamples > 0
                    ? Math.min(100, Math.max(0, Math.round(((computingDataForCount.computedSamples ?? 0) / computingDataForCount.totalSamples) * 100)))
                    : 0;

                  return (
                    <div key={count} className="bg-[#1E1F23] p-3 rounded border border-[#2D2E33] flex flex-col gap-2.5 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-2 text-xs font-bold text-white uppercase tracking-wider">
                            <Compass className="w-4 h-4 text-[#38BDF8]" />
                            <span>{count}-Instance Sequence Porkchops</span>
                          </div>
                          {isCountComputing && (
                            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-950/80 border border-blue-500/40 text-[10px] font-mono font-bold text-[#38BDF8] shadow-sm">
                              <span>Computing ({countPct}%)</span>
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] font-mono text-[#94A3B8]">
                          {cands.length} sequence path(s)
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {cands.map(cand => {
                          const isComputed = !!sequencePorkchops?.[cand.id];
                          const isThisComputing = computingSeqId === cand.id;
                          const isFull = cand.isFullPath;

                          const candSeqPc = sequencePorkchops?.[cand.id];
                          const candTotal = candSeqPc?.totalSamples ?? 0;
                          const candComputed = candSeqPc?.computedSamples ?? 0;
                          const candPct = candTotal > 0
                            ? Math.min(100, Math.max(0, Math.round((candComputed / candTotal) * 100)))
                            : (isThisComputing ? 0 : (isComputed ? 100 : 0));

                          return (
                            <button
                              key={cand.id}
                              onClick={() => {
                                if (isComputed) {
                                  onOpenSequencePorkchop?.(cand.id);
                                } else {
                                  onComputeSequencePorkchop?.(cand.id, cand.pathInsts, cand.isFullPath);
                                }
                              }}
                              disabled={isThisComputing}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded transition text-xs font-mono font-medium shadow-sm cursor-pointer border ${
                                isFull
                                  ? isComputed
                                    ? 'bg-cyan-950/40 hover:bg-cyan-900/50 border-cyan-500/50 text-cyan-300'
                                    : 'bg-[#18181B] hover:bg-[#27272A] border-cyan-600/40 text-cyan-400'
                                  : isComputed
                                    ? 'bg-purple-950/40 hover:bg-purple-900/50 border-purple-500/50 text-purple-300'
                                    : 'bg-[#18181B] hover:bg-[#27272A] border-purple-600/40 text-purple-400'
                              } ${isThisComputing ? 'ring-1 ring-blue-400/50' : ''}`}
                              title={
                                isThisComputing
                                  ? `Computing ${cand.sequenceLabel} (${candPct}% - ${candComputed}/${candTotal} samples)`
                                  : isComputed
                                    ? `View computed ${isFull ? 'full-path' : 'subsequence'} porkchop plot`
                                    : `Compute this ${isFull ? 'full-path' : 'subsequence'} porkchop plot`
                              }
                            >
                              {isThisComputing ? (
                                <span className="font-mono font-bold text-[#38BDF8] bg-blue-950/90 px-1.5 py-0.5 rounded text-[11px] border border-blue-500/50 shadow-sm">
                                  {candPct}%
                                </span>
                              ) : isComputed ? (
                                <Activity className={`w-3.5 h-3.5 ${isFull ? 'text-cyan-400' : 'text-purple-400'}`} />
                              ) : (
                                <Compass className={`w-3.5 h-3.5 ${isFull ? 'text-cyan-400' : 'text-purple-400'}`} />
                              )}
                              <span>{cand.sequenceLabel} Porkchop Plot</span>

                              {/* Full Path vs Subsequence badge */}
                              {isFull ? (
                                <span className="bg-[#38BDF8]/20 text-[#38BDF8] text-[9px] px-1.5 py-0.5 rounded border border-[#38BDF8]/40 font-bold uppercase tracking-wider">
                                  Full Path
                                </span>
                              ) : (
                                <span className="bg-purple-500/20 text-purple-300 text-[9px] px-1.5 py-0.5 rounded border border-purple-500/40 font-bold uppercase tracking-wider">
                                  Subsequence
                                </span>
                              )}

                              {/* Status Badge */}
                              {isThisComputing ? (
                                <div className="flex flex-col items-end gap-0.5">
                                  <span className="bg-blue-950/90 text-[#38BDF8] text-[9px] px-1.5 py-0.5 rounded border border-blue-500/50 font-bold font-mono flex items-center gap-1 shadow-sm">
                                    Computing ({candPct}%)
                                  </span>
                                  {activeSubtask && (
                                    <span className="bg-cyan-950/90 text-cyan-300 text-[8px] px-1.5 py-0.2 rounded border border-cyan-500/40 font-mono font-medium truncate max-w-[160px]">
                                      Sub: {activeSubtask.subtaskName} ({activeSubtask.progressPct}%)
                                    </span>
                                  )}
                                </div>
                              ) : isComputed ? (
                                <span className="bg-emerald-500/20 text-emerald-300 text-[9px] px-1.5 py-0.2 rounded border border-emerald-500/30 font-semibold">
                                  Ready
                                </span>
                              ) : (
                                <span className={`text-[9px] px-1.5 py-0.2 rounded border font-semibold flex items-center gap-1 ${
                                  isFull
                                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                                    : 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                                }`}>
                                  Compute
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
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
                                    const depBodyName = seq.bodyNames[tIdx];
                                    const arrBodyName = seq.bodyNames[tIdx + 1];

                                    const depBody = bodies.find(b => b.name === depBodyName)!;

                                    const depState = getBodyStateAtUT(depBody, mBody, tr.depDate);
                                    const vTransDepVec = tr.vTransDep;

                                    const elem = stateToOrbitalElements(depState.pos, vTransDepVec, mainBody.stdGravParam, tr.depDate);
                                    const periodSec = 2 * Math.PI * Math.sqrt(Math.pow(Math.abs(elem.semiMajorAxis), 3) / Math.max(1, mainBody.stdGravParam));

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
