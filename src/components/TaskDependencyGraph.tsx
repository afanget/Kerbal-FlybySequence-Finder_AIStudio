/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  ComputationTask,
  ComputationTaskStatus,
  ComputationTaskType,
  computeEffectivePriorities,
} from '../physics/taskManager';
import {
  ChevronDown,
  ChevronUp,
  Play,
  Pause,
  RotateCcw,
  Square,
  Sparkles,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Loader2,
  Zap,
  ArrowRight,
  Layers,
  Info,
  Maximize2,
  Minimize2,
  Activity,
  GitFork,
  HelpCircle,
} from 'lucide-react';

interface TaskDependencyGraphProps {
  tasks: Map<string, ComputationTask>;
  isRunning: boolean;
  isPaused: boolean;
  currentTaskId: string | null;
  onSetTaskPriority: (taskId: string, priority: number, autoStart?: boolean) => void;
  onResetTask: (taskId: string) => void;
  onResetAllTasks: () => void;
  onStartWorker: () => void;
  onPauseWorker: () => void;
  onResumeWorker: () => void;
  onStopWorker: () => void;
  onOpenPorkchop?: (linkId: string) => void;
  onOpenSequencePorkchop?: (seqId: string) => void;
}

const TIER_LABELS: Record<number, string> = {
  0: 'Tier 0: Root Primitives',
  1: 'Tier 1: 2-Body Transfers',
  2: 'Tier 2: 3-Inst Sequences',
  3: 'Tier 3: 4+ Inst Sequences',
  4: 'Tier 4: Mission Trajectories',
};

const TASK_TYPE_BADGES: Record<ComputationTaskType, { label: string; color: string }> = {
  C3_TISSERAND: { label: 'Tiss C3', color: 'bg-indigo-900/60 text-indigo-300 border-indigo-700/50' },
  TWO_BODY_TRANSFER: { label: '2-Body', color: 'bg-sky-900/60 text-sky-300 border-sky-700/50' },
  SEQUENCE_PORKCHOP: { label: 'Seq-PC', color: 'bg-purple-900/60 text-purple-300 border-purple-700/50' },
  COMPUTE_SEQUENCES_DEFAULT: { label: 'Search (Def)', color: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50' },
  COMPUTE_SEQUENCES_FROM_PORKCHOP: { label: 'Search (PC)', color: 'bg-cyan-900/60 text-cyan-300 border-cyan-700/50' },
};

function formatCost(cost?: number): string {
  if (cost === undefined || cost <= 0) return '';
  if (cost >= 1_000_000) {
    const val = (cost / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${val}M`;
  }
  if (cost >= 1_000) {
    const val = (cost / 1_000).toFixed(1).replace(/\.0$/, '');
    return `${val}k`;
  }
  return `${cost}`;
}

export const TaskDependencyGraph: React.FC<TaskDependencyGraphProps> = ({
  tasks,
  isRunning,
  isPaused,
  currentTaskId,
  onSetTaskPriority,
  onResetTask,
  onResetAllTasks,
  onStartWorker,
  onPauseWorker,
  onResumeWorker,
  onStopWorker,
  onOpenPorkchop,
  onOpenSequencePorkchop,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'incomplete' | 'active'>('all');
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);

  // Convert tasks Map to Array
  const taskList = useMemo(() => Array.from(tasks.values()), [tasks]);

  // Compute stats
  const stats = useMemo(() => {
    let completed = 0;
    let running = 0;
    let pending = 0;
    let failed = 0;
    let maxPriority = 0;
    let highestPriorityTaskId: string | null = null;

    taskList.forEach(t => {
      if (t.status === 'completed') completed++;
      else if (t.status === 'running') running++;
      else if (t.status === 'failed') failed++;
      else pending++;

      if (t.effectivePriority > maxPriority) {
        maxPriority = t.effectivePriority;
        highestPriorityTaskId = t.id;
      }
    });

    return {
      total: taskList.length,
      completed,
      running,
      pending,
      failed,
      maxPriority,
      highestPriorityTaskId,
    };
  }, [taskList]);

  // Group tasks by Tier for layered graph layout
  const tieredTasks = useMemo(() => {
    const map = new Map<number, ComputationTask[]>();
    for (let t = 0; t <= 4; t++) {
      map.set(t, []);
    }

    taskList.forEach(task => {
      if (filterMode === 'incomplete' && task.status === 'completed') return;
      if (filterMode === 'active' && task.status !== 'running' && task.effectivePriority === 0) return;
      const tier = task.tier !== undefined ? task.tier : 0;
      const arr = map.get(tier) || [];
      arr.push(task);
      map.set(tier, arr);
    });

    return map;
  }, [taskList, filterMode]);

  // Node position map for drawing SVG dependency arrows
  const [nodePositions, setNodePositions] = useState<Map<string, { x: number; y: number; width: number; height: number }>>(new Map());

  // Measure node DOM positions to draw SVG connecting arrows accurately
  const updatePositions = () => {
    if (!containerRef.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const posMap = new Map<string, { x: number; y: number; width: number; height: number }>();

    taskList.forEach(task => {
      const el = document.getElementById(`task-node-${task.id}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        posMap.set(task.id, {
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        });
      }
    });

    setNodePositions(prev => {
      if (prev.size !== posMap.size) return posMap;
      for (const [k, v] of posMap.entries()) {
        const p = prev.get(k);
        if (!p || Math.abs(p.x - v.x) > 0.5 || Math.abs(p.y - v.y) > 0.5 || Math.abs(p.width - v.width) > 0.5 || Math.abs(p.height - v.height) > 0.5) {
          return posMap;
        }
      }
      return prev;
    });
  };

  const taskIdsKey = useMemo(() => Array.from(tasks.keys()).join(','), [tasks]);

  useEffect(() => {
    if (isExpanded) {
      updatePositions();
      const timer = setTimeout(updatePositions, 100);
      window.addEventListener('resize', updatePositions);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('resize', updatePositions);
      };
    }
  }, [taskIdsKey, isExpanded, filterMode]);

  // Active hovered / selected task details
  const activeDetailTask = useMemo(() => {
    const id = hoveredTaskId || selectedTaskId;
    if (!id) return null;
    return tasks.get(id) || null;
  }, [hoveredTaskId, selectedTaskId, tasks]);

  if (taskList.length === 0) {
    return null;
  }

  return (
    <div
      id="task-dependency-graph-section"
      className={`w-full rounded-xl border transition-all duration-200 ${
        isFullscreen
          ? 'fixed inset-4 z-50 bg-[#0F1117] border-[#334155] shadow-2xl overflow-y-auto flex flex-col p-6'
          : 'bg-[#121318] border-[#262833] shadow-md my-4'
      }`}
    >
      {/* Header Bar */}
      <div
        id="task-graph-header"
        className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-[#171922] border-b border-[#262833] cursor-pointer select-none rounded-t-xl"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-950/80 border border-indigo-600/40 text-indigo-400">
            <GitFork className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#E2E8F0]">
                Computation Tasks & Dependency Flow
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#262833] text-[#94A3B8] font-mono font-medium">
                Single Sequential Worker
              </span>
            </div>
            <p className="text-[11px] text-[#64748B]">
              Deterministic sequence queue • Deadlock-free automatic dependency resolution
            </p>
          </div>
        </div>

        {/* Live Status Indicators & Controls */}
        <div className="flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
          {/* Worker Status Badge */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#1C1E29] border border-[#2D303E]">
            {isRunning ? (
              <>
                <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />
                <span className="text-[11px] font-semibold text-sky-300">Running Task</span>
              </>
            ) : isPaused ? (
              <>
                <Pause className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-semibold text-amber-300">Paused</span>
              </>
            ) : stats.completed === stats.total ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[11px] font-semibold text-emerald-300">All Done</span>
              </>
            ) : (
              <>
                <Clock className="w-3.5 h-3.5 text-[#94A3B8]" />
                <span className="text-[11px] font-semibold text-[#94A3B8]">Worker Idle</span>
              </>
            )}
          </div>

          {/* Counts Badges */}
          <div className="flex items-center gap-1 text-[11px] font-mono">
            <span className="px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-300">
              {stats.completed}/{stats.total} ✓
            </span>
            {stats.running > 0 && (
              <span className="px-2 py-0.5 rounded bg-sky-950/60 border border-sky-500/50 text-sky-300 animate-pulse">
                {stats.running} running
              </span>
            )}
            {stats.pending > 0 && (
              <span className="px-2 py-0.5 rounded bg-[#222430] border border-[#333748] text-[#94A3B8]">
                {stats.pending} todo
              </span>
            )}
            {stats.failed > 0 && (
              <span className="px-2 py-0.5 rounded bg-rose-950/60 border border-rose-600/40 text-rose-300">
                {stats.failed} err
              </span>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-1 pl-2 border-l border-[#2E3140]">
            {isRunning ? (
              <>
                <button
                  id="btn-worker-pause"
                  title="Pause Worker"
                  onClick={onPauseWorker}
                  className="p-1.5 rounded bg-[#262938] hover:bg-[#32364a] text-amber-300 border border-amber-500/30 transition-colors"
                >
                  <Pause className="w-3.5 h-3.5" />
                </button>
                <button
                  id="btn-worker-stop"
                  title="Stop / Cancel Worker"
                  onClick={onStopWorker}
                  className="p-1.5 rounded bg-[#262938] hover:bg-rose-900/50 text-rose-300 border border-rose-500/30 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              </>
            ) : isPaused ? (
              <button
                id="btn-worker-resume"
                title="Resume Worker"
                onClick={onResumeWorker}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-black font-semibold text-[11px] transition-colors"
              >
                <Play className="w-3 h-3 fill-current" />
                <span>Resume</span>
              </button>
            ) : (
              <button
                id="btn-worker-start"
                title="Run Runnable Tasks in Sequence"
                onClick={onStartWorker}
                disabled={stats.pending === 0}
                className={`flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                  stats.pending > 0
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer shadow-sm'
                    : 'bg-[#222430] text-[#64748B] border border-[#2D303E] cursor-not-allowed'
                }`}
              >
                <Play className="w-3 h-3 fill-current" />
                <span>Run Tasks</span>
              </button>
            )}

            <button
              id="btn-worker-reset"
              title="Reset All Tasks"
              onClick={onResetAllTasks}
              className="p-1.5 rounded bg-[#222430] hover:bg-[#2e3142] text-[#94A3B8] hover:text-white border border-[#2D303E] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            <button
              id="btn-toggle-fullscreen"
              title={isFullscreen ? 'Exit Fullscreen' : 'Expand Graph View'}
              onClick={(e) => {
                e.stopPropagation();
                setIsFullscreen(!isFullscreen);
                setIsExpanded(true);
              }}
              className="p-1.5 rounded bg-[#222430] hover:bg-[#2e3142] text-[#94A3B8] hover:text-white border border-[#2D303E] transition-colors"
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>

            <button
              id="btn-toggle-task-graph"
              className="p-1.5 rounded bg-[#222430] text-[#94A3B8] hover:text-white transition-colors ml-1"
            >
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Global Progress Bar underneath header */}
        <div className="w-full h-1 bg-[#10121A] overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{
              width: `${stats.total > 0 ? (stats.completed / stats.total) * 100 : 0}%`,
            }}
          />
        </div>
      </div>

      {/* Expanded Content Area */}
      {isExpanded && (
        <div className="p-4 space-y-4">
          {/* Controls Bar & Legend */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs border-b border-[#222430] pb-3">
            {/* Filter modes */}
            <div className="flex items-center gap-1.5">
              <span className="text-[#64748B] text-[11px]">View:</span>
              <button
                onClick={() => setFilterMode('all')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  filterMode === 'all'
                    ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                    : 'bg-[#1C1E29] text-[#94A3B8] hover:text-white border border-transparent'
                }`}
              >
                All Tasks ({stats.total})
              </button>
              <button
                onClick={() => setFilterMode('incomplete')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  filterMode === 'incomplete'
                    ? 'bg-amber-600/30 text-amber-300 border border-amber-500/40'
                    : 'bg-[#1C1E29] text-[#94A3B8] hover:text-white border border-transparent'
                }`}
              >
                Incomplete ({stats.pending + stats.running})
              </button>
            </div>

            {/* Visual Legend */}
            <div className="flex items-center gap-3 text-[11px] text-[#94A3B8] flex-wrap">
              <div className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded bg-emerald-500" />
                <span>Completed</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded bg-sky-400 animate-pulse" />
                <span>In Progress</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded bg-[#333748]" />
                <span>Pending</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded border border-amber-400 bg-amber-950" />
                <span>High Priority (★)</span>
              </div>
            </div>
          </div>

          {/* Interactive Graph Stage */}
          <div
            ref={containerRef}
            id="task-graph-stage"
            className="relative w-full overflow-x-auto min-h-[260px] p-4 bg-[#0B0C10] rounded-lg border border-[#1E202B] scrollbar-thin scrollbar-thumb-[#3D4258] scrollbar-track-[#12141C]"
            style={{ overflowX: 'auto', scrollbarWidth: 'thin' }}
          >
            {/* SVG Connecting Arrows Canvas */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-0"
              style={{ minWidth: '1100px', minHeight: '100%' }}
            >
              <defs>
                <marker
                  id="arrow-completed"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#10B981" opacity="0.8" />
                </marker>
                <marker
                  id="arrow-running"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#38BDF8" />
                </marker>
                <marker
                  id="arrow-pending"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" opacity="0.5" />
                </marker>
                <marker
                  id="arrow-highlight"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#F59E0B" />
                </marker>
              </defs>

              {/* Render connecting bezier curves between dependencies and tasks */}
              {taskList.map(task => {
                const targetPos = nodePositions.get(task.id);
                if (!targetPos) return null;

                return task.dependencies.map(depId => {
                  const sourcePos = nodePositions.get(depId);
                  if (!sourcePos) return null;

                  const depTask = tasks.get(depId);
                  const isDepCompleted = depTask?.status === 'completed';
                  const isTaskRunning = task.status === 'running' || depTask?.status === 'running';
                  const isHighlighted =
                    (hoveredTaskId === task.id || hoveredTaskId === depId) ||
                    (selectedTaskId === task.id || selectedTaskId === depId);

                  // Calculate start (right edge of source) and end (left edge of target)
                  const startX = sourcePos.x + sourcePos.width / 2;
                  const startY = sourcePos.y;
                  const endX = targetPos.x - targetPos.width / 2;
                  const endY = targetPos.y;

                  // Bezier control points for smooth S-curves
                  const dx = Math.max(30, (endX - startX) * 0.5);
                  const cp1x = startX + dx;
                  const cp1y = startY;
                  const cp2x = endX - dx;
                  const cp2y = endY;

                  const pathD = `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;

                  let strokeColor = '#334155';
                  let markerId = 'arrow-pending';
                  let strokeWidth = 1.5;
                  let strokeDasharray = undefined;

                  if (isHighlighted) {
                    strokeColor = '#F59E0B';
                    markerId = 'arrow-highlight';
                    strokeWidth = 2.5;
                  } else if (isTaskRunning) {
                    strokeColor = '#38BDF8';
                    markerId = 'arrow-running';
                    strokeWidth = 2;
                  } else if (isDepCompleted) {
                    strokeColor = '#10B981';
                    markerId = 'arrow-completed';
                    strokeWidth = 1.8;
                  } else {
                    strokeDasharray = '4 3';
                  }

                  return (
                    <path
                      key={`${depId}->${task.id}`}
                      d={pathD}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={strokeWidth}
                      strokeDasharray={strokeDasharray}
                      markerEnd={`url(#${markerId})`}
                      opacity={isHighlighted ? 1 : (hoveredTaskId ? 0.3 : 0.75)}
                      className="transition-all duration-150"
                    />
                  );
                });
              })}
            </svg>

            {/* Hierarchical Tier Columns */}
            <div className="relative z-10 grid grid-cols-5 gap-3.5 min-w-[1100px] w-max">
              {[0, 1, 2, 3, 4].map(tierIndex => {
                const tierTaskList = tieredTasks.get(tierIndex) || [];
                if (tierTaskList.length === 0 && filterMode !== 'all') return null;

                return (
                  <div
                    key={tierIndex}
                    className="flex flex-col gap-2.5 p-2 rounded-lg bg-[#12141C]/80 border border-[#1F222E]/80 backdrop-blur-sm w-[205px]"
                  >
                    {/* Tier Column Header */}
                    <div className="flex items-center justify-between border-b border-[#222533] pb-1.5 px-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
                        {TIER_LABELS[tierIndex]}
                      </span>
                      <span className="text-[10px] font-mono text-[#64748B]">
                        ({tierTaskList.length})
                      </span>
                    </div>

                    {/* Nodes in this Tier */}
                    <div className="flex flex-col gap-2">
                      {tierTaskList.map(task => {
                        const isRunningThis = task.id === currentTaskId || task.status === 'running';
                        const isHovered = hoveredTaskId === task.id;
                        const isSelected = selectedTaskId === task.id;
                        const badgeInfo = TASK_TYPE_BADGES[task.type] || { label: 'Task', color: 'bg-slate-800 text-slate-300' };

                        let cardStyle = 'bg-[#181A24] border-[#2B2E3D] text-[#CBD5E1] hover:border-[#3D4258]';
                        if (task.status === 'completed') {
                          cardStyle = 'bg-emerald-950/40 border-emerald-600/50 text-emerald-200 hover:border-emerald-500 shadow-sm';
                        } else if (isRunningThis) {
                          cardStyle = 'bg-sky-950/60 border-sky-400 text-sky-100 ring-2 ring-sky-400/40 shadow-lg animate-pulse';
                        } else if (task.status === 'failed') {
                          cardStyle = 'bg-rose-950/40 border-rose-600/50 text-rose-200 hover:border-rose-500';
                        } else if (task.priority > 0 || task.effectivePriority > 0) {
                          cardStyle = 'bg-amber-950/40 border-amber-500/80 text-amber-200 hover:border-amber-400 ring-1 ring-amber-500/40 shadow-amber-950/30';
                        }

                        // Determine display label
                        const is2Body = task.type === 'TWO_BODY_TRANSFER';
                        const isSeqPc = task.type === 'SEQUENCE_PORKCHOP';

                        return (
                          <div
                            key={task.id}
                            id={`task-node-${task.id}`}
                            onMouseEnter={() => setHoveredTaskId(task.id)}
                            onMouseLeave={() => setHoveredTaskId(null)}
                            onClick={() => setSelectedTaskId(selectedTaskId === task.id ? null : task.id)}
                            className={`group relative p-2 rounded-md border cursor-pointer transition-all duration-150 select-none ${cardStyle} ${
                              isHovered || isSelected ? 'scale-[1.02] z-20 ring-2 ring-indigo-400/60' : ''
                            }`}
                          >
                            {/* Single Line Header: Badge + Label/Title on the SAME line + Status Icon */}
                            <div className="flex items-center justify-between gap-1.5 mb-1">
                              <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider shrink-0 ${badgeInfo.color}`}>
                                  {badgeInfo.label}
                                </span>
                                {is2Body ? (
                                  <span className="text-[11px] font-semibold text-[#E2E8F0] truncate font-mono" title={task.name}>
                                    {task.shortLabel}
                                  </span>
                                ) : isSeqPc ? (
                                  <span className="text-[11px] font-semibold text-[#E2E8F0] tracking-wider truncate font-mono" title={task.name}>
                                    {task.shortLabel}
                                  </span>
                                ) : (
                                  <span className="text-[11px] font-semibold text-[#E2E8F0] truncate leading-tight" title={task.name}>
                                    {task.shortLabel || task.name}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1 shrink-0">
                                {task.status === 'completed' ? (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                ) : isRunningThis ? (
                                  <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin shrink-0" />
                                ) : task.status === 'failed' ? (
                                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                                ) : (
                                  <Clock className="w-3.5 h-3.5 text-[#64748B] shrink-0" />
                                )}
                              </div>
                            </div>

                            {/* Dependencies count and evaluated cost */}
                            <div className="flex items-center justify-between gap-2 pt-0.5 border-t border-white/5 text-[10px] font-mono text-[#94A3B8]">
                              <span>
                                {task.dependencies.length === 0
                                  ? '0 deps'
                                  : `${task.dependencies.length} dep${task.dependencies.length > 1 ? 's' : ''}`}
                              </span>
                              {task.cost !== undefined && task.cost > 0 ? (
                                <span
                                  className="font-semibold text-[#CBD5E1] hover:text-white"
                                  title={`Cost: ${task.cost.toLocaleString()} samples`}
                                >
                                  Cost: {formatCost(task.cost)}
                                </span>
                              ) : (
                                <span className="font-semibold text-[#94A3B8]">Cost: 0</span>
                              )}
                            </div>

                            {/* Mini Progress Bar */}
                            <div className="w-full h-1.5 bg-[#10121A] rounded-full overflow-hidden mt-1">
                              <div
                                className={`h-full transition-all duration-200 ${
                                  task.status === 'completed'
                                    ? 'bg-emerald-400'
                                    : isRunningThis
                                    ? 'bg-sky-400 animate-pulse'
                                    : task.status === 'failed'
                                    ? 'bg-rose-400'
                                    : 'bg-indigo-500'
                                }`}
                                style={{
                                  width: `${task.status === 'completed' ? 100 : Math.max(isRunningThis ? 5 : 0, task.progress)}%`,
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Active / Hovered Task Detail Panel */}
          {activeDetailTask && (
            <div
              id="task-detail-inspector"
              className="p-3.5 rounded-lg bg-[#161822] border border-[#2B2E3E] flex flex-wrap items-center justify-between gap-4 animate-fadeIn"
            >
              <div className="space-y-1 max-w-2xl">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-white">
                    {activeDetailTask.name}
                  </span>
                  <span
                    className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded border uppercase ${
                      activeDetailTask.status === 'completed'
                        ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                        : activeDetailTask.status === 'running'
                        ? 'bg-sky-950 text-sky-300 border-sky-700 animate-pulse'
                        : activeDetailTask.status === 'failed'
                        ? 'bg-rose-950 text-rose-300 border-rose-700'
                        : 'bg-[#252838] text-[#94A3B8] border-[#363A4E]'
                    }`}
                  >
                    Status: {activeDetailTask.status} ({activeDetailTask.progress}%)
                  </span>

                  {activeDetailTask.cost !== undefined && activeDetailTask.cost > 0 && (
                    <span
                      className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950/60 border border-indigo-600/40 text-indigo-300"
                      title="Evaluated computational sample cost"
                    >
                      Cost: {activeDetailTask.cost.toLocaleString()}{' '}
                      {activeDetailTask.type === 'TWO_BODY_TRANSFER' && activeDetailTask.meta ? (
                        `(${activeDetailTask.meta.sampleDep ?? '?'} dep × ${activeDetailTask.meta.sampleArr ?? '?'} arr)`
                      ) : activeDetailTask.type === 'SEQUENCE_PORKCHOP' && activeDetailTask.meta ? (
                        activeDetailTask.meta.instanceCount === 3
                          ? `(${activeDetailTask.meta.sampleDep ?? '?'} dep × ${activeDetailTask.meta.sampleArr ?? '?'} arr × ${activeDetailTask.meta.sampleSecond ?? '?'} inter)`
                          : `(${activeDetailTask.meta.sampleDep ?? '?'} dep × ${activeDetailTask.meta.sampleArr ?? '?'} arr × min(${activeDetailTask.meta.sampleSecond ?? '?'}, ${activeDetailTask.meta.samplePenultimate ?? '?'}))`
                      ) : null}
                    </span>
                  )}

                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/60 border border-amber-600/40 text-amber-300">
                    Priority: {activeDetailTask.priority} (Effective: {activeDetailTask.effectivePriority})
                  </span>
                </div>

                {activeDetailTask.statusText && (
                  <p className="text-[11px] text-sky-300/90 font-mono">
                    ➜ {activeDetailTask.statusText}
                  </p>
                )}

                {/* Dependencies list with visual checkmarks */}
                <div className="flex items-center gap-2 text-[11px] text-[#94A3B8] flex-wrap pt-1">
                  <span className="font-semibold text-[#CBD5E1]">Prerequisites:</span>
                  {activeDetailTask.dependencies.length === 0 ? (
                    <span className="text-emerald-400 font-mono">None (Direct Root Task)</span>
                  ) : (
                    activeDetailTask.dependencies.map(depId => {
                      const depTask = tasks.get(depId);
                      const isDone = depTask?.status === 'completed';
                      return (
                        <span
                          key={depId}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                            isDone
                              ? 'bg-emerald-950/50 border-emerald-700/50 text-emerald-300'
                              : 'bg-[#222534] border-[#333748] text-[#94A3B8]'
                          }`}
                        >
                          {isDone ? '✓' : '⏳'} {depTask?.shortLabel || depId}
                        </span>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Task Actions */}
              <div className="flex items-center gap-2 shrink-0">
                <button
                  id="btn-run-single-task"
                  onClick={() => onSetTaskPriority(activeDetailTask.id, 100, true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-bold text-xs uppercase tracking-wider shadow transition-transform hover:scale-[1.02]"
                >
                  <Zap className="w-3.5 h-3.5 fill-current" />
                  <span>Run Task</span>
                </button>

                <button
                  id="btn-reset-single-task"
                  onClick={() => onResetTask(activeDetailTask.id)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#252838] hover:bg-[#32364a] text-[#CBD5E1] hover:text-white border border-[#3A3E52] text-xs font-medium transition-colors"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Reset</span>
                </button>

                {/* Direct modal opener if available */}
                {activeDetailTask.meta?.linkId && onOpenPorkchop && (
                  <button
                    onClick={() => onOpenPorkchop(activeDetailTask.meta!.linkId!)}
                    className="px-2.5 py-1.5 rounded bg-sky-950/60 hover:bg-sky-900/80 text-sky-300 border border-sky-700/50 text-xs font-medium transition-colors"
                  >
                    View Porkchop
                  </button>
                )}

                {activeDetailTask.meta?.candId && onOpenSequencePorkchop && (
                  <button
                    onClick={() => onOpenSequencePorkchop(activeDetailTask.meta!.candId!)}
                    className="px-2.5 py-1.5 rounded bg-purple-950/60 hover:bg-purple-900/80 text-purple-300 border border-purple-700/50 text-xs font-medium transition-colors"
                  >
                    View Seq Porkchop
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
