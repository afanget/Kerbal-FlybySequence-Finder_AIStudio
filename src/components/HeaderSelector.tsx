/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef } from 'react';
import { OrbitalBody, CanvasGraphConfig, SolarSystem } from '../types';
import { PRESET_SOLAR_SYSTEMS } from '../data/solarSystems';
import { Globe, Upload, Download, Sparkles, Clock, FileJson, RefreshCw, ShieldCheck } from 'lucide-react';

interface HeaderSelectorProps {
  currentSystem: SolarSystem;
  onSelectSystem: (system: SolarSystem) => void;
  mainBodyName: string;
  onSelectMainBody: (bodyName: string) => void;
  timeFormatMode: 'ksp' | 'earth';
  onToggleTimeFormat: (mode: 'ksp' | 'earth') => void;
  onExportConfig: () => void;
  onImportConfig: (config: CanvasGraphConfig) => void;
  onLoadPresetMission: (presetKey: string) => void;
  onResetCanvas: () => void;
  onOpenAutotest: () => void;
}

export const HeaderSelector: React.FC<HeaderSelectorProps> = ({
  currentSystem,
  onSelectSystem,
  mainBodyName,
  onSelectMainBody,
  timeFormatMode,
  onToggleTimeFormat,
  onExportConfig,
  onImportConfig,
  onLoadPresetMission,
  onResetCanvas,
  onOpenAutotest,
}) => {
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const systemJsonInputRef = useRef<HTMLInputElement>(null);

  // Filter root or key bodies suitable as main bodies
  const availableMainBodies = currentSystem.bodies.filter(
    b => !b.referenceBody || b.name === 'Sun' || b.name === 'Grannus' || b.name === 'Jool' || b.name === 'Kerbin' || b.name === 'Sarnus'
  );

  const handleSystemJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        if (Array.isArray(parsed)) {
          const customSys: SolarSystem = {
            id: `custom-${Date.now()}`,
            name: file.name.replace('.json', ''),
            description: 'User uploaded custom solar system',
            mainBody: undefined, // TODO
            bodies: parsed as OrbitalBody[],
          };
          onSelectSystem(customSys);
        } else if (parsed.bodies && Array.isArray(parsed.bodies)) {
          onSelectSystem(parsed as SolarSystem);
        } else {
          alert('Invalid JSON format for Solar System. Expected an array of CelestialBody objects.');
        }
      } catch (err) {
        alert('Error parsing Solar System JSON file: ' + err);
      }
    };
    reader.readAsText(file);
  };

  const handleConfigJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string) as CanvasGraphConfig;
        if (parsed.instances && parsed.links) {
          onImportConfig(parsed);
        } else {
          alert('Invalid canvas configuration JSON format.');
        }
      } catch (err) {
        alert('Error loading configuration JSON: ' + err);
      }
    };
    reader.readAsText(file);
  };

  return (
    <header id="app-header" className="bg-[#1A1B1E] border-b border-[#2D2E33] text-[#E2E8F0] px-4 md:px-6 py-3.5 shadow-lg w-full">
      <div className="w-full flex flex-col gap-3">
        {/* Top Title & Primary Actions Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#25262B] text-[#60A5FA] rounded border border-[#2D2E33]">
              <Globe className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-serif text-lg font-light tracking-wider text-[#E2E8F0] flex items-center gap-2.5">
                ASTRIA FLYBY PLANNER
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#60A5FA]/10 text-[#60A5FA] border border-[#60A5FA]/30 font-mono font-normal tracking-normal">
                  v1.4.2
                </span>
              </h1>
              <p className="text-[11px] text-[#94A3B8] tracking-wide">
                Gravitational assist trajectories, Lambert transfers & minimum Δv deflection optimizer
              </p>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-2">
            {/* Run Autotest Button */}
            <button
              id="btn-run-autotest"
              onClick={onOpenAutotest}
              className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider text-[#60A5FA] hover:bg-[#60A5FA]/10 border border-[#60A5FA]/30 rounded transition font-medium"
              title="Run automated orbital mechanics and Lambert solver physics autotest"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#60A5FA]" />
              <span>Autotest</span>
            </button>
            {/* Time mode toggle */}
            <button
              id="btn-time-mode-toggle"
              onClick={() => onToggleTimeFormat(timeFormatMode === 'ksp' ? 'earth' : 'ksp')}
              className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider text-[#94A3B8] hover:text-[#E2E8F0] hover:border-[#2D2E33] border border-transparent rounded transition"
              title="Toggle between KSP 6h/day calendar and Earth 24h/day calendar"
            >
              <Clock className="w-3.5 h-3.5 text-[#60A5FA]" />
              <span>Calendar: <strong className="text-[#60A5FA]">{timeFormatMode}</strong></span>
            </button>

            {/* Export Canvas Config JSON */}
            <button
              id="btn-export-config"
              onClick={onExportConfig}
              className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider text-[#94A3B8] hover:text-[#E2E8F0] hover:border-[#2D2E33] border border-transparent rounded transition"
              title="Export current canvas instances and links to JSON file"
            >
              <Download className="w-3.5 h-3.5 text-[#60A5FA]" />
              <span>Export JSON</span>
            </button>

            {/* Import Canvas Config JSON */}
            <button
              id="btn-import-config"
              onClick={() => jsonInputRef.current?.click()}
              className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider text-[#94A3B8] hover:text-[#E2E8F0] hover:border-[#2D2E33] border border-transparent rounded transition"
              title="Import canvas instances and links from JSON file"
            >
              <Upload className="w-3.5 h-3.5 text-[#94A3B8]" />
              <span>Import JSON</span>
            </button>
            <input
              type="file"
              ref={jsonInputRef}
              onChange={handleConfigJsonUpload}
              accept=".json"
              className="hidden"
            />

            {/* Reset Canvas */}
            <button
              id="btn-reset-canvas"
              onClick={onResetCanvas}
              className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider text-[#94A3B8] hover:text-rose-400 hover:border-[#2D2E33] border border-transparent rounded transition"
              title="Clear current canvas nodes"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          </div>
        </div>

        {/* Configuration Row: Solar System & Main Body Selectors */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-4 pt-2.5 border-t border-[#2D2E33] items-center">
          {/* Solar System Selector */}
          <div className="lg:col-span-5 flex flex-col gap-1">
            <label id="label-solar-system" className="text-[11px] uppercase tracking-wider text-[#94A3B8] font-medium flex items-center justify-between">
              <span>Solar System</span>
              <button
                onClick={() => systemJsonInputRef.current?.click()}
                className="text-[10px] text-[#60A5FA] hover:underline flex items-center gap-1 uppercase"
              >
                <FileJson className="w-3 h-3" /> Upload Custom System
              </button>
            </label>
            <select
              id="select-solar-system"
              value={currentSystem.id}
              onChange={(e) => {
                const found = PRESET_SOLAR_SYSTEMS.find(s => s.id === e.target.value);
                if (found) onSelectSystem(found);
              }}
              className="w-full bg-[#25262B] border border-[#2D2E33] text-[#E2E8F0] text-xs rounded px-3 py-1.5 focus:border-[#60A5FA] focus:outline-none"
            >
              {PRESET_SOLAR_SYSTEMS.map(sys => (
                <option key={sys.id} value={sys.id}>
                  {sys.name} ({sys.bodies.length} bodies)
                </option>
              ))}
              {!PRESET_SOLAR_SYSTEMS.some(s => s.id === currentSystem.id) && (
                <option value={currentSystem.id}>{currentSystem.name} (Custom)</option>
              )}
            </select>
            <input
              type="file"
              ref={systemJsonInputRef}
              onChange={handleSystemJsonUpload}
              accept=".json"
              className="hidden"
            />
          </div>

          {/* Main Body Selector */}
          <div className="lg:col-span-3 flex flex-col gap-1">
            <label id="label-main-body" className="text-[11px] uppercase tracking-wider text-[#94A3B8] font-medium">
              Primary Central Body
            </label>
            <select
              id="select-main-body"
              value={mainBodyName}
              onChange={(e) => onSelectMainBody(e.target.value)}
              className="w-full bg-[#25262B] border border-[#2D2E33] text-[#60A5FA] font-mono text-xs rounded px-3 py-1.5 focus:border-[#60A5FA] focus:outline-none"
            >
              {currentSystem.bodies.map(body => (
                <option key={body.name} value={body.name}>
                  {body.name} {body.referenceBody ? `(orbits ${body.referenceBody})` : '(Star / Central)'}
                </option>
              ))}
            </select>
          </div>

          {/* Preset Mission Quick Loader */}
          <div className="lg:col-span-4 flex flex-col gap-1">
            <label id="label-presets" className="text-[11px] uppercase tracking-wider text-[#94A3B8] font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#60A5FA]" /> Preset Missions
            </label>
            <div className="flex flex-wrap gap-1.5">
              <button
                id="preset-kerbin-grannus"
                onClick={() => onLoadPresetMission('kerbin_grannus')}
                className="px-2.5 py-1 bg-[#25262B] hover:bg-[#2D2E33] text-[#E2E8F0] text-[11px] rounded border border-[#2D2E33] transition"
              >
                Kerbin ➔ Grannus
              </button>
              <button
                id="preset-kej"
                onClick={() => onLoadPresetMission('kej')}
                className="px-2.5 py-1 bg-[#25262B] hover:bg-[#2D2E33] text-[#E2E8F0] text-[11px] rounded border border-[#2D2E33] transition"
              >
                Kerbin-Eve-Jool
              </button>
              <button
                id="preset-juice"
                onClick={() => onLoadPresetMission('juice')}
                className="px-2.5 py-1 bg-[#25262B] hover:bg-[#2D2E33] text-[#E2E8F0] text-[11px] rounded border border-[#2D2E33] transition"
              >
                JUICE Mission
              </button>
              <button
                id="preset-grand-tour"
                onClick={() => onLoadPresetMission('grand_tour')}
                className="px-2.5 py-1 bg-[#25262B] hover:bg-[#2D2E33] text-[#E2E8F0] text-[11px] rounded border border-[#2D2E33] transition"
              >
                Grand Tour
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
