/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  SolarSystem,
  CelestialBody,
  InstanceNode,
  DirectionalLink,
  CanvasGraphConfig,
  PorkchopPlotData,
  SequencePorkchopData,
  SubtaskProgressInfo,
  FlyableSequenceResult,
  OrbitalBody
} from './types';
import { getCelestialBodyByName, PRESET_SOLAR_SYSTEMS } from './data/solarSystems';
import { HeaderSelector } from './components/HeaderSelector';
import { CanvasGraph } from './components/CanvasGraph';
import { InstanceModal } from './components/InstanceModal';
import { LinkModal } from './components/LinkModal';
import { PorkchopViewer } from './components/PorkchopViewer';
import { SequencePorkchopViewer } from './components/SequencePorkchopViewer';
import { ResultsTable } from './components/ResultsTable';
import { TisserandPlot } from './components/TisserandPlot';
import { TaskDependencyGraph } from './components/TaskDependencyGraph';
import { AutotestModal } from './components/AutotestModal';
import { C3DebugModal } from './components/C3DebugModal';
import { CheckCircle2, RefreshCw, AlertCircle } from 'lucide-react';
import {
  ComputationTask,
  findNextRunnableTask,
  SequentialTaskWorker,
} from './physics/taskManager';
import {
  runSequenceSearch,
  computePorkchopPlot,
  computeSequencePorkchopPlot,
  findAllSubPathsInGraph,
  propagateDateBounds,
  propagateC3Bounds,
  generateLinkEndDates,
  countPossibleTransfers,
  intersectInstanceDates,
  extractSequencesFromSequencePorkchops,
  applyDateAndTisserandUpdates,
} from './physics/solver';
import { daysToSeconds, parseKSPTimeToUT } from './utils/timeFormat';

export default function App() {
  const [currentSystem, setCurrentSystem] = useState<SolarSystem>(PRESET_SOLAR_SYSTEMS[0]);
  const [mainBodyName, setMainBodyName] = useState<string>('Sun');
  const [timeFormatMode, setTimeFormatMode] = useState<'ksp' | 'earth'>('ksp');

  // Canvas graph state
  const [instances, setInstances] = useState<InstanceNode[]>([]);
  const [links, setLinks] = useState<DirectionalLink[]>([]);

  // Confirmed state for Tisserand Plot & computations
  const [confirmedInstances, setConfirmedInstances] = useState<InstanceNode[]>([]);
  const [confirmedLinks, setConfirmedLinks] = useState<DirectionalLink[]>([]);
  const [hasPendingChanges, setHasPendingChanges] = useState<boolean>(false);

  // Selection & Modal States
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [porkchopModalLinkId, setPorkchopModalLinkId] = useState<string | null>(null);
  const [autotestModalOpen, setAutotestModalOpen] = useState<boolean>(false);
  const [c3DebugInstanceId, setC3DebugInstanceId] = useState<string | null>(null);

  // Results & Search State
  const [porkchops, setPorkchops] = useState<Record<string, PorkchopPlotData>>({});
  const [sequencePorkchops, setSequencePorkchops] = useState<Record<string, SequencePorkchopData>>({});
  const [activeSubtask, setActiveSubtask] = useState<SubtaskProgressInfo | null>(null);
  const [selectedSeqPorkchopId, setSelectedSeqPorkchopId] = useState<string | null>(null);
  const [results, setResults] = useState<FlyableSequenceResult[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchStatusText, setSearchStatusText] = useState<string>('Computing transfers...');
  const stopSearchRef = useRef<boolean>(false);

  const [computingSeqId, setComputingSeqId] = useState<string | null>(null);
  const [computingLinkId, setComputingLinkId] = useState<string | null>(null);

  // Single Sequential Worker States
  const workerRef = useRef<SequentialTaskWorker | null>(null);
  const [taskMap, setTaskMap] = useState<Map<string, ComputationTask>>(new Map());
  const [workerRunning, setWorkerRunning] = useState<boolean>(false);
  const [workerPaused, setWorkerPaused] = useState<boolean>(false);
  const [currentWorkerTaskId, setCurrentWorkerTaskId] = useState<string | null>(null);

  // Keep worker callbacks always updated
  useEffect(() => {
    if (!workerRef.current) {
      workerRef.current = new SequentialTaskWorker();
    }

    workerRef.current.setCallbacks({
      onGraphUpdate: (updatedTasks) => {
        setTaskMap(new Map(updatedTasks));
      },
      onStatusChange: (running, paused, currTask) => {
        setWorkerRunning(running);
        setWorkerPaused(paused);
        setCurrentWorkerTaskId(currTask ? currTask.id : null);
        setIsSearching(running);
        if (!running) {
          setComputingLinkId(null);
          setComputingSeqId(null);
        }
      },
      onTaskStart: (task) => {
        setSearchStatusText(`[Worker] Running: ${task.name}...`);
        if (task.type === 'TWO_BODY_TRANSFER' && task.meta?.linkId) {
          setComputingLinkId(task.meta.linkId);
        } else if (task.type === 'SEQUENCE_PORKCHOP' && task.meta?.candId) {
          setComputingSeqId(task.meta.candId);
        }
      },
      onTaskProgress: (_task, _pct, statusText) => {
        if (statusText) {
          setSearchStatusText(statusText);
        }
      },
      onTaskComplete: (task) => {
        if (task.type === 'TWO_BODY_TRANSFER' && task.meta?.linkId) {
          setComputingLinkId(null);
        } else if (task.type === 'SEQUENCE_PORKCHOP' && task.meta?.candId) {
          setComputingSeqId(null);
        }
      },
      onDataSync: (data) => {
        if (data.porkchops) setPorkchops(prev => ({ ...prev, ...data.porkchops }));
        if (data.sequencePorkchops) setSequencePorkchops(prev => ({ ...prev, ...data.sequencePorkchops }));
        if (data.results) setResults(data.results);
      },
    });
  });

  // Keep worker context updated with latest topology & calculation state
  useEffect(() => {
    if (!workerRef.current) return;

    const activeInsts = confirmedInstances.length > 0 ? confirmedInstances : instances;
    const activeLnks = confirmedLinks.length > 0 ? confirmedLinks : links;

    workerRef.current.updateContext(
      activeInsts,
      activeLnks,
      currentSystem,
      mainBodyName,
      porkchops,
      sequencePorkchops,
      results
    );
  }, [instances, links, confirmedInstances, confirmedLinks, currentSystem, mainBodyName, porkchops, sequencePorkchops, results]);

  const handleStopSearch = () => {
    stopSearchRef.current = true;
    workerRef.current?.stop();
    setIsSearching(false);
    setComputingLinkId(null);
    setComputingSeqId(null);
    setSearchStatusText('Calculations stopped.');
  };

  const handleComputeSingleLinkPorkchop = async (linkId: string, forceRecompute = false) => {
    setPorkchopModalLinkId(linkId);

    const linkTaskId = `task-link-${linkId}`;
    if (forceRecompute) {
      workerRef.current?.resetTask(linkTaskId);
    }

    // Set priority to 100 and execute via sequential worker
    workerRef.current?.setTaskPriority(linkTaskId, 100, true);
  };

  const handleComputeSingleSequencePorkchop = async (seqId: string, pathInsts: InstanceNode[], _isFullPath: boolean) => {
    if (!pathInsts || !Array.isArray(pathInsts) || pathInsts.length < 3) return;
    setSelectedSeqPorkchopId(seqId);

    // Initialize state immediately so the sequence porkchop modal window opens instantly
    if (!sequencePorkchops[seqId]) {
      const seqLabel = pathInsts.map(inst => inst.bodyName).join(' ➔ ');
      const initialSeqData: SequencePorkchopData = {
        id: seqId,
        sequenceLabel: seqLabel,
        instanceCount: pathInsts.length,
        isFullPath: !!_isFullPath,
        sourceBody: pathInsts[0],
        targetBody: pathInsts[pathInsts.length - 1],
        depDates: [],
        arrDates: [],
        c3DepMatrix: [],
        c3ArrMatrix: [],
        totalPoweredDvMatrix: [],
        flybys: [],
        flightTimeMatrix: [],
        physicalValidMatrix: [],
        constraintValidMatrix: [],
        computedSamples: 0,
        totalSamples: 0,
      };
      setSequencePorkchops(prev => ({
        ...prev,
        [seqId]: initialSeqData
      }));
    }

    const seqTaskId = `task-seq-${seqId}`;
    // Set priority to 100 and execute via sequential worker
    workerRef.current?.setTaskPriority(seqTaskId, 100, true);
  };

  // Memoized main celestial body
  const mainBodyObj = useMemo(() => {
    return getCelestialBodyByName(currentSystem, mainBodyName);
  }, [currentSystem, mainBodyName]);

  // Available bodies orbiting selected main body (filter out any body that is not a direct child of the primary central body)
  const availableBodies = useMemo(() => {
    return currentSystem.bodies.filter(
      b => b.referenceBody && b.referenceBody.trim().toLowerCase() === mainBodyName.trim().toLowerCase()
    );
  }, [currentSystem.bodies, mainBodyName]);

  // Load initial preset mission on first mount (Kerbin -> Eve -> Kerbin -> Jool -> Grannus)
  useEffect(() => {
    loadPresetMission('kjug');
    // TODO loadPresetMission('kerbin_grannus');
  }, []);

  // Confirm Updates handler (triggered manually by the user confirmation button)
  const handleConfirmGraphUpdates = () => {
    if (instances.length === 0 || links.length === 0) {
      setHasPendingChanges(false);
      setConfirmedInstances(instances);
      setConfirmedLinks(links);
      return;
    }

    // 1. Deactivate button immediately
    setHasPendingChanges(false);

    // 2. Launch date updates, link end dates & Tisserand plot envelope calculations
    const { updatedInsts, updatedLnks } = applyDateAndTisserandUpdates(instances, links, currentSystem, mainBodyName);

    // 3. Update instances and links state with consolidated bounds & update confirmed snapshot
    setInstances(updatedInsts);
    setLinks(updatedLnks);
    setConfirmedInstances(updatedInsts);
    setConfirmedLinks(updatedLnks);

    // 4. Reset prior sequence search results as graph topology/dates have been updated
    setResults([]);
    setPorkchops({});
    setSequencePorkchops({});
  };

  // Preset Mission Load Handler
  const loadPresetMission = (presetKey: string) => {
    let newInsts: InstanceNode[] = [];
    let newLinks: DirectionalLink[] = [];
    let targetSys: SolarSystem = currentSystem;
    let targetMainBodyName: string = mainBodyName;
    let targetTimeFormat: 'ksp' | 'earth' = timeFormatMode;

    if (presetKey === 'kerbin_grannus') {
      // Kerbin -> Duna -> Kerbin -> Eve -> Jool -> Urlum -> Grannus
      const grannusSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus');
      if (!grannusSys) throw new Error('Preset solar system stock_opm_grannus not found');
      targetSys = grannusSys;
      targetMainBodyName = 'Sun';
      targetTimeFormat = 'ksp';

      const kspDaySec = daysToSeconds(1, 'ksp');
      const kspYearSec = daysToSeconds(426, 'ksp');

      newInsts = [
        {id: 'inst-K1', bodyName: 'Kerbin' , x:  120, y: 320, minDate: (6-1) * kspYearSec, maxDate: (15-1) * kspYearSec, maxC3: 9, isSourceOverride: true},
        {id: 'inst-Du', bodyName: 'Duna'   , x:  220, y: 120, minFlybyAltitude:  70_000},
        {id: 'inst-K2', bodyName: 'Kerbin' , x:  320, y: 320, minFlybyAltitude: 100_000, minDate: (6-1) * kspYearSec, maxDate: (15-1) * kspYearSec, maxC3: 16, isSourceOverride: true},
        {id: 'inst-E1', bodyName: 'Eve'    , x:  420, y: 120, minFlybyAltitude: 100_000},
        {id: 'inst-K3', bodyName: 'Kerbin' , x:  520, y: 320, minFlybyAltitude: 100_000, minDate: (6-1) * kspYearSec, maxDate: (15-1) * kspYearSec, maxC3: 25, isSourceOverride: true},
        {id: 'inst-J',  bodyName: 'Jool'   , x:  720, y: 120, minFlybyAltitude: 300_000, minDate: ( 7.8-1) * kspYearSec, maxDate: (16.2-1) * kspYearSec},  // to reduce search space Y07D403-Y16D060
        {id: 'inst-U',  bodyName: 'Urlum'  , x: 1020, y: 120, minFlybyAltitude: 400_000, minDate: (11.3-1) * kspYearSec, maxDate: (20.8-1) * kspYearSec}, // to reduce search space Y11D183-Y20D32?
        {id: 'inst-G',  bodyName: 'Grannus', x:  920, y: 320, minDate: (42-1) * kspYearSec + (416-1) * kspDaySec, maxDate: (42-1) * kspYearSec + (416-1) * kspDaySec, maxC3: 20, dateSampleCount: 1},
      ];

      newLinks = [
        {id: 'link-K1-Du', sourceInstanceId: 'inst-K1', targetInstanceId: 'inst-Du'},
        {id: 'link-Du-K2', sourceInstanceId: 'inst-Du', targetInstanceId: 'inst-K2'},
        {id: 'link-K2-E1', sourceInstanceId: 'inst-K2', targetInstanceId: 'inst-E1'},
        {id: 'link-E1-K3', sourceInstanceId: 'inst-E1', targetInstanceId: 'inst-K3'},
        {id: 'link-K3-J',  sourceInstanceId: 'inst-K3', targetInstanceId: 'inst-J'},
        {id: 'link-E1-J',  sourceInstanceId: 'inst-E1', targetInstanceId: 'inst-J'},
        {id: 'link-J-U',   sourceInstanceId: 'inst-J',  targetInstanceId: 'inst-U'},
        {id: 'link-U-G',   sourceInstanceId: 'inst-U',  targetInstanceId: 'inst-G', minFlightDuration: daysToSeconds(7500, 'ksp')},
        {id: 'link-J-G',   sourceInstanceId: 'inst-J',  targetInstanceId: 'inst-G', minFlightDuration: daysToSeconds(9500, 'ksp')},
      ];
    } else if (presetKey === 'kjug') {
      // Kerbin -> Jool -> Urlum -> Grannus
      const grannusSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus');
      if (!grannusSys) throw new Error('Preset solar system stock_opm_grannus not found');
      targetSys = grannusSys;
      targetMainBodyName = 'Sun';
      targetTimeFormat = 'ksp';

      const kspDaySec = daysToSeconds(1, 'ksp');
      const kspYearSec = daysToSeconds(426, 'ksp');

      newInsts = [
        {id: 'inst-K3', bodyName: 'Kerbin' , x:  120, y: 320, minDate: (6-1) * kspYearSec, maxDate: (15-1) * kspYearSec, maxC3: 16, isSourceOverride: true},
        {id: 'inst-J',  bodyName: 'Jool'   , x:  720, y: 120, minFlybyAltitude: 300_000, minDate: ( 7.8-1) * kspYearSec, maxDate: (16.2-1) * kspYearSec},  // to reduce search space Y07D403-Y16D060
        {id: 'inst-U',  bodyName: 'Urlum'  , x: 1020, y: 120, minFlybyAltitude: 400_000, minDate: (11.3-1) * kspYearSec, maxDate: (22-1) * kspYearSec}, // to reduce search space Y11D183-Y20D32?
        {id: 'inst-G',  bodyName: 'Grannus', x:  920, y: 320, minDate: (42-1) * kspYearSec + (416-1) * kspDaySec, maxDate: (42-1) * kspYearSec + (416-1) * kspDaySec, maxC3: 20, dateSampleCount: 1},
      ];

      newLinks = [
        {id: 'link-K3-J',  sourceInstanceId: 'inst-K3', targetInstanceId: 'inst-J'},
        {id: 'link-J-U',   sourceInstanceId: 'inst-J',  targetInstanceId: 'inst-U'},
        {id: 'link-U-G',   sourceInstanceId: 'inst-U',  targetInstanceId: 'inst-G', minFlightDuration: daysToSeconds(7500, 'ksp')},
      ];
    } else if (presetKey === 'kej') {
      // Kerbin -> Eve -> Jool
      const stockSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_ksp');
      if (!stockSys) throw new Error('Preset solar system stock_ksp not found');
      targetSys = stockSys;
      targetMainBodyName = 'Sun';
      targetTimeFormat = 'ksp';

      const y10d1 = parseKSPTimeToUT(10, 1, 0, 0, 0, targetTimeFormat);
      newInsts = [
        { id: 'inst-0', bodyName: 'Kerbin', x: 150, y: 220, minDate: 0, maxC3: 25 },
        { id: 'inst-1', bodyName: 'Eve', x: 380, y: 140 },
        { id: 'inst-2', bodyName: 'Jool', x: 840, y: 140, maxDate: y10d1 },
      ];
      newLinks = [
        { id: 'link-0-1', sourceInstanceId: 'inst-0', targetInstanceId: 'inst-1'},
        { id: 'link-1-2', sourceInstanceId: 'inst-1', targetInstanceId: 'inst-2'},
      ];
    } else if (presetKey === 'juice') {
      // JUICE Mission in Real Solar System (Earth -> Venus -> Earth -> Earth -> Jupiter)
      const rssSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'real_solar_system');
      if (!rssSys) throw new Error('Preset solar system real_solar_system not found');
      targetSys = rssSys;
      targetMainBodyName = 'Sun';
      targetTimeFormat = 'earth';

      newInsts = [
        { id: 'inst-0', bodyName: 'Earth', x: 120, y: 220, minDate: 0, maxC3: 30 },
        { id: 'inst-1', bodyName: 'Venus', x: 320, y: 140, minFlybyAltitude: 300000 },
        { id: 'inst-2', bodyName: 'Earth', x: 520, y: 220, minFlybyAltitude: 300000 },
        { id: 'inst-3', bodyName: 'Earth', x: 720, y: 220, minFlybyAltitude: 300000 },
        { id: 'inst-4', bodyName: 'Jupiter', x: 920, y: 140 },
      ];
      newLinks = [
        { id: 'link-0-1', sourceInstanceId: 'inst-0', targetInstanceId: 'inst-1', minFlightDuration: daysToSeconds(80, 'earth'), maxFlightDuration: daysToSeconds(300, 'earth') },
        { id: 'link-1-2', sourceInstanceId: 'inst-1', targetInstanceId: 'inst-2', minFlightDuration: daysToSeconds(100, 'earth'), maxFlightDuration: daysToSeconds(400, 'earth') },
        { id: 'link-2-3', sourceInstanceId: 'inst-2', targetInstanceId: 'inst-3', minFlightDuration: daysToSeconds(300, 'earth'), maxFlightDuration: daysToSeconds(800, 'earth') },
        { id: 'link-3-4', sourceInstanceId: 'inst-3', targetInstanceId: 'inst-4', minFlightDuration: daysToSeconds(600, 'earth'), maxFlightDuration: daysToSeconds(2500, 'earth') },
      ];
    } else if (presetKey === 'grand_tour') {
      // Grand Tour
      const opmSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'outer_planet_mod');
      if (!opmSys) throw new Error('Preset solar system outer_planet_mod not found');
      targetSys = opmSys;
      targetMainBodyName = 'Sun';
      targetTimeFormat = 'ksp';

      newInsts = [
        { id: 'inst-0', bodyName: 'Kerbin', x: 120, y: 220, minDate: 0 },
        { id: 'inst-1', bodyName: 'Eve', x: 320, y: 140 },
        { id: 'inst-2', bodyName: 'Duna', x: 520, y: 220 },
        { id: 'inst-3', bodyName: 'Jool', x: 720, y: 140 },
        { id: 'inst-4', bodyName: 'Sarnus', x: 920, y: 220 },
      ];
      newLinks = [
        { id: 'link-0-1', sourceInstanceId: 'inst-0', targetInstanceId: 'inst-1', minFlightDuration: daysToSeconds(50, 'ksp'), maxFlightDuration: daysToSeconds(250, 'ksp') },
        { id: 'link-1-2', sourceInstanceId: 'inst-1', targetInstanceId: 'inst-2', minFlightDuration: daysToSeconds(100, 'ksp'), maxFlightDuration: daysToSeconds(400, 'ksp') },
        { id: 'link-2-3', sourceInstanceId: 'inst-2', targetInstanceId: 'inst-3', minFlightDuration: daysToSeconds(300, 'ksp'), maxFlightDuration: daysToSeconds(1000, 'ksp') },
        { id: 'link-3-4', sourceInstanceId: 'inst-3', targetInstanceId: 'inst-4', minFlightDuration: daysToSeconds(500, 'ksp'), maxFlightDuration: daysToSeconds(2000, 'ksp') },
      ];
    }

    setCurrentSystem(targetSys);
    setMainBodyName(targetMainBodyName);
    setTimeFormatMode(targetTimeFormat);

    const { updatedInsts, updatedLnks } = applyDateAndTisserandUpdates(newInsts, newLinks, targetSys, targetMainBodyName);
    setInstances(updatedInsts);
    setLinks(updatedLnks);
    setConfirmedInstances(updatedInsts);
    setConfirmedLinks(updatedLnks);
    setHasPendingChanges(false);
    setResults([]);
    setPorkchops({});
    setSequencePorkchops({});
  };

  // Add Instance Node
  const handleAddInstance = (bodyName: string) => {
    const newId = `inst-${Date.now()}`;
    const xPos = 120 + (instances.length % 5) * 180;
    const yPos = 180 + (instances.length % 2) * 80;

    const newInst: InstanceNode = {
      id: newId,
      bodyName,
      x: xPos,
      y: yPos,
    };

    setInstances([...instances, newInst]);
    setHasPendingChanges(true);
  };

  // Remove Instance Node & associated links
  const handleRemoveInstance = (instanceId: string) => {
    setInstances(instances.filter(i => i.id !== instanceId));
    setLinks(links.filter(l => l.sourceInstanceId !== instanceId && l.targetInstanceId !== instanceId));
    if (selectedInstanceId === instanceId) setSelectedInstanceId(null);
    setHasPendingChanges(true);
  };

  // Add Directional Link (preventing loops / self-links)
  const handleAddLink = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      alert('Cannot connect an instance to itself.');
      return;
    }

    // Check if link already exists
    const exists = links.some(l => l.sourceInstanceId === sourceId && l.targetInstanceId === targetId);
    if (exists) return;

    // Check for loops (acyclic constraint)
    if (wouldFormLoop(sourceId, targetId, links)) {
      alert('Cannot add directional link: loops are strictly prohibited in flyby sequences.');
      return;
    }

    const newLink: DirectionalLink = {
      id: `link-${Date.now()}`,
      sourceInstanceId: sourceId,
      targetInstanceId: targetId,
    };

    setLinks([...links, newLink]);
    setHasPendingChanges(true);
  };

  const handleRemoveLink = (linkId: string) => {
    setLinks(links.filter(l => l.id !== linkId));
    if (selectedLinkId === linkId) setSelectedLinkId(null);
    setHasPendingChanges(true);
  };

  const handleUpdateInstancePosition = (id: string, x: number, y: number) => {
    setInstances(insts => insts.map(i => i.id === id ? { ...i, x, y } : i));
  };

  const handleUpdateInstance = (updated: InstanceNode) => {
    setInstances(insts => insts.map(i => i.id === updated.id ? updated : i));
    setHasPendingChanges(true);
  };

  const handleUpdateLink = (updated: DirectionalLink) => {
    setLinks(ls => ls.map(l => l.id === updated.id ? updated : l));
    setHasPendingChanges(true);
  };

  // Export Canvas Configuration JSON
  const handleExportConfig = () => {
    const config: CanvasGraphConfig = {
      version: '1.0',
      solarSystemId: currentSystem.id,
      mainBodyName,
      instances,
      links,
      timeFormatMode,
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `KSP_Flyby_Config_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import Canvas Configuration JSON
  const handleImportConfig = (config: CanvasGraphConfig) => {
    const foundSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === config.solarSystemId);
    const targetSys = foundSys || currentSystem;
    const targetMainBody = config.mainBodyName || mainBodyName;
    if (foundSys) setCurrentSystem(foundSys);
    if (config.mainBodyName) setMainBodyName(config.mainBodyName);
    if (config.timeFormatMode) setTimeFormatMode(config.timeFormatMode);
    const loadedInsts = config.instances || [];
    const loadedLinks = config.links || [];
    const { updatedInsts, updatedLnks } = applyDateAndTisserandUpdates(loadedInsts, loadedLinks, targetSys, targetMainBody);
    setInstances(updatedInsts);
    setLinks(updatedLnks);
    setConfirmedInstances(updatedInsts);
    setConfirmedLinks(updatedLnks);
    setHasPendingChanges(false);
    setResults([]);
    setPorkchops({});
    setSequencePorkchops({});
  };

  // Execute Search Algorithm (Steps 1 through 8 via Sequential Worker)
  const handleSearchSequences = async () => {
    if (instances.length === 0) {
      alert('Please add body instances to the canvas before searching.');
      return;
    }

    if (hasPendingChanges) {
      alert('Please confirm your graph updates first using the "Confirm Updates & Calculate Tisserand" button below the node plot.');
      return;
    }

    stopSearchRef.current = false;
    setIsSearching(true);
    setSearchStatusText('Queued default stepwise sequence search (Priority 100)...');
    workerRef.current?.setTaskPriority('task-search-default', 100, true);
  };

  // Execute Search from Sequence Porkchops (via Sequential Worker)
  const handleSearchSequencesFromPorkchops = async () => {
    if (instances.length === 0 || links.length === 0) {
      alert('Please add body instances and directional links to the canvas before searching.');
      return;
    }

    if (hasPendingChanges) {
      alert('Please confirm your graph updates first using the "Confirm Updates & Calculate Tisserand" button below the node plot.');
      return;
    }

    const activeInsts = confirmedInstances.length > 0 ? confirmedInstances : instances;
    const activeLnks = confirmedLinks.length > 0 ? confirmedLinks : links;

    const candPaths = findAllSubPathsInGraph(activeLnks, activeInsts);
    const fullPathCands = candPaths.filter(c => c.isFullPath && c.pathInsts.length >= 3);

    if (fullPathCands.length === 0) {
      alert('No complete full-path sequence of at least 3 body instances found in the current graph.');
      return;
    }

    stopSearchRef.current = false;
    setIsSearching(true);
    setSearchStatusText('Queued search from sequence porkchops (Priority 100)...');
    workerRef.current?.setTaskPriority('task-search-from-porkchops', 100, true);
  };

  const handleRemoveResult = (seqId: string) => {
    setResults(prev => prev.filter(r => r.id !== seqId));
  };

  const handleClearResults = () => {
    setResults([]);
  };

  const activeInstance = instances.find(i => i.id === selectedInstanceId);
  const activeInstanceBody : OrbitalBody | undefined = activeInstance ? currentSystem.bodies.find(b => b.name === activeInstance.bodyName) : undefined;

  const activeLink = links.find(l => l.id === selectedLinkId);
  const activeLinkSource : InstanceNode | undefined = activeLink ? instances.find(i => i.id === activeLink.sourceInstanceId) : undefined;
  const activeLinkTarget : InstanceNode | undefined = activeLink ? instances.find(i => i.id === activeLink.targetInstanceId) : undefined;

  const activePorkchop = porkchopModalLinkId ? porkchops[porkchopModalLinkId] : undefined;

  // Render dedicated full-page Autotest Inspector if active
  if (autotestModalOpen) {
    return (
      <AutotestModal
        isOpen={true}
        onClose={() => setAutotestModalOpen(false)}
      />
    );
  }

  return (
    <div id="ksp-app-root" className="min-h-screen bg-[#0D0D0E] text-[#E2E8F0] flex flex-col font-sans selection:bg-[#60A5FA] selection:text-black">
      {/* Top Header Bar & Selectors */}
      <HeaderSelector
        currentSystem={currentSystem}
        onSelectSystem={(sys) => {
          setCurrentSystem(sys);
          const defaultMain: CelestialBody = getCelestialBodyByName(sys, 'Sun');
          setMainBodyName(defaultMain.name);
          // Filter instances and links to ensure they belong to the selected system
          const validInsts = instances.filter(i => sys.bodies.some(b => b.name === i.bodyName));
          const validInstIds = new Set(validInsts.map(i => i.id));
          const validLnks = links.filter(l => validInstIds.has(l.sourceInstanceId) && validInstIds.has(l.targetInstanceId));
          const { updatedInsts, updatedLnks } = applyDateAndTisserandUpdates(validInsts, validLnks, sys, defaultMain.name);
          setInstances(updatedInsts);
          setLinks(updatedLnks);
          setConfirmedInstances(updatedInsts);
          setConfirmedLinks(updatedLnks);
          setHasPendingChanges(false);
          setResults([]);
          setPorkchops({});
          setSequencePorkchops({});
        }}
        mainBodyName={mainBodyName}
        onSelectMainBody={setMainBodyName}
        timeFormatMode={timeFormatMode}
        onToggleTimeFormat={setTimeFormatMode}
        onExportConfig={handleExportConfig}
        onImportConfig={handleImportConfig}
        onLoadPresetMission={loadPresetMission}
        onResetCanvas={() => {
          setInstances([]);
          setLinks([]);
          setResults([]);
          setPorkchops({});
        }}
        onOpenAutotest={() => setAutotestModalOpen(true)}
      />

      {/* Main Working Stage */}
      <main className="flex-1 w-full min-w-full px-4 md:px-6 py-4 flex flex-col gap-6">
        {/* Interactive Canvas Graph Editor */}
        <section id="canvas-section" className="w-full min-w-full flex flex-col gap-3">
          <CanvasGraph
            instances={instances}
            links={links}
            availableBodies={availableBodies}
            timeFormatMode={timeFormatMode}
            selectedLinkId={selectedLinkId}
            onSelectLink={setSelectedLinkId}
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={setSelectedInstanceId}
            onAddInstance={handleAddInstance}
            onRemoveInstance={handleRemoveInstance}
            onAddLink={handleAddLink}
            onRemoveLink={handleRemoveLink}
            onUpdateInstancePosition={handleUpdateInstancePosition}
            onOpenPorkchopModal={(linkId) => {
              handleComputeSingleLinkPorkchop(linkId);
            }}
            onInspectC3={(instId) => setC3DebugInstanceId(instId)}
          />

          {/* Manual Graph Confirmation Control below the Node Plot */}
          <div
            id="graph-confirmation-panel"
            className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg border transition-all duration-200 ${
              hasPendingChanges
                ? 'bg-amber-950/40 border-amber-500/50 shadow-lg shadow-amber-950/30'
                : 'bg-[#1A1B1E] border-[#2D2E33]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              {hasPendingChanges ? (
                <>
                  <AlertCircle className="w-5 h-5 text-amber-400 animate-pulse shrink-0" />
                  <div>
                    <span className="text-xs font-semibold text-amber-200">
                      Graph modifications pending confirmation
                    </span>
                    <p className="text-[11px] text-amber-300/80">
                      Click the confirmation button to update dates, transfer bounds, and recalculate the Tisserand plot.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div>
                    <span className="text-xs font-semibold text-[#E2E8F0]">
                      Graph is synchronized & up to date
                    </span>
                    <p className="text-[11px] text-[#94A3B8]">
                      Dates, candidate bounds, and Tisserand envelopes are computed and ready for transfer search.
                    </p>
                  </div>
                </>
              )}
            </div>

            <button
              id="btn-confirm-graph-updates"
              onClick={handleConfirmGraphUpdates}
              disabled={!hasPendingChanges || isSearching}
              className={`flex items-center gap-2 px-4 py-2 rounded text-xs font-medium uppercase tracking-wider transition-all duration-150 shadow ${
                hasPendingChanges && !isSearching
                  ? 'bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-black font-semibold cursor-pointer ring-2 ring-amber-400/40 hover:scale-[1.02]'
                  : 'bg-[#25262B] text-[#64748B] border border-[#334155] cursor-not-allowed opacity-60'
              }`}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${hasPendingChanges ? 'animate-spin-once' : ''}`} />
              <span>Confirm Updates & Calculate Tisserand</span>
            </button>
          </div>
        </section>

        {/* Foldable Task Dependency Graph Section (Sequential Task Worker Engine) */}
        <section id="task-graph-section" className="w-full min-w-full">
          <TaskDependencyGraph
            tasks={taskMap}
            isRunning={workerRunning}
            isPaused={workerPaused}
            currentTaskId={currentWorkerTaskId}
            onSetTaskPriority={(taskId, priority, autoStart) => {
              workerRef.current?.setTaskPriority(taskId, priority, autoStart);
            }}
            onResetTask={(taskId) => {
              workerRef.current?.resetTask(taskId);
              setTaskMap(workerRef.current?.getTasks() || new Map());
            }}
            onResetAllTasks={() => {
              workerRef.current?.resetAllTasks();
              setTaskMap(workerRef.current?.getTasks() || new Map());
            }}
            onStartWorker={() => {
              const runnable = findNextRunnableTask(taskMap);
              if (!runnable || runnable.effectivePriority <= 0) {
                workerRef.current?.runAllPending();
              } else {
                workerRef.current?.start();
              }
            }}
            onPauseWorker={() => {
              workerRef.current?.pause();
            }}
            onResumeWorker={() => {
              workerRef.current?.resume();
            }}
            onStopWorker={() => {
              workerRef.current?.stop();
            }}
            onOpenPorkchop={(linkId) => {
              setPorkchopModalLinkId(linkId);
            }}
            onOpenSequencePorkchop={(seqId) => {
              setSelectedSeqPorkchopId(seqId);
            }}
          />
        </section>

        {/* Foldable Tisserand Plot Section */}
        <section id="tisserand-section" className="w-full min-w-full">
          <TisserandPlot
            instances={confirmedInstances}
            links={confirmedLinks}
            bodies={currentSystem.bodies}
            mainBody={mainBodyObj}
            results={results}
          />
        </section>

        {/* Results & Sequence Search Section */}
        <section id="results-container" className="w-full min-w-full">
          <ResultsTable
            results={results}
            timeFormatMode={timeFormatMode}
            onSearchSequences={handleSearchSequences}
            onSearchSequencesFromPorkchops={handleSearchSequencesFromPorkchops}
            onStopSearch={handleStopSearch}
            onRemoveResult={handleRemoveResult}
            onClearResults={handleClearResults}
            isSearching={isSearching}
            searchStatusText={searchStatusText}
            bodies={currentSystem.bodies}
            mainBody={mainBodyObj}
            porkchops={porkchops}
            onPorkchopUpdate={(newPorkchops) => setPorkchops(prev => ({ ...prev, ...newPorkchops }))}
            sequencePorkchops={sequencePorkchops}
            onOpenSequencePorkchop={(seqPcId) => setSelectedSeqPorkchopId(seqPcId)}
            onComputeSequencePorkchop={handleComputeSingleSequencePorkchop}
            computingSeqId={computingSeqId}
            activeSubtask={activeSubtask}
            links={confirmedLinks.length > 0 ? confirmedLinks : links}
            instances={confirmedInstances.length > 0 ? confirmedInstances : instances}
          />
        </section>
      </main>

      {/* Instance Constraint Modal */}
      {activeInstance && activeInstanceBody && (
        <InstanceModal
          instance={activeInstance}
          body={activeInstanceBody}
          timeFormatMode={timeFormatMode}
          onSave={handleUpdateInstance}
          onClose={() => setSelectedInstanceId(null)}
          onInspectC3={(instId) => setC3DebugInstanceId(instId)}
        />
      )}

      {/* Link Constraint Modal */}
      {activeLink && (
        <LinkModal
          link={activeLink}
          sourceInstance={activeLinkSource}
          targetInstance={activeLinkTarget}
          timeFormatMode={timeFormatMode}
          onSave={handleUpdateLink}
          onRemove={handleRemoveLink}
          onClose={() => setSelectedLinkId(null)}
        />
      )}

      {/* Porkchop Heatmap Plot Modal */}
      {activePorkchop && (
        <PorkchopViewer
          porkchop={activePorkchop}
          timeFormatMode={timeFormatMode}
          isComputing={computingLinkId === porkchopModalLinkId}
          onRecompute={() => {
            if (porkchopModalLinkId) {
              handleComputeSingleLinkPorkchop(porkchopModalLinkId, true);
            }
          }}
          onClose={() => setPorkchopModalLinkId(null)}
        />
      )}

      {/* Sequence Porkchop Plot Modal */}
      {selectedSeqPorkchopId && sequencePorkchops[selectedSeqPorkchopId] && (
        <SequencePorkchopViewer
          seqPorkchop={sequencePorkchops[selectedSeqPorkchopId]}
          timeFormatMode={timeFormatMode}
          onClose={() => setSelectedSeqPorkchopId(null)}
          isComputing={computingSeqId === selectedSeqPorkchopId}
          activeSubtask={activeSubtask}
          porkchops={porkchops}
          sequencePorkchops={sequencePorkchops}
          links={links}
          instances={instances}
          bodies={currentSystem.bodies}
          mainBody={mainBodyObj}
          onRecomputePorkchop={() => {
            const seqData = sequencePorkchops[selectedSeqPorkchopId];
            if (!seqData) return;
            const candPaths = findAllSubPathsInGraph(links, instances);
            const cand = candPaths.find(c => c.id === selectedSeqPorkchopId);
            if (cand && cand.pathInsts && cand.pathInsts.length >= 3) {
              handleComputeSingleSequencePorkchop(cand.id, cand.pathInsts, cand.isFullPath);
            } else if (seqData.flybys && seqData.flybys.length >= 1) {
              handleComputeSingleSequencePorkchop(seqData.id, [seqData.sourceBody, ...seqData.flybys.map(f => f.instance), seqData.targetBody], seqData.isFullPath);
            }
          }}
        />
      )}

      {/* Physics Autotest Suite Modal */}
      <AutotestModal
        isOpen={autotestModalOpen}
        onClose={() => setAutotestModalOpen(false)}
      />

      {/* C3 Tisserand Constraint Investigation Debug Modal */}
      {c3DebugInstanceId && (
        <C3DebugModal
          instanceId={c3DebugInstanceId}
          instances={instances}
          links={links}
          bodies={currentSystem.bodies}
          mainBody={getCelestialBodyByName(currentSystem, mainBodyName)}
          timeFormatMode={timeFormatMode}
          onUpdateInstance={handleUpdateInstance}
          onClose={() => setC3DebugInstanceId(null)}
        />
      )}
    </div>
  );
}

/**
 * Cycle detection helper to prevent loops in directional links
 */
function wouldFormLoop(sourceId: string, targetId: string, links: DirectionalLink[]): boolean {
  // Check if targetId can reach sourceId via existing links
  const visited = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === sourceId) return true; // Loop detected!

    if (!visited.has(curr)) {
      visited.add(curr);
      const outgoing = links.filter(l => l.sourceInstanceId === curr).map(l => l.targetInstanceId);
      queue.push(...outgoing);
    }
  }

  return false;
}
