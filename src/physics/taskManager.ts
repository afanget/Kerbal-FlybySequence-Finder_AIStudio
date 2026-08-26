/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CelestialBody,
  DirectionalLink,
  FlyableSequenceResult,
  InstanceNode,
  OrbitalBody,
  PorkchopPlotData,
  SequencePorkchopData,
  SolarSystem,
  SubtaskProgressInfo,
} from '../types';
import {
  applyDateAndTisserandUpdates,
  CandidateSequencePath,
  computePorkchopPlot,
  computeSequencePorkchopPlot,
  extractSequencesFromSequencePorkchops,
  findAllSubPathsInGraph,
  runSequenceSearch,
} from './solver';

export type ComputationTaskType =
  | 'C3_TISSERAND'
  | 'TWO_BODY_TRANSFER'
  | 'SEQUENCE_PORKCHOP'
  | 'COMPUTE_SEQUENCES_DEFAULT'
  | 'COMPUTE_SEQUENCES_FROM_PORKCHOP';

export type ComputationTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export const MAX_AUTORUN_COST = 1_000_000; // 1e6

export interface ComputationTask {
  id: string;
  type: ComputationTaskType;
  name: string; // Full descriptive name displayed on hover
  shortLabel: string; // Compact abbreviation displayed on graph node
  priority: number; // Base priority: 10 for 2-body, 2 for search-from-porkchops, 100 for user requested
  effectivePriority: number; // Dynamically propagated to dependencies
  dependencies: string[]; // Task IDs that must complete first
  dependents: string[]; // Task IDs that depend on this task
  status: ComputationTaskStatus;
  progress: number; // 0 to 100
  cost?: number; // Evaluated computational sample cost
  statusText?: string;
  error?: string;
  tier: number; // Layer column in visual graph (0 to 4)
  // Execution metadata
  meta?: {
    linkId?: string;
    sourceInstanceId?: string;
    targetInstanceId?: string;
    sourceBodyName?: string;
    targetBodyName?: string;
    pathInsts?: InstanceNode[];
    candId?: string;
    isFullPath?: boolean;
    instanceCount?: number;
    sampleDep?: number;
    sampleArr?: number;
    sampleSecond?: number;
    samplePenultimate?: number;
    targetDepDates?: number[];
    targetArrDates?: number[];
    isPartial?: boolean;
  };
}

/**
 * Helper to get the sample count for a given instance node.
 */
export function getInstanceSampleCount(
  inst: InstanceNode | undefined,
  links: DirectionalLink[],
  existingPorkchops?: Record<string, PorkchopPlotData>
): number {
  if (!inst) return 30;
  if (inst.dateSampleCount !== undefined && inst.dateSampleCount > 0) {
    return inst.dateSampleCount;
  }
  if (inst.validFlybyDates && inst.validFlybyDates.length > 0) {
    return inst.validFlybyDates.length;
  }
  if (existingPorkchops) {
    for (const link of links) {
      const pc = existingPorkchops[link.id];
      if (pc) {
        if (link.sourceInstanceId === inst.id && pc.depDates && pc.depDates.length > 0) {
          return pc.depDates.length;
        }
        if (link.targetInstanceId === inst.id && pc.arrDates && pc.arrDates.length > 0) {
          return pc.arrDates.length;
        }
      }
    }
  }
  for (const link of links) {
    if (link.sourceInstanceId === inst.id && link.departureSampleCount) {
      return link.departureSampleCount;
    }
    if (link.targetInstanceId === inst.id && link.arrivalSampleCount) {
      return link.arrivalSampleCount;
    }
  }
  return 30;
}

/**
 * Builds the complete task dependency graph for the current instances and links.
 */
export function buildTaskGraph(
  instances: InstanceNode[],
  links: DirectionalLink[],
  currentSystem: SolarSystem,
  mainBodyName: string,
  existingPorkchops: Record<string, PorkchopPlotData> = {},
  existingSequencePorkchops: Record<string, SequencePorkchopData> = {},
  existingResults: FlyableSequenceResult[] = [],
  previousTasks: Map<string, ComputationTask> = new Map()
): Map<string, ComputationTask> {
  const taskMap = new Map<string, ComputationTask>();

  if (instances.length === 0) {
    return taskMap;
  }

  // 1. Task: C3 Tisserand Calculation (Tier 0)
  const c3TaskId = 'task-c3-tisserand';
  const prevC3 = previousTasks.get(c3TaskId);
  const isC3Completed = !!(prevC3?.status === 'completed' || instances.some(i => i.computedMinC3 !== undefined));

  taskMap.set(c3TaskId, {
    id: c3TaskId,
    type: 'C3_TISSERAND',
    name: 'Compute C3 & Date Bounds from Tisserand Plot',
    shortLabel: 'C3 & Date Bounds (Tisserand)',
    priority: prevC3 ? prevC3.priority : 10,
    effectivePriority: 0,
    dependencies: [],
    dependents: [],
    status: isC3Completed ? 'completed' : 'pending',
    progress: isC3Completed ? 100 : 0,
    cost: 100,
    tier: 0,
  });

  // 2. Tasks: 2-Body Direct Transfers (Tier 1) - Computed FIRST with priority 10 (if cost <= 1e6)
  const linkTaskIds: string[] = [];
  links.forEach(link => {
    const srcInst = instances.find(i => i.id === link.sourceInstanceId);
    const tgtInst = instances.find(i => i.id === link.targetInstanceId);
    const srcName = srcInst?.bodyName || link.sourceInstanceId;
    const tgtName = tgtInst?.bodyName || link.targetInstanceId;

    const srcAbbr = srcName.slice(0, 3);
    const tgtAbbr = tgtName.slice(0, 3);

    const taskId = `task-link-${link.id}`;
    linkTaskIds.push(taskId);

    const prevLinkTask = previousTasks.get(taskId);
    const existingPc = existingPorkchops[link.id];
    const isLinkCompleted = !!(
      existingPc &&
      existingPc.totalSamples > 0 &&
      existingPc.computedSamples > 0 &&
      existingPc.computedSamples >= existingPc.totalSamples
    );

    // Evaluate departure and arrival sample counts
    const depCount = getInstanceSampleCount(srcInst, links, existingPorkchops);
    const arrCount = getInstanceSampleCount(tgtInst, links, existingPorkchops);
    const cost = depCount * arrCount;

    // Default priority: 10 for autorun first if cost <= 1e6, else 0
    const defaultPriority = cost <= MAX_AUTORUN_COST ? 10 : 0;

    taskMap.set(taskId, {
      id: taskId,
      type: 'TWO_BODY_TRANSFER',
      name: `2-Body Direct Transfer: ${srcName} ➔ ${tgtName}`,
      shortLabel: `${srcAbbr} ➔ ${tgtAbbr}`,
      priority: prevLinkTask !== undefined ? prevLinkTask.priority : defaultPriority,
      effectivePriority: 0,
      dependencies: [c3TaskId],
      dependents: [],
      status: isLinkCompleted ? 'completed' : (prevLinkTask?.status === 'failed' ? 'failed' : 'pending'),
      progress: isLinkCompleted ? 100 : (existingPc && existingPc.totalSamples > 0 ? Math.round((existingPc.computedSamples / existingPc.totalSamples) * 100) : 0),
      cost,
      tier: 1,
      meta: {
        linkId: link.id,
        sourceInstanceId: link.sourceInstanceId,
        targetInstanceId: link.targetInstanceId,
        sourceBodyName: srcName,
        targetBodyName: tgtName,
        sampleDep: depCount,
        sampleArr: arrCount,
      },
    });
  });

  // 3. Tasks: X-Instance Sequence Porkchops (Tier 2 for N=3, Tier 3 for N>3)
  const subPaths = findAllSubPathsInGraph(links, instances);
  // Sort subpaths by length ascending (3 first, then 4, etc.)
  subPaths.sort((a, b) => a.count - b.count);

  const fullPathSeqTaskIds: string[] = [];

  subPaths.forEach(cand => {
    const taskId = `task-seq-${cand.id}`;
    if (cand.isFullPath) {
      fullPathSeqTaskIds.push(taskId);
    }

    const prevSeqTask = previousTasks.get(taskId);
    const existingSeqPc = existingSequencePorkchops[cand.id];
    const isSeqCompleted = !!(
      existingSeqPc &&
      existingSeqPc.totalSamples > 0 &&
      existingSeqPc.computedSamples > 0 &&
      existingSeqPc.computedSamples >= existingSeqPc.totalSamples
    );

    // Determine dependencies:
    // For N = 3: depends on link 0->1 and link 1->2
    // For N > 3: depends on first leg link 0->1 + suffix sequence [1..N-1]
    const deps: string[] = [];

    if (cand.count === 3 && cand.pathInsts.length === 3) {
      const link1 = links.find(l => l.sourceInstanceId === cand.pathInsts[0].id && l.targetInstanceId === cand.pathInsts[1].id);
      const link2 = links.find(l => l.sourceInstanceId === cand.pathInsts[1].id && l.targetInstanceId === cand.pathInsts[2].id);
      if (link1) deps.push(`task-link-${link1.id}`);
      if (link2) deps.push(`task-link-${link2.id}`);
    } else if (cand.count > 3) {
      // 1. Add first leg direct transfer (0 -> 1)
      const firstSrc = cand.pathInsts[0];
      const firstTgt = cand.pathInsts[1];
      const firstLink = links.find(l => l.sourceInstanceId === firstSrc.id && l.targetInstanceId === firstTgt.id);
      if (firstLink) deps.push(`task-link-${firstLink.id}`);

      // 2. Add suffix subsequence [1..N-1]
      const suffixInsts = cand.pathInsts.slice(1);
      const suffixSeqId = `seq-pc-${suffixInsts.map(i => i.id).join('-')}`;
      const suffixTaskCandidate = `task-seq-${suffixSeqId}`;
      if (taskMap.has(suffixTaskCandidate)) {
        deps.push(suffixTaskCandidate);
      } else {
        // Fallback: add remaining individual link dependencies
        for (let i = 1; i < cand.pathInsts.length - 1; i++) {
          const l = links.find(link => link.sourceInstanceId === cand.pathInsts[i].id && link.targetInstanceId === cand.pathInsts[i + 1].id);
          if (l) deps.push(`task-link-${l.id}`);
        }
      }
    }

    const singleLetters = cand.pathInsts.map(i => i.bodyName.trim().charAt(0).toUpperCase()).join('');

    // Evaluate sample counts according to user formulas:
    // SeqPC(3): nb_samples_departure * nb_samples_arrival * nb_samples_2nd_body
    // SeqPC(X>3): nb_samples_departure * nb_samples_arrival * min(nb_samples_2nd_body, nb_samples_(N-2)_body)
    const firstInst = cand.pathInsts[0];
    const lastInst = cand.pathInsts[cand.pathInsts.length - 1];
    const secondInst = cand.pathInsts[1];

    const depCount = getInstanceSampleCount(firstInst, links, existingPorkchops);
    const arrCount = getInstanceSampleCount(lastInst, links, existingPorkchops);
    const secondCount = getInstanceSampleCount(secondInst, links, existingPorkchops);

    let cost = 0;
    let penultimateCount: number | undefined = undefined;

    if (cand.count === 3) {
      cost = depCount * arrCount * secondCount;
    } else {
      const penultimateInst = cand.pathInsts[cand.pathInsts.length - 2];
      penultimateCount = getInstanceSampleCount(penultimateInst, links, existingPorkchops);
      cost = depCount * arrCount * Math.min(secondCount, penultimateCount);
    }

    taskMap.set(taskId, {
      id: taskId,
      type: 'SEQUENCE_PORKCHOP',
      name: `${cand.count}-Instance Porkchop: ${cand.sequenceLabel}`,
      shortLabel: singleLetters,
      priority: prevSeqTask !== undefined ? prevSeqTask.priority : 0,
      effectivePriority: 0,
      dependencies: deps,
      dependents: [],
      status: isSeqCompleted ? 'completed' : (prevSeqTask?.status === 'failed' ? 'failed' : 'pending'),
      progress: isSeqCompleted ? 100 : (existingSeqPc && existingSeqPc.totalSamples > 0 ? Math.round((existingSeqPc.computedSamples / existingSeqPc.totalSamples) * 100) : 0),
      cost,
      tier: cand.count === 3 ? 2 : 3,
      meta: {
        candId: cand.id,
        pathInsts: cand.pathInsts,
        isFullPath: cand.isFullPath,
        instanceCount: cand.count,
        sampleDep: depCount,
        sampleArr: arrCount,
        sampleSecond: secondCount,
        samplePenultimate: penultimateCount,
      },
    });
  });

  // 4. Task: Compute Possible Sequences (Default Stepwise Search) (Tier 4) - Priority 0 (Manual run)
  const defaultSearchTaskId = 'task-search-default';
  const prevDefaultSearch = previousTasks.get(defaultSearchTaskId);
  const isDefaultSearchCompleted = !!(existingResults.length > 0 && prevDefaultSearch?.status === 'completed');

  taskMap.set(defaultSearchTaskId, {
    id: defaultSearchTaskId,
    type: 'COMPUTE_SEQUENCES_DEFAULT',
    name: 'Compute Possible Sequences (Stepwise Default Search)',
    shortLabel: 'Stepwise Sequence Search',
    priority: prevDefaultSearch !== undefined ? prevDefaultSearch.priority : 0,
    effectivePriority: 0,
    dependencies: [...linkTaskIds], // Depends on all 2-body transfers
    dependents: [],
    status: isDefaultSearchCompleted ? 'completed' : 'pending',
    progress: isDefaultSearchCompleted ? 100 : 0,
    tier: 4,
  });

  // 5. Task: Compute Possible Sequences (From Sequence Porkchops) (Tier 4) - Priority 2 (Autolaunch next)
  const fromPcSearchTaskId = 'task-search-from-porkchops';
  const prevFromPcSearch = previousTasks.get(fromPcSearchTaskId);
  const isFromPcSearchCompleted = !!(existingResults.length > 0 && prevFromPcSearch?.status === 'completed');

  taskMap.set(fromPcSearchTaskId, {
    id: fromPcSearchTaskId,
    type: 'COMPUTE_SEQUENCES_FROM_PORKCHOP',
    name: 'Compute Possible Sequences (From Sequence Porkchops Δv ≤ 1 m/s)',
    shortLabel: 'Extract from Seq Porkchops',
    priority: prevFromPcSearch !== undefined ? prevFromPcSearch.priority : 2,
    effectivePriority: 0,
    dependencies: fullPathSeqTaskIds.length > 0 ? [...fullPathSeqTaskIds] : (subPaths.map(s => `task-seq-${s.id}`)),
    dependents: [],
    status: isFromPcSearchCompleted ? 'completed' : 'pending',
    progress: isFromPcSearchCompleted ? 100 : 0,
    cost: 1000,
    tier: 4,
  });

  // Populate dependents array for each task
  taskMap.forEach(task => {
    task.dependencies.forEach(depId => {
      const depTask = taskMap.get(depId);
      if (depTask && !depTask.dependents.includes(task.id)) {
        depTask.dependents.push(task.id);
      }
    });
  });

  // Compute effective priorities
  computeEffectivePriorities(taskMap);

  return taskMap;
}

/**
 * Recursively propagates effective priorities from user-requested tasks down to their dependencies.
 * Respects MAX_AUTORUN_COST (1e6) constraint: tasks with cost > 1e6 will only run if explicitly prioritized (> 10).
 */
export function computeEffectivePriorities(taskMap: Map<string, ComputationTask>): void {
  // Initialize effectivePriority with base priority, clamping autorun priorities if cost > 1e6
  taskMap.forEach(task => {
    const isUserExplicit = task.priority > 10;
    if (!isUserExplicit && (task.cost ?? 0) > MAX_AUTORUN_COST) {
      task.effectivePriority = 0;
    } else {
      task.effectivePriority = task.priority;
    }
  });

  // Helper to propagate priority recursively to all dependencies
  function propagate(taskId: string, targetPriority: number, visited: Set<string>, isUserExplicit: boolean) {
    if (visited.has(taskId)) return;
    visited.add(taskId);

    const task = taskMap.get(taskId);
    if (!task) return;

    // If this is an autorun propagation (not explicit user request) and task cost exceeds 1e6, do not propagate
    if (!isUserExplicit && (task.cost ?? 0) > MAX_AUTORUN_COST) {
      return;
    }

    if (targetPriority > task.effectivePriority) {
      task.effectivePriority = targetPriority;
    }

    // Propagate to all prerequisites (dependencies)
    for (const depId of task.dependencies) {
      propagate(depId, task.effectivePriority, visited, isUserExplicit);
    }
  }

  // Iterate over all tasks sorted by priority descending
  const sortedTasks = Array.from(taskMap.values()).sort((a, b) => b.priority - a.priority);
  for (const task of sortedTasks) {
    if (task.priority > 0) {
      const isUserExplicit = task.priority > 10;
      if (!isUserExplicit && (task.cost ?? 0) > MAX_AUTORUN_COST) {
        continue;
      }
      propagate(task.id, task.priority, new Set<string>(), isUserExplicit);
    }
  }
}

/**
 * Finds the next runnable task in sequence:
 * - Highest effective priority first (effectivePriority must be > 0 to autorun).
 * - If tied, fewest total dependencies first.
 * - If tied, lower tier first.
 * - Task must be 'pending' and ALL dependencies must be 'completed'.
 */
export function findNextRunnableTask(taskMap: Map<string, ComputationTask>): ComputationTask | null {
  computeEffectivePriorities(taskMap);

  const candidateTasks: ComputationTask[] = [];

  taskMap.forEach(task => {
    if (task.status === 'pending') {
      // Check if all dependencies are completed
      const allDepsCompleted = task.dependencies.every(depId => {
        const dep = taskMap.get(depId);
        return dep && dep.status === 'completed';
      });

      if (allDepsCompleted) {
        candidateTasks.push(task);
      }
    }
  });

  if (candidateTasks.length === 0) {
    return null;
  }

  // Sort candidate tasks
  candidateTasks.sort((a, b) => {
    // 1. Highest effective priority first
    if (b.effectivePriority !== a.effectivePriority) {
      return b.effectivePriority - a.effectivePriority;
    }
    // 2. Fewest dependencies first
    if (a.dependencies.length !== b.dependencies.length) {
      return a.dependencies.length - b.dependencies.length;
    }
    // 3. Lower tier first
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    // 4. Stable tie-breaker by id
    return a.id.localeCompare(b.id);
  });

  return candidateTasks[0];
}

export interface TaskWorkerCallbacks {
  onTaskStart?: (task: ComputationTask) => void;
  onTaskProgress?: (task: ComputationTask, progressPct: number, statusText?: string) => void;
  onTaskComplete?: (task: ComputationTask, result?: any) => void;
  onTaskError?: (task: ComputationTask, error: any) => void;
  onGraphUpdate?: (tasks: Map<string, ComputationTask>) => void;
  onAllCompleted?: () => void;
  onStatusChange?: (isRunning: boolean, isPaused: boolean, currentTask: ComputationTask | null) => void;
  onDataSync?: (data: {
    instances?: InstanceNode[];
    links?: DirectionalLink[];
    porkchops?: Record<string, PorkchopPlotData>;
    sequencePorkchops?: Record<string, SequencePorkchopData>;
    results?: FlyableSequenceResult[];
  }) => void;
}

/**
 * Single Worker Class that manages strictly sequential computation execution.
 */
export class SequentialTaskWorker {
  private tasks: Map<string, ComputationTask> = new Map();
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private currentTaskId: string | null = null;
  private stopRequested: boolean = false;
  private callbacks: TaskWorkerCallbacks = {};

  // Context data
  private instances: InstanceNode[] = [];
  private links: DirectionalLink[] = [];
  private currentSystem: SolarSystem | null = null;
  private mainBodyName: string = 'Sun';
  private porkchops: Record<string, PorkchopPlotData> = {};
  private sequencePorkchops: Record<string, SequencePorkchopData> = {};
  private results: FlyableSequenceResult[] = [];

  constructor(callbacks: TaskWorkerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: TaskWorkerCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public updateContext(
    instances: InstanceNode[],
    links: DirectionalLink[],
    currentSystem: SolarSystem,
    mainBodyName: string,
    porkchops: Record<string, PorkchopPlotData>,
    sequencePorkchops: Record<string, SequencePorkchopData>,
    results: FlyableSequenceResult[],
    autoStart: boolean = true
  ) {
    this.instances = instances;
    this.links = links;
    this.currentSystem = currentSystem;
    this.mainBodyName = mainBodyName;
    this.porkchops = porkchops;
    this.sequencePorkchops = sequencePorkchops;
    this.results = results;

    // Refresh task graph with new context while preserving already computed states
    this.tasks = buildTaskGraph(
      instances,
      links,
      currentSystem,
      mainBodyName,
      porkchops,
      sequencePorkchops,
      results,
      this.tasks
    );

    this.callbacks.onGraphUpdate?.(new Map(this.tasks));

    // Auto-start worker if there are runnable tasks with effectivePriority > 0 (e.g. 2-body transfers or sequence porkchops <= 1e6)
    if (autoStart && !this.isRunning && !this.isPaused && !this.stopRequested) {
      const nextTask = findNextRunnableTask(this.tasks);
      if (nextTask && nextTask.effectivePriority > 0) {
        this.start();
      }
    }
  }

  public getTasks(): Map<string, ComputationTask> {
    return new Map(this.tasks);
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      currentTask: this.currentTaskId ? this.tasks.get(this.currentTaskId) || null : null,
      totalCount: this.tasks.size,
      completedCount: Array.from(this.tasks.values()).filter(t => t.status === 'completed').length,
      runningCount: this.currentTaskId ? 1 : 0,
      pendingCount: Array.from(this.tasks.values()).filter(t => t.status === 'pending').length,
      failedCount: Array.from(this.tasks.values()).filter(t => t.status === 'failed').length,
    };
  }

  public setTaskPriority(taskId: string, priority: number, autoStart: boolean = true) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.priority = priority;
    computeEffectivePriorities(this.tasks);
    this.callbacks.onGraphUpdate?.(new Map(this.tasks));

    if (autoStart && !this.isRunning) {
      this.start();
    }
  }

  public async runAllPending() {
    this.tasks.forEach(task => {
      if (task.status === 'pending') {
        task.priority = 50; // User explicit run for all pending tasks
      }
    });
    computeEffectivePriorities(this.tasks);
    this.callbacks.onGraphUpdate?.(new Map(this.tasks));
    await this.start();
  }

  public resetTask(taskId: string, clearCache: boolean = true) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'pending';
    task.progress = 0;
    task.error = undefined;
    task.statusText = undefined;

    if (clearCache) {
      if (task.type === 'TWO_BODY_TRANSFER' && task.meta?.linkId) {
        delete this.porkchops[task.meta.linkId];
      } else if (task.type === 'SEQUENCE_PORKCHOP' && task.meta?.candId) {
        delete this.sequencePorkchops[task.meta.candId];
        delete this.sequencePorkchops[`seq-pc-${task.meta.candId}`];
      } else if (task.type === 'COMPUTE_SEQUENCES_DEFAULT' || task.type === 'COMPUTE_SEQUENCES_FROM_PORKCHOP') {
        this.results = [];
      }
    }

    // Reset dependent tasks recursively as well
    const visited = new Set<string>();
    const resetDependents = (id: string) => {
      const t = this.tasks.get(id);
      if (!t || visited.has(id)) return;
      visited.add(id);
      t.status = 'pending';
      t.progress = 0;
      t.error = undefined;
      t.statusText = undefined;

      if (clearCache) {
        if (t.type === 'TWO_BODY_TRANSFER' && t.meta?.linkId) {
          delete this.porkchops[t.meta.linkId];
        } else if (t.type === 'SEQUENCE_PORKCHOP' && t.meta?.candId) {
          delete this.sequencePorkchops[t.meta.candId];
          delete this.sequencePorkchops[`seq-pc-${t.meta.candId}`];
        } else if (t.type === 'COMPUTE_SEQUENCES_DEFAULT' || t.type === 'COMPUTE_SEQUENCES_FROM_PORKCHOP') {
          this.results = [];
        }
      }

      t.dependents.forEach(depId => resetDependents(depId));
    };

    task.dependents.forEach(depId => resetDependents(depId));

    this.callbacks.onDataSync?.({
      instances: this.instances,
      links: this.links,
      porkchops: this.porkchops,
      sequencePorkchops: this.sequencePorkchops,
      results: this.results,
    });
    this.callbacks.onGraphUpdate?.(new Map(this.tasks));
  }

  public resetAllTasks(clearCache: boolean = true) {
    this.tasks.forEach(task => {
      task.status = 'pending';
      task.progress = 0;
      task.priority = 0;
      task.error = undefined;
      task.statusText = undefined;
    });

    if (clearCache) {
      this.porkchops = {};
      this.sequencePorkchops = {};
      this.results = [];
    }

    this.callbacks.onDataSync?.({
      instances: this.instances,
      links: this.links,
      porkchops: this.porkchops,
      sequencePorkchops: this.sequencePorkchops,
      results: this.results,
    });
    this.callbacks.onGraphUpdate?.(new Map(this.tasks));
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.stopRequested = false;

    this.callbacks.onStatusChange?.(true, false, null);

    try {
      await this.runLoop();
    } finally {
      this.isRunning = false;
      this.currentTaskId = null;
      this.callbacks.onStatusChange?.(false, this.isPaused, null);
    }
  }

  public pause() {
    this.isPaused = true;
    this.callbacks.onStatusChange?.(this.isRunning, true, this.currentTaskId ? this.tasks.get(this.currentTaskId) || null : null);
  }

  public resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.start();
    }
  }

  public stop() {
    this.stopRequested = true;
    this.isPaused = false;
    this.isRunning = false;
    if (this.currentTaskId) {
      const curr = this.tasks.get(this.currentTaskId);
      if (curr && curr.status !== 'failed') {
        curr.status = 'pending';
      }
      this.currentTaskId = null;
    }
    this.tasks.forEach(t => {
      if (t.status === 'running') {
        t.status = 'pending';
      }
    });
    this.callbacks.onStatusChange?.(false, false, null);
    this.callbacks.onGraphUpdate?.(new Map(this.tasks));
  }

  private async runLoop() {
    while (!this.stopRequested && !this.isPaused) {
      const nextTask = findNextRunnableTask(this.tasks);

      if (!nextTask || nextTask.effectivePriority <= 0) {
        // No more runnable tasks with priority > 0
        break;
      }

      this.currentTaskId = nextTask.id;
      nextTask.status = 'running';
      nextTask.progress = nextTask.progress || 5;
      nextTask.error = undefined;

      this.callbacks.onTaskStart?.(nextTask);
      this.callbacks.onStatusChange?.(true, false, nextTask);
      this.callbacks.onGraphUpdate?.(new Map(this.tasks));

      try {
        await this.executeTask(nextTask);

        if (!this.stopRequested) {
          nextTask.status = 'completed';
          nextTask.progress = 100;
          this.callbacks.onTaskComplete?.(nextTask);
          this.callbacks.onDataSync?.({
            instances: this.instances,
            links: this.links,
            porkchops: this.porkchops,
            sequencePorkchops: this.sequencePorkchops,
            results: this.results,
          });
        } else {
          nextTask.status = 'pending';
        }
      } catch (err: any) {
        if (this.stopRequested) {
          nextTask.status = 'pending';
        } else {
          console.error(`Task ${nextTask.name} failed:`, err);
          nextTask.status = 'failed';
          nextTask.error = err?.message || String(err);
          this.callbacks.onTaskError?.(nextTask, err);
        }
      } finally {
        if (this.stopRequested && nextTask.status !== 'failed') {
          nextTask.status = 'pending';
        }
        this.currentTaskId = null;
        this.callbacks.onGraphUpdate?.(new Map(this.tasks));
      }

      // Small yield to UI loop
      await new Promise(r => setTimeout(r, 10));
    }

    if (!this.stopRequested && !this.isPaused) {
      const allDone = Array.from(this.tasks.values()).every(t => t.status === 'completed' || t.priority === 0);
      if (allDone) {
        this.callbacks.onAllCompleted?.();
      }
    }
  }

  private async executeTask(task: ComputationTask): Promise<void> {
    if (!this.currentSystem) throw new Error('No solar system loaded');
    const mainBody = this.currentSystem.bodies.find(b => b.name === this.mainBodyName) || this.currentSystem.mainBody;
    if (!mainBody) throw new Error(`Main body ${this.mainBodyName} not found`);

    const updateProgress = (pct: number, statusText?: string) => {
      if (this.stopRequested) return;
      task.progress = Math.min(100, Math.max(0, pct));
      task.statusText = statusText;
      this.callbacks.onTaskProgress?.(task, task.progress, statusText);
      this.callbacks.onGraphUpdate?.(new Map(this.tasks));
    };

    switch (task.type) {
      case 'C3_TISSERAND': {
        updateProgress(20, 'Propagating date bounds and link constraints...');
        const { updatedInsts, updatedLnks } = applyDateAndTisserandUpdates(
          this.instances,
          this.links,
          this.currentSystem,
          this.mainBodyName
        );
        this.instances = updatedInsts;
        this.links = updatedLnks;
        if (this.stopRequested) return;
        updateProgress(100, 'Tisserand date & C3 envelopes calculated.');
        break;
      }

      case 'TWO_BODY_TRANSFER': {
        const linkId = task.meta?.linkId;
        const link = this.links.find(l => l.id === linkId);
        if (!link) throw new Error(`Link ${linkId} not found`);
        const srcInst = this.instances.find(i => i.id === link.sourceInstanceId);
        const tgtInst = this.instances.find(i => i.id === link.targetInstanceId);
        if (!srcInst || !tgtInst) throw new Error(`Instances for link ${linkId} not found`);

        updateProgress(10, `Computing 2-body porkchop for ${srcInst.bodyName} ➔ ${tgtInst.bodyName}...`);

        let currentTotal = 100;
        let currentComp = 0;
        const pcData = await computePorkchopPlot(
          link,
          srcInst,
          tgtInst,
          this.currentSystem.bodies,
          mainBody,
          (msg) => {
            const pct = currentTotal > 0 ? Math.round((currentComp / currentTotal) * 100) : 0;
            updateProgress(pct, msg);
          },
          (partial) => {
            this.porkchops[link.id] = partial;
            currentTotal = partial.totalSamples || 100;
            currentComp = partial.computedSamples || 0;
            const pct = currentTotal > 0 ? Math.round((currentComp / currentTotal) * 100) : 0;
            updateProgress(pct, `Evaluating direct transfer grid (${pct}%)...`);
          },
          () => this.stopRequested,
          task.meta?.targetDepDates,
          task.meta?.targetArrDates,
          this.porkchops[link.id]
        );

        this.porkchops[link.id] = pcData;
        if (this.stopRequested) return;
        updateProgress(100, `Completed 2-body transfer ${srcInst.bodyName} ➔ ${tgtInst.bodyName}.`);
        break;
      }

      case 'SEQUENCE_PORKCHOP': {
        const candId = task.meta?.candId;
        const pathInsts = task.meta?.pathInsts;
        const isFullPath = !!task.meta?.isFullPath;
        if (!candId || !pathInsts || pathInsts.length < 3) {
          throw new Error(`Invalid sequence porkchop metadata for task ${task.id}`);
        }

        updateProgress(10, `Computing ${pathInsts.length}-instance porkchop...`);

        const seqPc = await computeSequencePorkchopPlot({
          pathInsts,
          bodies: this.currentSystem.bodies,
          mainBody,
          links: this.links,
          porkchops: this.porkchops,
          sequencePorkchops: this.sequencePorkchops,
          isFullPath,
          onProgress: (msg) => updateProgress(task.progress, msg),
          onPartialUpdate: (partialSeq) => {
            this.sequencePorkchops[candId] = partialSeq;
            const total = partialSeq.totalSamples || 100;
            const comp = partialSeq.computedSamples || 0;
            const pct = total > 0 ? Math.round((comp / total) * 100) : 0;
            updateProgress(pct, `Evaluating sequence matrix (${pct}%)...`);
          },
          onSubtaskProgress: (sub) => {
            if (sub) {
              updateProgress(sub.progressPct, sub.statusText);
            }
          },
          onDirectPorkchopUpdate: (newPcs) => {
            Object.assign(this.porkchops, newPcs);
          },
          onSequencePorkchopUpdate: (subSeqPc) => {
            this.sequencePorkchops[subSeqPc.id] = subSeqPc;
          },
          shouldStop: () => this.stopRequested,
          targetDepDates: task.meta?.targetDepDates,
          targetArrDates: task.meta?.targetArrDates,
          existingSeqPorkchop: this.sequencePorkchops[candId] || this.sequencePorkchops[`seq-pc-${candId}`],
        });

        this.sequencePorkchops[candId] = seqPc;
        if (this.stopRequested) return;
        updateProgress(100, `Sequence porkchop completed.`);
        break;
      }

      case 'COMPUTE_SEQUENCES_DEFAULT': {
        updateProgress(10, 'Starting standard stepwise sequence search...');

        const res = await runSequenceSearch(
          this.instances,
          this.links,
          this.currentSystem.bodies,
          mainBody,
          (msg) => updateProgress(task.progress, msg),
          (partial) => {
            if (partial.instances) this.instances = partial.instances;
            if (partial.links) this.links = partial.links;
            if (partial.porkchops) Object.assign(this.porkchops, partial.porkchops);
            if (partial.sequencePorkchops) Object.assign(this.sequencePorkchops, partial.sequencePorkchops);
          },
          () => this.stopRequested
        );

        this.instances = res.updatedInstances;
        this.links = res.updatedLinks;
        this.porkchops = res.porkchops;
        if (res.sequencePorkchops) Object.assign(this.sequencePorkchops, res.sequencePorkchops);
        this.results = res.sequences;

        if (this.stopRequested) return;
        updateProgress(100, `Found ${res.sequences.length} sequence solutions.`);
        break;
      }

      case 'COMPUTE_SEQUENCES_FROM_PORKCHOP': {
        updateProgress(10, 'Extracting sequence solutions with flyby Δv ≤ 1 m/s...');

        const candPaths = findAllSubPathsInGraph(this.links, this.instances);
        const fullPathCands = candPaths.filter(c => c.isFullPath && c.pathInsts.length >= 3);

        const extracted = extractSequencesFromSequencePorkchops(
          this.sequencePorkchops,
          fullPathCands,
          this.instances,
          this.currentSystem.bodies,
          mainBody,
          1.0
        );

        this.results = extracted;
        if (this.stopRequested) return;
        updateProgress(100, `Extracted ${extracted.length} sequence solution(s) with Δv ≤ 1 m/s.`);
        break;
      }
    }
  }
}
