/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { InstanceNode, DirectionalLink, CelestialBody, OrbitalBody } from '../types';
import {
  computeC3DebugDetails,
  evaluateSingleVInfForInstance,
  C3DebugCalculationDetails,
  VInfSampleEvaluation,
} from '../utils/c3Debug';
import {
  X,
  Compass,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Zap,
  ArrowRight,
  Info,
  Sliders,
  RotateCcw,
  Sparkles,
  ChevronRight,
  Shield,
  Layers,
} from 'lucide-react';

interface C3DebugModalProps {
  instanceId: string;
  instances: InstanceNode[];
  links: DirectionalLink[];
  bodies: OrbitalBody[];
  mainBody: CelestialBody;
  timeFormatMode: 'ksp' | 'earth';
  onUpdateInstance?: (updated: InstanceNode) => void;
  onClose: () => void;
}

export const C3DebugModal: React.FC<C3DebugModalProps> = ({
  instanceId,
  instances,
  links,
  bodies,
  mainBody,
  timeFormatMode,
  onUpdateInstance,
  onClose,
}) => {
  const details = useMemo<C3DebugCalculationDetails | null>(() => {
    return computeC3DebugDetails(instanceId, instances, links, bodies, mainBody);
  }, [instanceId, instances, links, bodies, mainBody]);

  // Interactive Test C3 State (default to 9.61 if relevant or finalMinC3)
  const initialTestC3 = 9.61;
  const [testC3Input, setTestC3Input] = useState<string>(String(initialTestC3));
  const [activeTab, setActiveTab] = useState<'analysis' | 'sweep' | 'simulator'>('analysis');

  const testC3Value = parseFloat(testC3Input) || 0;
  const testVInfMs = Math.sqrt(Math.max(0, testC3Value)) * 1000;

  const testEvaluation = useMemo<VInfSampleEvaluation | null>(() => {
    if (!details) return null;
    const envelopes: Record<string, { minMs: number; maxMs: number }> = {};
    instances.forEach(i => {
      envelopes[i.id] = { minMs: details.finalMinMs, maxMs: details.finalMaxMs };
    });
    return evaluateSingleVInfForInstance(
      details.instance,
      testVInfMs,
      instances,
      links,
      bodies,
      mainBody,
      envelopes
    );
  }, [details, testVInfMs, instances, links, bodies, mainBody]);

  if (!details) {
    return null;
  }

  const {
    instance,
    body,
    isSource,
    isPureFlyby,
    minFlybyAltitudeKm,
    finalMinC3,
    finalMaxC3,
    finalMinMs,
    finalMaxMs,
    inboundNeighbors,
    outboundNeighbors,
    explanation,
    samples,
    vInf5DegMs,
    c3_5Deg,
  } = details;

  return (
    <div
      id="c3-debug-modal-backdrop"
      className="fixed inset-0 z-50 bg-[#0A0B0E]/90 backdrop-blur-md flex items-center justify-center p-2 sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        id="c3-debug-modal-dialog"
        className="bg-[#12141A] border border-[#2D3344] rounded-xl w-full max-w-5xl shadow-2xl overflow-hidden text-[#E2E8F0] my-auto flex flex-col max-h-[94vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#181B24] border-b border-[#2D3344]">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full border border-white/30 shadow-sm"
              style={{ backgroundColor: body.color || '#60A5FA' }}
            />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-serif text-base uppercase tracking-wider text-white font-bold">
                  C3 Constraint & Tisserand Envelope Investigation
                </h2>
                <span className="text-xs px-2 py-0.5 rounded font-mono bg-[#252B3B] text-[#60A5FA] border border-[#3B455E]">
                  {body.name}
                </span>
                {isSource && (
                  <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-amber-950/60 text-amber-300 border border-amber-800/60">
                    Source Node
                  </span>
                )}
                {isPureFlyby && (
                  <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-purple-950/60 text-purple-300 border border-purple-800/60">
                    Flyby Assist
                  </span>
                )}
                {!isSource && !isPureFlyby && (
                  <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                    Target Arrival
                  </span>
                )}
              </div>
              <p className="text-xs text-[#94A3B8] mt-0.5">
                Exact derivation of the grey C3 envelope and why solutions with lower C3 are rejected.
              </p>
            </div>
          </div>

          <button
            id="btn-close-c3-debug"
            onClick={onClose}
            className="p-1.5 hover:bg-[#252B3B] rounded-lg text-[#94A3B8] hover:text-white transition"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center justify-between px-6 bg-[#151720] border-b border-[#252B3B] text-xs">
          <div className="flex gap-1 py-2">
            <button
              onClick={() => setActiveTab('analysis')}
              className={`px-4 py-1.5 rounded-md font-medium transition ${
                activeTab === 'analysis'
                  ? 'bg-[#252B3B] text-[#60A5FA] border border-[#3B455E]'
                  : 'text-[#94A3B8] hover:text-white hover:bg-[#1A1D27]'
              }`}
            >
              Physics Derivation & Explanation
            </button>
            <button
              onClick={() => setActiveTab('simulator')}
              className={`px-4 py-1.5 rounded-md font-medium transition flex items-center gap-1.5 ${
                activeTab === 'simulator'
                  ? 'bg-[#252B3B] text-[#60A5FA] border border-[#3B455E]'
                  : 'text-[#94A3B8] hover:text-white hover:bg-[#1A1D27]'
              }`}
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              Interactive C3 Evaluator (e.g. 9.61 vs {finalMinC3.toFixed(1)})
            </button>
            <button
              onClick={() => setActiveTab('sweep')}
              className={`px-4 py-1.5 rounded-md font-medium transition ${
                activeTab === 'sweep'
                  ? 'bg-[#252B3B] text-[#60A5FA] border border-[#3B455E]'
                  : 'text-[#94A3B8] hover:text-white hover:bg-[#1A1D27]'
              }`}
            >
              Full v_inf Sweep Table ({samples.length} points)
            </button>
          </div>

          <div className="text-[11px] text-[#94A3B8] font-mono">
            Active Envelope: <strong className="text-white">{finalMinC3.toFixed(1)}</strong> ➔{' '}
            <strong className="text-white">{finalMaxC3.toFixed(1)}</strong> km²/s²
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {/* Top Key Metrics Banner */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-[#181B24] p-3 rounded-lg border border-[#2D3344]">
              <div className="text-[10px] text-[#94A3B8] uppercase tracking-wider font-semibold">
                Tisserand C3 Constraint
              </div>
              <div className="text-lg font-bold font-mono text-[#60A5FA] mt-1">
                {finalMinC3.toFixed(1)} - {finalMaxC3.toFixed(1)}{' '}
                <span className="text-xs font-normal text-[#94A3B8]">km²/s²</span>
              </div>
              <div className="text-[10px] text-[#94A3B8] font-mono mt-0.5">
                v_inf: {(finalMinMs / 1000).toFixed(2)} - {(finalMaxMs / 1000).toFixed(2)} km/s
              </div>
            </div>

            <div className="bg-[#181B24] p-3 rounded-lg border border-[#2D3344]">
              <div className="text-[10px] text-[#94A3B8] uppercase tracking-wider font-semibold">
                Min Flyby Altitude
              </div>
              <div className="text-lg font-bold font-mono text-emerald-400 mt-1">
                {minFlybyAltitudeKm.toFixed(0)}{' '}
                <span className="text-xs font-normal text-[#94A3B8]">km</span>
              </div>
              <div className="text-[10px] text-[#94A3B8] font-mono mt-0.5">
                r_p_min: {(details.minFlybyRadiusM / 1000).toFixed(0)} km from center
              </div>
            </div>

            <div className="bg-[#181B24] p-3 rounded-lg border border-[#2D3344]">
              <div className="text-[10px] text-[#94A3B8] uppercase tracking-wider font-semibold">
                Gravity Turning Limit (5°)
              </div>
              <div className="text-lg font-bold font-mono text-amber-400 mt-1">
                {(vInf5DegMs / 1000).toFixed(1)}{' '}
                <span className="text-xs font-normal text-[#94A3B8]">km/s</span>
              </div>
              <div className="text-[10px] text-[#94A3B8] font-mono mt-0.5">
                Ceiling C3: {c3_5Deg.toFixed(1)} km²/s²
              </div>
            </div>

            <div className="bg-[#181B24] p-3 rounded-lg border border-[#2D3344]">
              <div className="text-[10px] text-[#94A3B8] uppercase tracking-wider font-semibold">
                User C3 Limit
              </div>
              <div className="text-lg font-bold font-mono text-[#E2E8F0] mt-1">
                {details.userMaxC3 !== undefined ? `${details.userMaxC3} km²/s²` : 'None (∞)'}
              </div>
              <div className="text-[10px] text-[#94A3B8] font-mono mt-0.5">
                {isPureFlyby ? 'Flyby (ignores limit)' : 'Applied to source/tgt'}
              </div>
            </div>
          </div>

          {/* TAB 1: Physics Derivation & Explanation */}
          {activeTab === 'analysis' && (
            <div className="space-y-5">
              {/* Highlighted Physics Problem Statement */}
              <div className="bg-amber-950/20 border border-amber-800/40 rounded-lg p-4 text-[#FDE68A] space-y-2">
                <div className="flex items-center gap-2 font-bold text-sm text-amber-300">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  Why is the C3 minimum displayed as {finalMinC3.toFixed(1)} km²/s² when a direct transfer is ~9.61 km²/s²?
                </div>
                <div className="text-xs text-amber-200/90 leading-relaxed whitespace-pre-line">
                  {explanation.whyMinIsHighOrLow}
                </div>
              </div>

              {/* Direct vs Flyby Comparison Table */}
              <div className="bg-[#181B24] border border-[#2D3344] rounded-lg p-4 space-y-3">
                <h3 className="font-semibold text-xs text-white uppercase tracking-wider flex items-center gap-2">
                  <Layers className="w-4 h-4 text-[#60A5FA]" />
                  Direct Transfer vs. Gravity Assist Flyby Comparison
                </h3>
                <div className="text-xs text-[#CBD5E1] leading-relaxed whitespace-pre-line bg-[#12141A] p-3.5 rounded border border-[#252B3B] font-mono">
                  {explanation.directVsFlybyDifference}
                </div>
              </div>

              {/* Graph Neighbors & Pump Angle Geometries */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Inbound Neighbors */}
                <div className="bg-[#181B24] border border-[#2D3344] rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-white uppercase tracking-wider">
                      Inbound Links ({inboundNeighbors.length})
                    </span>
                    <span className="text-[10px] text-[#94A3B8]">Arriving from</span>
                  </div>
                  {inboundNeighbors.length === 0 ? (
                    <div className="text-xs text-[#64748B] italic p-3 bg-[#12141A] rounded border border-[#252B3B]">
                      No inbound links. This node is an initial departure source.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {inboundNeighbors.map(n => (
                        <div
                          key={n.linkId}
                          className="bg-[#12141A] p-2.5 rounded border border-[#252B3B] flex items-center justify-between font-mono text-[11px]"
                        >
                          <div>
                            <strong className="text-purple-300">{n.neighborBodyName}</strong> ➔{' '}
                            <strong className="text-white">{body.name}</strong>
                          </div>
                          <div className="text-[#94A3B8]">
                            C3: {n.neighborEnvelope.minC3} - {n.neighborEnvelope.maxC3} km²/s²
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Outbound Neighbors */}
                <div className="bg-[#181B24] border border-[#2D3344] rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs text-white uppercase tracking-wider">
                      Outbound Links ({outboundNeighbors.length})
                    </span>
                    <span className="text-[10px] text-[#94A3B8]">Departing to</span>
                  </div>
                  {outboundNeighbors.length === 0 ? (
                    <div className="text-xs text-[#64748B] italic p-3 bg-[#12141A] rounded border border-[#252B3B]">
                      No outbound links. This node is a final mission arrival target.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {outboundNeighbors.map(n => (
                        <div
                          key={n.linkId}
                          className="bg-[#12141A] p-2.5 rounded border border-[#252B3B] flex items-center justify-between font-mono text-[11px]"
                        >
                          <div>
                            <strong className="text-white">{body.name}</strong> ➔{' '}
                            <strong className="text-emerald-300">{n.neighborBodyName}</strong>
                          </div>
                          <div className="text-[#94A3B8]">
                            C3: {n.neighborEnvelope.minC3} - {n.neighborEnvelope.maxC3} km²/s²
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Actionable Recommendations */}
              <div className="bg-[#181B24] border border-[#2D3344] rounded-lg p-4 space-y-2.5">
                <h3 className="font-semibold text-xs text-white uppercase tracking-wider flex items-center gap-2">
                  <Info className="w-4 h-4 text-emerald-400" />
                  Recommended Action for Your Mission
                </h3>
                <p className="text-xs text-[#CBD5E1] leading-relaxed whitespace-pre-line">
                  {explanation.recommendation}
                </p>

                {onUpdateInstance && (
                  <div className="pt-2 flex gap-3">
                    {!instance.isSourceOverride && inboundNeighbors.length > 0 && (
                      <button
                        onClick={() => {
                          onUpdateInstance({
                            ...instance,
                            isSourceOverride: true,
                          });
                          onClose();
                        }}
                        className="px-3 py-1.5 bg-[#252B3B] hover:bg-[#333C52] text-[#60A5FA] border border-[#3B455E] rounded text-xs font-semibold transition"
                      >
                        Set as Source Override (Launch Direct from {body.name})
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: Interactive C3 Simulator */}
          {activeTab === 'simulator' && (
            <div className="space-y-5">
              {/* Input Controller & Presets */}
              <div className="bg-[#181B24] border border-[#2D3344] rounded-lg p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-white">
                      Test Specific C3 Departure/Arrival Value:
                    </label>
                    <p className="text-[11px] text-[#94A3B8]">
                      Evaluate why a specific C3 (e.g. 9.61 km²/s²) is accepted or rejected by the Tisserand solver.
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="200"
                      value={testC3Input}
                      onChange={e => setTestC3Input(e.target.value)}
                      className="w-28 px-3 py-1.5 bg-[#12141A] border border-[#3B455E] rounded text-white font-mono text-xs focus:outline-none focus:border-[#60A5FA]"
                    />
                    <span className="font-mono text-xs text-[#94A3B8]">km²/s²</span>
                  </div>
                </div>

                {/* Preset Buttons */}
                <div className="flex flex-wrap gap-2 pt-1 border-t border-[#252B3B]">
                  <span className="text-[10px] text-[#94A3B8] self-center uppercase tracking-wider font-semibold">
                    Presets:
                  </span>
                  <button
                    onClick={() => setTestC3Input('9.61')}
                    className="px-2.5 py-1 bg-[#12141A] hover:bg-[#252B3B] border border-[#2D3344] rounded text-[11px] font-mono text-amber-300 transition"
                  >
                    9.61 km²/s² (Your Test Solution)
                  </button>
                  <button
                    onClick={() => setTestC3Input(finalMinC3.toFixed(2))}
                    className="px-2.5 py-1 bg-[#12141A] hover:bg-[#252B3B] border border-[#2D3344] rounded text-[11px] font-mono text-emerald-300 transition"
                  >
                    {finalMinC3.toFixed(2)} km²/s² (Tisserand Min Threshold)
                  </button>
                  <button
                    onClick={() => setTestC3Input('25.0')}
                    className="px-2.5 py-1 bg-[#12141A] hover:bg-[#252B3B] border border-[#2D3344] rounded text-[11px] font-mono text-[#60A5FA] transition"
                  >
                    25.0 km²/s² (High Energy Orbit)
                  </button>
                </div>
              </div>

              {/* Real-time Simulator Outcome Card */}
              {testEvaluation && (
                <div
                  className={`border rounded-lg p-4 space-y-4 ${
                    testEvaluation.isValid
                      ? 'bg-emerald-950/20 border-emerald-800/40'
                      : 'bg-rose-950/20 border-rose-800/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {testEvaluation.isValid ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-5 h-5 text-rose-400" />
                      )}
                      <div>
                        <div className="text-sm font-bold text-white">
                          Evaluation at C3 = {testEvaluation.c3.toFixed(2)} km²/s² (v_inf ={' '}
                          {testEvaluation.vInfKms.toFixed(2)} km/s)
                        </div>
                        <div
                          className={`text-xs font-semibold ${
                            testEvaluation.isValid ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          {testEvaluation.isValid
                            ? '✓ BALLISTICALLY FEASIBLE (Unpowered gravity assist possible)'
                            : '✗ FEASIBILITY REJECTED (Unpowered deflection impossible)'}
                        </div>
                      </div>
                    </div>

                    {!testEvaluation.isValid && testEvaluation.poweredDvMs > 0 && (
                      <div className="text-right">
                        <div className="text-[10px] uppercase tracking-wider text-[#94A3B8]">
                          Estimated Powered Assist Δv
                        </div>
                        <div className="text-sm font-bold font-mono text-amber-300">
                          {testEvaluation.poweredDvMs.toFixed(0)} m/s
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Physics Geometry Metrics */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-[#12141A]/80 p-3 rounded-lg border border-[#252B3B]">
                    <div>
                      <div className="text-[10px] text-[#94A3B8]">Max Gravity Turn (δ_max)</div>
                      <div className="text-sm font-bold font-mono text-emerald-400">
                        {testEvaluation.deltaMaxDeg.toFixed(1)}°
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#94A3B8]">Required Turn (Δθ_req)</div>
                      <div className="text-sm font-bold font-mono text-amber-400">
                        {testEvaluation.reqDeflectionDeg.toFixed(1)}°
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#94A3B8]">Angular Deficit</div>
                      <div
                        className={`text-sm font-bold font-mono ${
                          testEvaluation.deficitDeg > 0 ? 'text-rose-400' : 'text-emerald-400'
                        }`}
                      >
                        {testEvaluation.deficitDeg > 0 ? `+${testEvaluation.deficitDeg.toFixed(1)}°` : '0° (Satisfied)'}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-[#94A3B8]">Pump Angles (In / Out)</div>
                      <div className="text-sm font-bold font-mono text-[#60A5FA]">
                        {testEvaluation.theta1MinDeg.toFixed(0)}° / {testEvaluation.theta2MinDeg.toFixed(0)}°
                      </div>
                    </div>
                  </div>

                  {/* Detailed Rejection or Success Explanation */}
                  {testEvaluation.rejectionReason && (
                    <div className="text-xs text-rose-200/90 leading-relaxed bg-rose-950/40 p-3 rounded border border-rose-800/30">
                      <strong>Rejection Cause:</strong> {testEvaluation.rejectionReason}
                    </div>
                  )}

                  {testEvaluation.isValid && (
                    <div className="text-xs text-emerald-200/90 leading-relaxed bg-emerald-950/40 p-3 rounded border border-emerald-800/30">
                      <strong>Why this passes:</strong> At v_inf = {testEvaluation.vInfKms.toFixed(2)} km/s, the
                      spacecraft crosses {body.name}'s orbit obliquely with sufficient radial velocity, allowing the
                      inbound pump angle ({testEvaluation.theta1MinDeg.toFixed(1)}°) and outbound pump angle (
                      {testEvaluation.theta2MinDeg.toFixed(1)}°) to close the gap within {body.name}'s gravity
                      turning limit ({testEvaluation.deltaMaxDeg.toFixed(1)}°).
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Full v_inf Sweep Table */}
          {activeTab === 'sweep' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                <span>
                  Discrete evaluation points used by the Tisserand solver to detect the continuous ballistic window.
                </span>
                <span className="font-mono text-emerald-400 font-bold">
                  Threshold: v_inf = {(finalMinMs / 1000).toFixed(2)} km/s (C3 = {finalMinC3.toFixed(1)} km²/s²)
                </span>
              </div>

              <div className="border border-[#2D3344] rounded-lg overflow-hidden max-h-96 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead className="bg-[#181B24] text-[#94A3B8] border-b border-[#2D3344] sticky top-0">
                    <tr>
                      <th className="py-2 px-3">C3 (km²/s²)</th>
                      <th className="py-2 px-3">v_inf (km/s)</th>
                      <th className="py-2 px-3">δ_max</th>
                      <th className="py-2 px-3">θ_in</th>
                      <th className="py-2 px-3">θ_out</th>
                      <th className="py-2 px-3">Δθ_req</th>
                      <th className="py-2 px-3">Deficit</th>
                      <th className="py-2 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#252B3B]">
                    {samples.map((s, idx) => {
                      const isThreshold = Math.abs(s.vInfMs - finalMinMs) < 50;
                      const isUserTest = Math.abs(s.c3 - testC3Value) < 0.1;
                      return (
                        <tr
                          key={idx}
                          className={`hover:bg-[#1C202C] transition ${
                            isUserTest
                              ? 'bg-amber-950/40 text-amber-200 font-bold'
                              : isThreshold
                              ? 'bg-[#1E293B] text-[#60A5FA] font-bold'
                              : s.isValid
                              ? 'text-[#E2E8F0]'
                              : 'text-[#64748B]'
                          }`}
                        >
                          <td className="py-1.5 px-3">
                            {s.c3.toFixed(2)}
                            {isUserTest && (
                              <span className="ml-1 text-[9px] px-1 bg-amber-500/20 text-amber-300 rounded">
                                TEST
                              </span>
                            )}
                            {isThreshold && (
                              <span className="ml-1 text-[9px] px-1 bg-blue-500/20 text-blue-300 rounded">
                                THRESHOLD
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-3">{s.vInfKms.toFixed(2)}</td>
                          <td className="py-1.5 px-3">{s.deltaMaxDeg.toFixed(1)}°</td>
                          <td className="py-1.5 px-3">{s.theta1MinDeg.toFixed(1)}°</td>
                          <td className="py-1.5 px-3">{s.theta2MinDeg.toFixed(1)}°</td>
                          <td className="py-1.5 px-3">{s.reqDeflectionDeg.toFixed(1)}°</td>
                          <td className="py-1.5 px-3">
                            {s.deficitDeg > 0 ? (
                              <span className="text-rose-400">+{s.deficitDeg.toFixed(1)}°</span>
                            ) : (
                              <span className="text-emerald-400">0°</span>
                            )}
                          </td>
                          <td className="py-1.5 px-3">
                            {s.isValid ? (
                              <span className="text-emerald-400 font-bold">✓ Feasible</span>
                            ) : (
                              <span className="text-rose-400">✗ Blocked</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-3 bg-[#181B24] border-t border-[#2D3344] text-xs">
          <div className="text-[#94A3B8] flex items-center gap-1.5">
            <Compass className="w-3.5 h-3.5 text-[#60A5FA]" />
            Tisserand envelopes calculate 3-body ballistic corridor bounds without expensive full Lambert searches.
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-[#252B3B] hover:bg-[#333C52] text-white rounded font-medium transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
