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
  FlyableSequenceResult
} from './types';
import { PRESET_SOLAR_SYSTEMS } from './data/solarSystems';
import { HeaderSelector } from './components/HeaderSelector';
import { CanvasGraph } from './components/CanvasGraph';
import { InstanceModal } from './components/InstanceModal';
import { LinkModal } from './components/LinkModal';
import { PorkchopViewer } from './components/PorkchopViewer';
import { SequencePorkchopViewer } from './components/SequencePorkchopViewer';
import { ResultsTable } from './components/ResultsTable';
import { TisserandPlot } from './components/TisserandPlot';
import { AutotestModal } from './components/AutotestModal';
import {
  runSequenceSearch,
  runSequenceSearchAlt,
  propagateDateBounds,
  generateLinkEndDates,
  countPossibleTransfers,
  intersectInstanceDates
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

  // Results & Search State
  const [porkchops, setPorkchops] = useState<Record<string, PorkchopPlotData>>({});
  const [sequencePorkchops, setSequencePorkchops] = useState<Record<string, SequencePorkchopData>>({});
  const [selectedSeqPorkchopId, setSelectedSeqPorkchopId] = useState<string | null>(null);
  const [results, setResults] = useState<FlyableSequenceResult[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [searchStatusText, setSearchStatusText] = useState<string>('Computing transfers...');
  const stopSearchRef = useRef<boolean>(false);

  const handleStopSearch = () => {
    stopSearchRef.current = true;
    setSearchStatusText('Stopping search...');
  };

  // Available bodies orbiting selected main body (filter out any body that is not a direct child of the primary central body)
  const availableBodies = currentSystem.bodies.filter(
    b => b.referenceBody && b.referenceBody.trim().toLowerCase() === mainBodyName.trim().toLowerCase()
  );

  // Load initial preset mission on first mount (Kerbin -> Eve -> Kerbin -> Jool -> Grannus)
  useEffect(() => {
    loadPresetMission('kerbin_grannus');
  }, []);

  // Auto-propagate date bounds & candidate sample counts whenever instances/links change outside active search
  useEffect(() => {
    if (isSearching || instances.length === 0 || links.length === 0) return;
    const mainBody = currentSystem.bodies.find(b => b.name === mainBodyName) || currentSystem.bodies[0];

    let updatedInsts = propagateDateBounds(instances, links);
    let updatedLnks = generateLinkEndDates(updatedInsts, links, currentSystem.bodies, mainBody);
    updatedLnks = updatedLnks.map(link => {
      const src = updatedInsts.find(i => i.id === link.sourceInstanceId);
      const tgt = updatedInsts.find(i => i.id === link.targetInstanceId);
      if (!src || !tgt) return link;
      const { totalPossible } = countPossibleTransfers(link, src, tgt);
      return { ...link, possibleTransfersCount: link.possibleTransfersCount ?? totalPossible };
    });
    updatedInsts = intersectInstanceDates(updatedInsts, updatedLnks);

    // Update if computed bounds or sample counts changed
    setInstances(prev => {
      const changed = prev.some((inst, idx) => {
        const u = updatedInsts[idx];
        return u && (inst.computedMinDate !== u.computedMinDate || inst.computedMaxDate !== u.computedMaxDate);
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
      // Kerbin -> Eve -> Kerbin -> Jool -> Grannus
      const grannusSys = PRESET_SOLAR_SYSTEMS.find(s => s.id === 'stock_opm_grannus') || PRESET_SOLAR_SYSTEMS[3];
      setCurrentSystem(grannusSys);
      setMainBodyName('Sun');
      setTimeFormatMode('ksp');

      const kspYearSec = daysToSeconds(426, 'ksp');

      newInsts = [
        {id: 'inst-K1', bodyName: 'Kerbin' , x: 120, y: 320, minDate: (6-1) * kspYearSec, maxDate: (15-1) * kspYearSec, maxC3: 100},
        {id: 'inst-E1', bodyName: 'Eve'    , x: 320, y: 120, minFlybyRadius: 100000},
        {id: 'inst-J', bodyName: 'Jool'   , x: 720, y: 120, minFlybyRadius: 210000},
        {id: 'inst-U', bodyName: 'Urlum'  , x: 1020, y: 120, minFlybyRadius: 210000},
        {id: 'inst-G', bodyName: 'Grannus', x: 920, y: 320, minDate: (41-1) * kspYearSec, maxDate: (42-1) * kspYearSec, maxC3: 25, dateSampleCount: 1},
      ];

      newLinks = [
        {id: 'link-K1-E1', sourceInstanceId: 'inst-K1', targetInstanceId: 'inst-E1'},
        {id: 'link-K1-J', sourceInstanceId: 'inst-K1', targetInstanceId: 'inst-J'},
        {id: 'link-E1-J', sourceInstanceId: 'inst-E1', targetInstanceId: 'inst-J'},
        {id: 'link-J-U', sourceInstanceId: 'inst-J', targetInstanceId: 'inst-U'},
        {id: 'link-U-G', sourceInstanceId: 'inst-U', targetInstanceId: 'inst-G', minFlightDuration: daysToSeconds(7500, 'ksp')},
        {id: 'link-J-G', sourceInstanceId: 'inst-J', targetInstanceId: 'inst-G', minFlightDuration: daysToSeconds(9500, 'ksp')},
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
        { id: 'inst-1', bodyName: 'Venus', x: 320, y: 140, minFlybyRadius: 300000 },
        { id: 'inst-2', bodyName: 'Earth', x: 520, y: 220, minFlybyRadius: 300000 },
        { id: 'inst-3', bodyName: 'Earth', x: 720, y: 220, minFlybyRadius: 300000 },
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
      const mainBody = currentSystem.bodies.find(b => b.name === mainBodyName) || currentSystem.bodies[0];
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
      const mainBody = currentSystem.bodies.find(b => b.name === mainBodyName) || currentSystem.bodies[0];
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

  const handleRemoveResult = (seqId: string) => {
    setResults(prev => prev.filter(r => r.id !== seqId));
  };

  const handleClearResults = () => {
    setResults([]);
  };

  const activeInstance = instances.find(i => i.id === selectedInstanceId);
  const activeInstanceBody = activeInstance ? currentSystem.bodies.find(b => b.name === activeInstance.bodyName) : undefined;

  const activeLink = links.find(l => l.id === selectedLinkId);
  const activeLinkSource = activeLink ? instances.find(i => i.id === activeLink.sourceInstanceId) : undefined;
  const activeLinkTarget = activeLink ? instances.find(i => i.id === activeLink.targetInstanceId) : undefined;

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
          const defaultMain = sys.bodies.find(b => !b.referenceBody || b.name === 'Sun') || sys.bodies[0];
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
              // Ensure porkchop is computed or trigger computation
              if (!porkchops[linkId]) {
                handleSearchSequences();
              }
              setPorkchopModalLinkId(linkId);
            }}
          />
        </section>

        {/* Foldable Tisserand Plot Section */}
        <section id="tisserand-section" className="w-full min-w-full">
          <TisserandPlot
            instances={instances}
            bodies={currentSystem.bodies}
            mainBody={currentSystem.bodies.find(b => b.name === mainBodyName) || currentSystem.bodies[0]}
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
            onStopSearch={handleStopSearch}
            onRemoveResult={handleRemoveResult}
            onClearResults={handleClearResults}
            isSearching={isSearching}
            searchStatusText={searchStatusText}
            bodies={currentSystem.bodies}
            mainBody={currentSystem.bodies.find(b => b.name === mainBodyName) || currentSystem.bodies[0]}
            porkchops={porkchops}
            sequencePorkchops={sequencePorkchops}
            onOpenSequencePorkchop={(seqPcId) => setSelectedSeqPorkchopId(seqPcId)}
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
          onClose={() => setPorkchopModalLinkId(null)}
        />
      )}

      {/* 3-Instance Sequence Porkchop Plot Modal */}
      {selectedSeqPorkchopId && sequencePorkchops[selectedSeqPorkchopId] && (
        <SequencePorkchopViewer
          seqPorkchop={sequencePorkchops[selectedSeqPorkchopId]}
          timeFormatMode={timeFormatMode}
          onClose={() => setSelectedSeqPorkchopId(null)}
        />
      )}

      {/* Physics Autotest Suite Modal */}
      <AutotestModal
        isOpen={autotestModalOpen}
        onClose={() => setAutotestModalOpen(false)}
      />
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
