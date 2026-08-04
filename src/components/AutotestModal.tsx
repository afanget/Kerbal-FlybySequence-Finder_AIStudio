/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { runPhysicsAutotestSuite, AutotestSuiteResult, AutotestCaseResult } from '../physics/autotest';
import { X, CheckCircle2, XCircle, Play, Sparkles, Orbit, Compass, Activity, ShieldCheck } from 'lucide-react';

interface AutotestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AutotestModal: React.FC<AutotestModalProps> = ({ isOpen, onClose }) => {
  const [suiteResult, setSuiteResult] = useState<AutotestSuiteResult | null>(() => runPhysicsAutotestSuite());
  const [selectedCaseId, setSelectedCaseId] = useState<string>('orbit-elliptical');

  if (!isOpen) return null;

  const handleRunTests = () => {
    const result = runPhysicsAutotestSuite();
    setSuiteResult(result);
  };

  const selectedCase: AutotestCaseResult | undefined = suiteResult?.cases.find(c => c.caseId === selectedCaseId) || suiteResult?.cases[0];

  const formatNum = (val: number, decimals: number = 4) => {
    if (Math.abs(val) >= 1e6 || (Math.abs(val) < 1e-3 && val !== 0)) {
      return val.toExponential(decimals);
    }
    return val.toFixed(decimals);
  };

  const radToDeg = (rad: number) => (rad * 180 / Math.PI).toFixed(2) + '°';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-[#1A1B1E] border border-[#2D2E33] rounded-xl shadow-2xl w-full max-w-5xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#25262B] border-b border-[#2D2E33]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[#60A5FA]/10 border border-[#60A5FA]/30 rounded-lg text-[#60A5FA]">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-medium text-[#E2E8F0] flex items-center gap-2">
                Orbital Mechanics & Lambert Solver Autotest Suite
                {suiteResult && (
                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-mono font-semibold border ${
                    suiteResult.overallPassed 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                  }`}>
                    {suiteResult.overallPassed ? '✓ ALL TESTS PASSED' : '✗ TEST FAILURES DETECTED'}
                  </span>
                )}
              </h2>
              <p className="text-xs text-[#94A3B8]">
                Automated 4-step verification: Orbit sampling ➔ State generation ➔ Lambert solving ➔ Element reconstruction
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleRunTests}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#60A5FA] hover:bg-blue-500 text-slate-950 font-medium text-xs rounded transition shadow"
            >
              <Play className="w-3.5 h-3.5 fill-slate-950" />
              <span>Re-run Autotest</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 text-[#94A3B8] hover:text-[#E2E8F0] hover:bg-[#2D2E33] rounded transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Content */}
        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-6">
          {/* Test Case Selector Tabs */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {suiteResult?.cases.map((c) => (
              <button
                key={c.caseId}
                onClick={() => setSelectedCaseId(c.caseId)}
                className={`p-3.5 rounded-lg border text-left transition flex flex-col gap-2 relative ${
                  selectedCaseId === c.caseId
                    ? 'bg-[#25262B] border-[#60A5FA] shadow-md'
                    : 'bg-[#1F2024] border-[#2D2E33] hover:border-[#3F4046]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-semibold uppercase tracking-wider text-[#60A5FA]">
                    {c.type} orbit
                  </span>
                  {c.passed ? (
                    <span className="flex items-center gap-1 text-[11px] font-mono text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" /> PASS
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] font-mono text-rose-400 font-medium">
                      <XCircle className="w-3.5 h-3.5" /> FAIL
                    </span>
                  )}
                </div>
                <div className="text-xs font-medium text-[#E2E8F0]">
                  {c.caseName}
                </div>
                <div className="text-[11px] text-[#94A3B8] font-mono">
                  dt: {(c.step2.dt / 86400).toFixed(1)} days | Δv err: {c.step3.errV1.toFixed(3)} m/s
                </div>
              </button>
            ))}
          </div>

          {selectedCase && (
            <div className="flex flex-col gap-5 bg-[#1F2024] border border-[#2D2E33] rounded-xl p-5">
              {/* Case Summary */}
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#2D2E33]">
                <div>
                  <h3 className="text-sm font-semibold text-[#E2E8F0] flex items-center gap-2">
                    <Orbit className="w-4 h-4 text-[#60A5FA]" />
                    {selectedCase.caseName}
                  </h3>
                  <p className="text-xs text-[#94A3B8]">
                    Gravitational Parameter μ: <span className="font-mono text-[#E2E8F0]">{formatNum(selectedCase.mu)} m³/s²</span>
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-[11px] text-[#94A3B8] uppercase tracking-wider font-medium">Lambert Speed Match</div>
                    <div className={`text-xs font-mono font-semibold ${selectedCase.step3.passed ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {selectedCase.step3.passed ? '✓ Valid (Err < 0.5%)' : '✗ Invalid / Mismatch'}
                    </div>
                  </div>
                  <div className="h-8 w-[1px] bg-[#2D2E33]" />
                  <div className="text-right">
                    <div className="text-[11px] text-[#94A3B8] uppercase tracking-wider font-medium">Element Coherence</div>
                    <div className={`text-xs font-mono font-semibold ${selectedCase.step4.passed ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {selectedCase.step4.passed ? '✓ Coherent (< 1% diff)' : '✗ Incoherent'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Step Breakdown Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Step 1 & 2 Card */}
                <div className="bg-[#25262B] border border-[#2D2E33] rounded-lg p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#60A5FA] uppercase tracking-wider">
                    <span className="flex items-center gap-1.5"><Compass className="w-3.5 h-3.5" /> 1 & 2. State Generation</span>
                    <span className="text-[10px] text-[#94A3B8] font-mono">t1={selectedCase.step2.t1}s ➔ t2={selectedCase.step2.t2}s</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-[#1A1B1E] p-3 rounded border border-[#2D2E33]">
                    <div><span className="text-[#94A3B8]">SMA (a):</span> {formatNum(selectedCase.initialOrbit.semiMajorAxis)} m</div>
                    <div><span className="text-[#94A3B8]">Ecc (e):</span> {formatNum(selectedCase.initialOrbit.eccentricity)}</div>
                    <div><span className="text-[#94A3B8]">Inc (i):</span> {radToDeg(selectedCase.initialOrbit.inclination)}</div>
                    <div><span className="text-[#94A3B8]">RAAN (Ω):</span> {radToDeg(selectedCase.initialOrbit.ascNodeLongitude)}</div>
                    <div><span className="text-[#94A3B8]">ArgPeri (ω):</span> {radToDeg(selectedCase.initialOrbit.argOfPeriapsis)}</div>
                    <div><span className="text-[#94A3B8]">Mean Anom:</span> {selectedCase.initialOrbit.meanAnomalyEpoch.toFixed(4)} rad</div>
                  </div>

                  <div className="flex flex-col gap-1.5 text-xs font-mono text-[#E2E8F0]">
                    <div className="text-[11px] text-[#94A3B8] uppercase font-semibold">Generated State Vectors:</div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-[#60A5FA]">r1:</span> [{formatNum(selectedCase.step2.pos1.x, 2)}, {formatNum(selectedCase.step2.pos1.y, 2)}, {formatNum(selectedCase.step2.pos1.z, 2)}] m
                    </div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-[#60A5FA]">v1:</span> [{formatNum(selectedCase.step2.vel1.x, 2)}, {formatNum(selectedCase.step2.vel1.y, 2)}, {formatNum(selectedCase.step2.vel1.z, 2)}] m/s
                    </div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-[#60A5FA]">r2:</span> [{formatNum(selectedCase.step2.pos2.x, 2)}, {formatNum(selectedCase.step2.pos2.y, 2)}, {formatNum(selectedCase.step2.pos2.z, 2)}] m
                    </div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-[#60A5FA]">v2:</span> [{formatNum(selectedCase.step2.vel2.x, 2)}, {formatNum(selectedCase.step2.vel2.y, 2)}, {formatNum(selectedCase.step2.vel2.z, 2)}] m/s
                    </div>
                  </div>
                </div>

                {/* Step 3: Lambert Verification */}
                <div className="bg-[#25262B] border border-[#2D2E33] rounded-lg p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#60A5FA] uppercase tracking-wider">
                    <span className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> 3. Lambert Solver Check</span>
                    <span className={`text-[11px] font-mono font-bold ${selectedCase.step3.passed ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {selectedCase.step3.passed ? 'PASS' : 'FAIL'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5 text-xs font-mono">
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-emerald-400">v1 (Lambert):</span> [{formatNum(selectedCase.step3.v1Lambert.x, 2)}, {formatNum(selectedCase.step3.v1Lambert.y, 2)}, {formatNum(selectedCase.step3.v1Lambert.z, 2)}] m/s
                    </div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-[#94A3B8]">v1 (Actual):</span> [{formatNum(selectedCase.step2.vel1.x, 2)}, {formatNum(selectedCase.step2.vel1.y, 2)}, {formatNum(selectedCase.step2.vel1.z, 2)}] m/s
                    </div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-emerald-400">v1 (Lambert):</span> [{formatNum(selectedCase.step3.v2Lambert.x, 2)}, {formatNum(selectedCase.step3.v2Lambert.y, 2)}, {formatNum(selectedCase.step3.v2Lambert.z, 2)}] m/s
                    </div>
                    <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                      <span className="text-[#94A3B8]">v1 (Actual):</span> [{formatNum(selectedCase.step2.vel2.x, 2)}, {formatNum(selectedCase.step2.vel2.y, 2)}, {formatNum(selectedCase.step2.vel2.z, 2)}] m/s
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs font-mono bg-[#1A1B1E] p-3 rounded border border-[#2D2E33]">
                    <div>
                      <span className="text-[#94A3B8]">v1 Abs Error:</span>{' '}
                      <span className={selectedCase.step3.errV1 < 1 ? 'text-emerald-400' : 'text-amber-400'}>
                        {selectedCase.step3.errV1.toFixed(4)} m/s
                      </span>
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">v1 Rel Error:</span>{' '}
                      <span className={selectedCase.step3.relErrV1 < 0.001 ? 'text-emerald-400' : 'text-amber-400'}>
                        {(selectedCase.step3.relErrV1 * 100).toFixed(5)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">v2 Abs Error:</span>{' '}
                      <span className={selectedCase.step3.errV2 < 1 ? 'text-emerald-400' : 'text-amber-400'}>
                        {selectedCase.step3.errV2.toFixed(4)} m/s
                      </span>
                    </div>
                    <div>
                      <span className="text-[#94A3B8]">v2 Rel Error:</span>{' '}
                      <span className={selectedCase.step3.relErrV2 < 0.001 ? 'text-emerald-400' : 'text-amber-400'}>
                        {(selectedCase.step3.relErrV2 * 100).toFixed(5)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Step 4: Reconstructed Orbital Elements */}
                <div className="lg:col-span-2 bg-[#25262B] border border-[#2D2E33] rounded-lg p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-[#60A5FA] uppercase tracking-wider">
                    <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> 4. Regenerated Orbital Elements Coherence</span>
                    <span className={`text-[11px] font-mono font-bold ${selectedCase.step4.passed ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {selectedCase.step4.passed ? '✓ COHERENT' : '✗ INCOHERENT'}
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs font-mono">
                      <thead>
                        <tr className="border-b border-[#2D2E33] text-[#94A3B8] uppercase text-[10px]">
                          <th className="py-2 px-3">Parameter</th>
                          <th className="py-2 px-3">Initial Orbit</th>
                          <th className="py-2 px-3">Recovered (t1)</th>
                          <th className="py-2 px-3">Recovered (t2)</th>
                          <th className="py-2 px-3">Error / Delta</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#2D2E33] text-[#E2E8F0]">
                        <tr>
                          <td className="py-2 px-3 text-[#94A3B8]">Semi-Major Axis (a)</td>
                          <td className="py-2 px-3">{formatNum(selectedCase.initialOrbit.semiMajorAxis)} m</td>
                          <td className="py-2 px-3">{formatNum(selectedCase.step4.recoveredElements1.semiMajorAxis)} m</td>
                          <td className="py-2 px-3">{formatNum(selectedCase.step4.recoveredElements2.semiMajorAxis)} m</td>
                          <td className="py-2 px-3 text-emerald-400">{(selectedCase.step4.errSMA * 100).toFixed(4)}%</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-3 text-[#94A3B8]">Eccentricity (e)</td>
                          <td className="py-2 px-3">{selectedCase.initialOrbit.eccentricity.toFixed(6)}</td>
                          <td className="py-2 px-3">{selectedCase.step4.recoveredElements1.eccentricity.toFixed(6)}</td>
                          <td className="py-2 px-3">{selectedCase.step4.recoveredElements2.eccentricity.toFixed(6)}</td>
                          <td className="py-2 px-3 text-emerald-400">{selectedCase.step4.errEcc.toFixed(6)}</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-3 text-[#94A3B8]">Inclination (i)</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.initialOrbit.inclination)}</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.step4.recoveredElements1.inclination)}</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.step4.recoveredElements2.inclination)}</td>
                          <td className="py-2 px-3 text-emerald-400">{selectedCase.step4.errInc.toFixed(4)}°</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-3 text-[#94A3B8]">Ascending Node (Ω)</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.initialOrbit.ascNodeLongitude)}</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.step4.recoveredElements1.ascNodeLongitude)}</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.step4.recoveredElements2.ascNodeLongitude)}</td>
                          <td className="py-2 px-3 text-emerald-400">{selectedCase.step4.errNode.toFixed(4)}°</td>
                        </tr>
                        <tr>
                          <td className="py-2 px-3 text-[#94A3B8]">Arg of Periapsis (ω)</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.initialOrbit.argOfPeriapsis)}</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.step4.recoveredElements1.argOfPeriapsis)}</td>
                          <td className="py-2 px-3">{radToDeg(selectedCase.step4.recoveredElements2.argOfPeriapsis)}</td>
                          <td className="py-2 px-3 text-emerald-400">{selectedCase.step4.errArgPeri.toFixed(4)}°</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
