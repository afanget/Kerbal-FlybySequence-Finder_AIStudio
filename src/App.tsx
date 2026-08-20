/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
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
import { AutotestModal } from './components/AutotestModal';
import { C3DebugModal } from './components/C3DebugModal';
import {
  runSequenceSearch,
  runSequenceSearchAlt,
  computePorkchopPlot,
  computeSequencePorkchopPlot,
  findAllSubPathsInGraph,
  propagateDateBounds,
  propagateC3Bounds,
  generateLinkEndDates,
  countPossibleTransfers,
  intersectInstanceDates,
  extractSequencesFromSequencePorkchops
} from './physics/solver';
import { daysToSeconds, parseKSPTimeToUT } from './utils/timeFormat';

export default function App() {
  const [currentSystem, setCurrentSystem] = useState<SolarSystem>(PRESET_SOLAR_SYSTEMS[0]);
  const [mainBodyName, setMainBodyName] = useState<string>('Sun');
  const [timeFormatMode, setTimeFormatMode] = useState<'ksp' | 'earth'>('ksp');

  // Canvas graph state
  const [instances, setInstances] = useState<InstanceNode[]>([]);
  const [links, setLinks] = useState<DirectionalLink[]>([]);

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

  const handleStopSearch = () => {
    stopSearchRef.current = true;
    setSearchStatusText('Stopping search...');
  };

  const handleComputeSingleLinkPorkchop = async (linkId: string, forceRecompute = false) => {
    setPorkchopModalLinkId(linkId);

    if (!forceRecompute && porkchops[linkId] && porkchops[linkId].c3DepMatrix && porkchops[linkId].c3DepMatrix.length > 0) {
      return;
    }

    const link = links.find(l => l.id === linkId);
    if (!link) return;
    const srcInstance = instances.find(i => i.id === link.sourceInstanceId);
    const tgtInstance = instances.find(i => i.id === link.targetInstanceId);
    if (!srcInstance || !tgtInstance) return;

    const { srcDates, tgtDates } = countPossibleTransfers(link, srcInstance, tgtInstance);

    // Initialize porkchop state immediately so modal opens on frame 1
    if (!porkchops[linkId] || forceRecompute) {
      const initialPcData: PorkchopPlotData = {
        linkId,
        sourceBody: srcInstance.bodyName,
        targetBody: tgtInstance.bodyName,
        depDates: srcDates,
        arrDates: tgtDates,
        c3DepMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill(Infinity)),
        c3ArrMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill(Infinity)),
        dvMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill(Infinity)),
        flightTimeMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill(0)),
        physicalValidMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill(false)),
        constraintValidMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill(false)),
        vTransDepMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill({ x: 0, y: 0, z: 0 })),
        vTransArrMatrix: Array.from({ length: srcDates.length }, () => Array(tgtDates.length).fill({ x: 0, y: 0, z: 0 })),
        computedSamples: 0,
        totalSamples: srcDates.length * tgtDates.length,
      };
      setPorkchops(prev => ({ ...prev, [linkId]: initialPcData }));
    }

    setComputingLinkId(linkId);

    // Yield to the browser event loop so React flushes state and paints PorkchopViewer immediately
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const mainBody : CelestialBody = getCelestialBodyByName(currentSystem, mainBodyName);
      const pcData = await computePorkchopPlot(
        link,
        srcInstance,
        tgtInstance,
        currentSystem.bodies,
        mainBody,
        (msg) => setSearchStatusText(msg),
        (partialPcData) => {
          setPorkchops(prev => ({
            ...prev,
            [linkId]: partialPcData
          }));
        },
        () => stopSearchRef.current
      );
      setPorkchops(prev => ({
        ...prev,
        [linkId]: pcData
      }));
    } catch (err) {
      console.error('Error computing single porkchop:', err);
    } finally {
      setComputingLinkId(null);
    }
  };

  const handleComputeSingleSequencePorkchop = async (seqId: string, pathInsts: InstanceNode[], isFullPath?: boolean) => {
    if (!pathInsts || !Array.isArray(pathInsts) || pathInsts.length < 3) return;
    setComputingSeqId(seqId);
    setSelectedSeqPorkchopId(seqId);

    // Initialize state immediately so the sequence porkchop modal window opens instantly
    if (!sequencePorkchops[seqId]) {
      const srcBody = pathInsts[0]?.bodyName || 'Source';
      const tgtBody = pathInsts[pathInsts.length - 1]?.bodyName || 'Target';
      const seqLabel = pathInsts.map(inst => inst.bodyName).join(' ➔ ');

      const initialSeqData: SequencePorkchopData = {
        id: seqId,
        sequenceLabel: seqLabel,
        instanceCount: pathInsts.length,
        isFullPath: !!isFullPath,
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

    try {
      const mainBody : CelestialBody = getCelestialBodyByName(currentSystem, mainBodyName);
      const seqPcData = await computeSequencePorkchopPlot({
        pathInsts,
        bodies: currentSystem.bodies,
        mainBody,
        onProgress: (msg) => setSearchStatusText(msg),
        onPartialUpdate: (partialSeq) => {
          setSequencePorkchops(prev => ({
            ...prev,
            [seqId]: partialSeq
          }));
        },
        shouldStop: () => stopSearchRef.current,
        isFullPath,
        links,
        porkchops,
        sequencePorkchops,
        onSubtaskProgress: (subtask) => {
          setActiveSubtask(subtask);
          setSequencePorkchops(prev => {
            const current = prev[seqId];
            if (!current) return prev;
            return {
              ...prev,
              [seqId]: {
                ...current,
                activeSubtask: subtask
              }
            };
          });
        },
        onDirectPorkchopUpdate: (newPcs) => {
          setPorkchops(prev => ({ ...prev, ...newPcs }));
        },
        onSequencePorkchopUpdate: (subSeqPc) => {
          setSequencePorkchops(prev => ({
            ...prev,
            [subSeqPc.id]: subSeqPc
          }));
        },
      });
      setSequencePorkchops(prev => ({
        ...prev,
        [seqId]: seqPcData
      }));
    } catch (err) {
      console.error('Error computing sequence porkchop:', err);
      alert('Error computing sequence porkchop: ' + err);
    } finally {
      setActiveSubtask(null);
      setComputingSeqId(null);
    }
  };

  // Available bodies orbiting selected main body (filter out any body that is not a direct child of the primary central body)
  const availableBodies = currentSystem.bodies.filter(
    b => b.referenceBody && b.referenceBody.trim().toLowerCase() === mainBodyName.trim().toLowerCase()
  );

  // Load initial preset mission on first mount (Kerbin -> Eve -> Kerbin -> Jool -> Grannus)
  useEffect(() => {
    loadPresetMission('kjug');
    // TODO loadPresetMission('kerbin_grannus');
  }, []);

  // Auto-propagate date bounds & candidate sample counts whenever instances/links change outside active search
  useEffect(() => {
    if (isSearching || instances.length === 0 || links.length === 0) return;
    const mainBody : CelestialBody = getCelestialBodyByName(currentSystem, mainBodyName);

    let updatedInsts = propagateDateBounds(instances, links);
    let updatedLnks = generateLinkEndDates(updatedInsts, links, currentSystem.bodies, mainBody);
    updatedLnks = updatedLnks.map(link => {
      const src = updatedInsts.find(i => i.id === link.sourceInstanceId);
      const tgt = updatedInsts.find(i => i.id === link.targetInstanceId);
      if (!src || !tgt) return link;
      const { totalPossible } = countPossibleTransfers(link, src, tgt);
      return { ...link, possibleTransfersCount: link.possibleTransfersCount ?? totalPossible };
    });
    updatedInsts = intersectInstanceDates(updatedInsts, updatedLnks, currentSystem.bodies, mainBody);
    updatedInsts = propagateC3Bounds(updatedInsts, updatedLnks, currentSystem.bodies, mainBody);

    // Update if computed bounds or sample counts changed
    setInstances(prev => {
      const changed = prev.some((inst, idx) => {
        const u = updatedInsts[idx];
        return u && (
          inst.computedMinDate !== u.computedMinDate ||
          inst.computedMaxDate !== u.computedMaxDate ||
          inst.computedMinC3 !== u.computedMinC3 ||
          inst.computedMaxC3 !== u.computedMaxC3
        );
      });
      return changed ? updatedInsts : prev;
    });

    setLinks(prev => {
      const changed = prev.some((l, idx) => {
        const u = updatedLnks[idx];
        return u && (
          l.departureSampleCount !== u.departureSampleCount ||
          l.arrivalSampleCount !== u.arrivalSampleCount ||
          (l.possibleTransfersCount === undefined && u.possibleTransfersCount !== undefined)
        );
      });
      return changed ? updatedLnks : prev;
    });
  }, [instances, links, currentSystem, mainBodyName, isSearching]);

  // Preset Mission Load Handler
  const loadPresetMission = (presetKey: string) => {
    let newInsts: InstanceNode[] = [];
    let newLinks: DirectionalLink[] = [];

    if (presetKey === 'kerbin_grannus') {
      // Kerbin -> Duna -> Kerbin -> Eve -> Jool -> Urlum -> Grannus
      const grannusSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
      setCurrentSystem(grannusSys);
      setMainBodyName('Sun');
      setTimeFormatMode('ksp');

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
      const grannusSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
      setCurrentSystem(grannusSys);
      setMainBodyName('Sun');
      setTimeFormatMode('ksp');

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
      const stockSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_ksp') || PRESET_SOLAR_SYSTEMS[0];
      setCurrentSystem(stockSys);
      setMainBodyName('Sun');
      setTimeFormatMode('ksp');

      const y10d1 = parseKSPTimeToUT(10, 1, 0, 0, 0, timeFormatMode);
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
      const rssSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'real_solar_system') || PRESET_SOLAR_SYSTEMS[2];
      setCurrentSystem(rssSys);
      setMainBodyName('Sun');
      setTimeFormatMode('earth');

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
      const opmSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'outer_planet_mod') || PRESET_SOLAR_SYSTEMS[1];
      setCurrentSystem(opmSys);
      setMainBodyName('Sun');
      setTimeFormatMode('ksp');

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

    setInstances(newInsts);
    setLinks(newLinks);
    setResults([]);
    setPorkchops({});
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
  };

  // Remove Instance Node & associated links
  const handleRemoveInstance = (instanceId: string) => {
    setInstances(instances.filter(i => i.id !== instanceId));
    setLinks(links.filter(l => l.sourceInstanceId !== instanceId && l.targetInstanceId !== instanceId));
    if (selectedInstanceId === instanceId) setSelectedInstanceId(null);
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
  };

  const handleRemoveLink = (linkId: string) => {
    setLinks(links.filter(l => l.id !== linkId));
    if (selectedLinkId === linkId) setSelectedLinkId(null);
  };

  const handleUpdateInstancePosition = (id: string, x: number, y: number) => {
    setInstances(insts => insts.map(i => i.id === id ? { ...i, x, y } : i));
  };

  const handleUpdateInstance = (updated: InstanceNode) => {
    setInstances(insts => insts.map(i => i.id === updated.id ? updated : i));
  };

  const handleUpdateLink = (updated: DirectionalLink) => {
    setLinks(ls => ls.map(l => l.id === updated.id ? updated : l));
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
    if (foundSys) setCurrentSystem(foundSys);
    if (config.mainBodyName) setMainBodyName(config.mainBodyName);
    if (config.timeFormatMode) setTimeFormatMode(config.timeFormatMode);
    if (config.instances) setInstances(config.instances);
    if (config.links) setLinks(config.links);
    setResults([]);
    setPorkchops({});
  };

  // Execute Search Algorithm (Steps 1 through 8)
  const handleSearchSequences = async () => {
    if (instances.length === 0) {
      alert('Please add body instances to the canvas before searching.');
      return;
    }

    stopSearchRef.current = false;
    setIsSearching(true);
    setSearchStatusText('Initializing trajectory search...');

    try {
      const mainBody : CelestialBody = getCelestialBodyByName(currentSystem, mainBodyName);
      const res = await runSequenceSearch(
        instances,
        links,
        currentSystem.bodies,
        mainBody,
        (msg) => setSearchStatusText(msg),
        (partial) => {
          if (partial.instances) setInstances(partial.instances);
          if (partial.links) setLinks(partial.links);
          if (partial.porkchops) setPorkchops(prev => ({ ...prev, ...partial.porkchops }));
          if (partial.sequencePorkchops) setSequencePorkchops(prev => ({ ...prev, ...partial.sequencePorkchops }));
        },
        () => stopSearchRef.current
      );

      setInstances(res.updatedInstances);
      setLinks(res.updatedLinks);
      setPorkchops(res.porkchops);
      if (res.sequencePorkchops) setSequencePorkchops(res.sequencePorkchops);
      setResults(res.sequences);
    } catch (err) {
      console.error('Search error:', err);
      alert('Error computing flyby sequence: ' + err);
    } finally {
      setIsSearching(false);
    }
  };

  // Execute Alternative Search Algorithm ("another way")
  const handleSearchSequencesAlt = async () => {
    if (instances.length === 0) {
      alert('Please add body instances to the canvas before searching.');
      return;
    }

    stopSearchRef.current = false;
    setIsSearching(true);
    setSearchStatusText('Initializing alternative trajectory search (direct optimizer)...');

    try {
      const mainBody : CelestialBody = getCelestialBodyByName(currentSystem, mainBodyName);
      const res = await runSequenceSearchAlt(
        instances,
        links,
        currentSystem.bodies,
        mainBody,
        (msg) => setSearchStatusText(msg),
        (partial) => {
          if (partial.instances) setInstances(partial.instances);
          if (partial.links) setLinks(partial.links);
          if (partial.porkchops) setPorkchops(prev => ({ ...prev, ...partial.porkchops }));
          if (partial.sequencePorkchops) setSequencePorkchops(prev => ({ ...prev, ...partial.sequencePorkchops }));
        },
        () => stopSearchRef.current
      );

      setInstances(res.updatedInstances);
      setLinks(res.updatedLinks);
      if (res.porkchops) setPorkchops(res.porkchops);
      if (res.sequencePorkchops) setSequencePorkchops(res.sequencePorkchops);
      setResults(res.sequences);
    } catch (err) {
      console.error('Alt search error:', err);
      alert('Error computing flyby sequence: ' + err);
    } finally {
      setIsSearching(false);
    }
  };

  // Execute Search from Sequence Porkchops
  // Computes all full-path sequence porkchops (if not done yet), then extracts all samples where each flyby delta-v <= 1 m/s
  const handleSearchSequencesFromPorkchops = async () => {
    if (instances.length === 0 || links.length === 0) {
      alert('Please add body instances and directional links to the canvas before searching.');
      return;
    }

    const candPaths = findAllSubPathsInGraph(links, instances);
    const fullPathCands = candPaths.filter(c => c.isFullPath && c.pathInsts.length >= 3);

    if (fullPathCands.length === 0) {
      alert('No complete full-path sequence of at least 3 body instances found in the current graph.');
      return;
    }

    stopSearchRef.current = false;
    setIsSearching(true);
    setSearchStatusText('Preparing full-path sequence porkchops...');

    try {
      const mainBody : CelestialBody = getCelestialBodyByName(currentSystem, mainBodyName);
      const activeSequencePorkchops: Record<string, SequencePorkchopData> = { ...sequencePorkchops };
      const activePorkchops: Record<string, PorkchopPlotData> = { ...porkchops };

      for (let idx = 0; idx < fullPathCands.length; idx++) {
        if (stopSearchRef.current) break;
        const cand = fullPathCands[idx];
        const existing = activeSequencePorkchops[cand.id];

        const isFullyComputed = existing && existing.depDates && existing.depDates.length > 0 &&
          existing.arrDates && existing.arrDates.length > 0 &&
          (existing.constraintValidMatrix || existing.physicalValidMatrix) &&
          existing.computedSamples === existing.totalSamples;

        if (!isFullyComputed) {
          setSearchStatusText(`Computing sequence porkchop for full path ${idx + 1}/${fullPathCands.length}: ${cand.sequenceLabel}...`);
          setComputingSeqId(cand.id);

          const seqPc = await computeSequencePorkchopPlot({
            pathInsts: cand.pathInsts,
            bodies: currentSystem.bodies,
            mainBody,
            links,
            porkchops: activePorkchops,
            sequencePorkchops: activeSequencePorkchops,
            onProgress: (msg) => setSearchStatusText(msg),
            onPartialUpdate: (partialSeq) => {
              activeSequencePorkchops[cand.id] = partialSeq;
              setSequencePorkchops(prev => ({
                ...prev,
                [cand.id]: partialSeq
              }));
            },
            onSubtaskProgress: (subtask) => {
              setActiveSubtask(subtask);
            },
            onDirectPorkchopUpdate: (newPcs) => {
              Object.assign(activePorkchops, newPcs);
              setPorkchops(prev => ({ ...prev, ...newPcs }));
            },
            onSequencePorkchopUpdate: (subSeqPc) => {
              activeSequencePorkchops[subSeqPc.id] = subSeqPc;
              setSequencePorkchops(prev => ({
                ...prev,
                [subSeqPc.id]: subSeqPc
              }));
            },
            shouldStop: () => stopSearchRef.current,
            isFullPath: true,
          });

          activeSequencePorkchops[cand.id] = seqPc;
          setSequencePorkchops(prev => ({
            ...prev,
            [cand.id]: seqPc
          }));
          setComputingSeqId(null);
          setActiveSubtask(null);
        }
      }

      if (stopSearchRef.current) {
        setSearchStatusText('Search stopped by user.');
        return;
      }

      // Extract all samples where each flyby delta-v is <= 1 m/s (no new Lambert compute needed)
      setSearchStatusText('Extracting sequence results with flyby Δv ≤ 1 m/s from computed sequence porkchops...');
      const extractedResults = extractSequencesFromSequencePorkchops(
        activeSequencePorkchops,
        fullPathCands,
        instances,
        currentSystem.bodies,
        mainBody,
        1.0
      );

      setResults(extractedResults);
      setSearchStatusText(`Extracted ${extractedResults.length} validated sequence solution(s) with each flyby Δv ≤ 1 m/s.`);
    } catch (err) {
      console.error('Sequence porkchops search error:', err);
      alert('Error searching sequences from porkchops: ' + err);
    } finally {
      setIsSearching(false);
      setComputingSeqId(null);
      setActiveSubtask(null);
    }
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
          const defaultMain : CelestialBody = getCelestialBodyByName(sys, 'Sun');
          setMainBodyName(defaultMain.name);
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
        <section id="canvas-section" className="w-full min-w-full">
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
        </section>

        {/* Foldable Tisserand Plot Section */}
        <section id="tisserand-section" className="w-full min-w-full">
          <TisserandPlot
            instances={instances}
            links={links}
            bodies={currentSystem.bodies}
            mainBody={getCelestialBodyByName(currentSystem, mainBodyName)}
            results={results}
          />
        </section>

        {/* Results & Sequence Search Section */}
        <section id="results-container" className="w-full min-w-full">
          <ResultsTable
            results={results}
            timeFormatMode={timeFormatMode}
            onSearchSequences={handleSearchSequences}
            onSearchSequencesAlt={handleSearchSequencesAlt}
            onSearchSequencesFromPorkchops={handleSearchSequencesFromPorkchops}
            onStopSearch={handleStopSearch}
            onRemoveResult={handleRemoveResult}
            onClearResults={handleClearResults}
            isSearching={isSearching}
            searchStatusText={searchStatusText}
            bodies={currentSystem.bodies}
            mainBody={getCelestialBodyByName(currentSystem, mainBodyName)}
            porkchops={porkchops}
            onPorkchopUpdate={(newPorkchops) => setPorkchops(prev => ({ ...prev, ...newPorkchops }))}
            sequencePorkchops={sequencePorkchops}
            onOpenSequencePorkchop={(seqPcId) => setSelectedSeqPorkchopId(seqPcId)}
            onComputeSequencePorkchop={handleComputeSingleSequencePorkchop}
            computingSeqId={computingSeqId}
            activeSubtask={activeSubtask}
            links={links}
            instances={instances}
          />
        </section>
      </main>

      {/* Instance Constraint Modal */}
      {activeInstance && (
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
          mainBody={getCelestialBodyByName(currentSystem, mainBodyName)}
          onRecomputePorkchop={() => {
            const seqData = sequencePorkchops[selectedSeqPorkchopId];
            if (!seqData) return;
            const candPaths = findAllSubPathsInGraph(links, instances);
            const cand = candPaths.find(c => c.id === selectedSeqPorkchopId);
            if (cand && cand.pathInsts && cand.pathInsts.length >= 3) {
              handleComputeSingleSequencePorkchop(cand.id, cand.pathInsts, cand.isFullPath);
            } else if (seqData.pathInsts && seqData.pathInsts.length >= 3) {
              handleComputeSingleSequencePorkchop(seqData.id, seqData.pathInsts, seqData.isFullPath);
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
