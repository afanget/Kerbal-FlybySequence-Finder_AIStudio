/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  runPhysicsAutotestSuite,
  runKEJGStep1,
  runKEJGStep2,
  AutotestSuiteResult,
  AutotestCaseResult,
  KEJGStep1Result,
  KEJGStep2Result
} from '../physics/autotest';
import {
  X,
  CheckCircle2,
  XCircle,
  Play,
  Sparkles,
  Orbit,
  Compass,
  Activity,
  ShieldCheck,
  ChevronDown,
  ChevronRight,
  Rocket,
  Zap,
  ArrowLeft
} from 'lucide-react';

interface AutotestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AutotestModal: React.FC<AutotestModalProps> = ({ isOpen, onClose }) => {
  const [suiteResult, setSuiteResult] = useState<AutotestSuiteResult | null>(() => runPhysicsAutotestSuite());
  const [selectedCaseId, setSelectedCaseId] = useState<string>('orbit-elliptical');

  // Accordion states
  const [lambertOpen, setLambertOpen] = useState<boolean>(true);
  const [kejgOpen, setKejgOpen] = useState<boolean>(true);

  // KEJG Step results
  const [kejgStep1Result, setKejgStep1Result] = useState<KEJGStep1Result | null>(() => runKEJGStep1());
  const [kejgStep2Result, setKejgStep2Result] = useState<KEJGStep2Result | null>(null);

  const [step1Running, setStep1Running] = useState<boolean>(false);
  const [step2Running, setStep2Running] = useState<boolean>(false);

  useEffect(() => {
    runKEJGStep2().then(setKejgStep2Result).catch(console.error);
  }, []);

  if (!isOpen) return null;

  const handleRunLambertTests = () => {
    const result = runPhysicsAutotestSuite();
    setSuiteResult(result);
  };

  const handleRunKEJGStep1 = () => {
    setStep1Running(true);
    setTimeout(() => {
      const res = runKEJGStep1();
      setKejgStep1Result(res);
      setStep1Running(false);
    }, 50);
  };

  const handleRunKEJGStep2 = async () => {
    setStep2Running(true);
    try {
      const res = await runKEJGStep2();
      setKejgStep2Result(res);
    } catch (err) {
      console.error(err);
    } finally {
      setStep2Running(false);
    }
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
    <div className="min-h-screen bg-[#111215] text-[#E2E8F0] flex flex-col font-sans">
      {/* Full Page Sticky Top Navigation Bar */}
      <header className="sticky top-0 z-40 bg-[#1A1B1E] border-b border-[#2D2E33] shadow-lg px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Left: Back Button & Title */}
          <div className="flex items-center gap-4">
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-3.5 py-2 bg-[#25262B] hover:bg-[#32343B] text-[#60A5FA] border border-[#2D2E33] rounded-lg transition text-xs font-semibold shadow"
              title="Return to Main Mission Planner"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back to Mission Planner</span>
            </button>

            <div className="h-6 w-[1px] bg-[#2D2E33]" />

            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-[#60A5FA]/10 border border-[#60A5FA]/30 rounded-lg text-[#60A5FA]">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-[#E2E8F0] flex items-center gap-2">
                  Orbital Mechanics & Flyby Autotest Inspector
                </h1>
                <p className="text-xs text-[#94A3B8]">
                  Automated Physics Verification Suite: Lambert Solver & KEJG Multi-Body Flyby Sequence
                </p>
              </div>
            </div>
          </div>

          {/* Right: Actions & Status */}
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs text-[#94A3B8] bg-[#25262B] px-3 py-1.5 rounded-lg border border-[#2D2E33]">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="font-mono">Suite Status: Operational</span>
            </div>

            <button
              onClick={onClose}
              className="p-2 text-[#94A3B8] hover:text-[#E2E8F0] hover:bg-[#25262B] rounded-lg transition border border-[#2D2E33]"
              title="Close Autotest Inspector"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area - Full Standard Scrollable Page */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8 flex flex-col gap-6">
        {/* Section Toolbar */}
        <div className="flex items-center justify-between text-xs text-[#94A3B8] pb-1 border-b border-[#2D2E33]/60">
          <span className="font-mono flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            2 Test Suites Loaded
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setLambertOpen(true); setKejgOpen(true); }}
              className="hover:text-[#E2E8F0] underline transition font-mono text-[11px]"
            >
              Expand All
            </button>
            <span className="text-[#3F4046]">•</span>
            <button
              onClick={() => { setLambertOpen(false); setKejgOpen(false); }}
              className="hover:text-[#E2E8F0] underline transition font-mono text-[11px]"
            >
              Collapse All
            </button>
          </div>
        </div>
          {/* SECTION 1: LAMBERT PHYSICS AUTOTEST */}
          <div className="bg-[#1F2024] border border-[#2D2E33] rounded-xl overflow-hidden">
            {/* Accordion Header */}
            <div
              onClick={() => setLambertOpen(!lambertOpen)}
              className="w-full flex items-center justify-between px-5 py-3.5 bg-[#25262B] hover:bg-[#2A2C32] transition cursor-pointer border-b border-[#2D2E33]"
            >
              <div className="flex items-center gap-3">
                {lambertOpen ? (
                  <ChevronDown className="w-4 h-4 text-[#60A5FA]" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-[#94A3B8]" />
                )}
                <Orbit className="w-4 h-4 text-[#60A5FA]" />
                <span className="text-sm font-semibold text-[#E2E8F0]">
                  Lambert Solver & Orbit Element Autotest
                </span>
                {suiteResult && (
                  <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-mono font-semibold border ${
                    suiteResult.overallPassed 
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                  }`}>
                    {suiteResult.overallPassed ? '✓ PASSED' : '✗ FAILED'}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={handleRunLambertTests}
                  className="flex items-center gap-1.5 px-3 py-1 bg-[#60A5FA] hover:bg-blue-500 text-slate-950 font-medium text-xs rounded transition shadow"
                >
                  <Play className="w-3 h-3 fill-slate-950" />
                  <span>Re-run Lambert Autotest</span>
                </button>
              </div>
            </div>

            {/* Accordion Body */}
            {lambertOpen && (
              <div className="p-5 flex flex-col gap-5">
                {/* Test Case Selector Tabs */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {suiteResult?.cases.map((c) => (
                    <button
                      key={c.caseId}
                      onClick={() => setSelectedCaseId(c.caseId)}
                      className={`p-3.5 rounded-lg border text-left transition flex flex-col gap-2 relative ${
                        selectedCaseId === c.caseId
                          ? 'bg-[#25262B] border-[#60A5FA] shadow-md'
                          : 'bg-[#1A1B1E] border-[#2D2E33] hover:border-[#3F4046]'
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
                  <div className="flex flex-col gap-5 bg-[#1A1B1E] border border-[#2D2E33] rounded-xl p-5">
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
                            <span className="text-emerald-400">v2 (Lambert):</span> [{formatNum(selectedCase.step3.v2Lambert.x, 2)}, {formatNum(selectedCase.step3.v2Lambert.y, 2)}, {formatNum(selectedCase.step3.v2Lambert.z, 2)}] m/s
                          </div>
                          <div className="bg-[#1A1B1E] p-2 rounded text-[11px] border border-[#2D2E33]">
                            <span className="text-[#94A3B8]">v2 (Actual):</span> [{formatNum(selectedCase.step2.vel2.x, 2)}, {formatNum(selectedCase.step2.vel2.y, 2)}, {formatNum(selectedCase.step2.vel2.z, 2)}] m/s
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
            )}
          </div>

          {/* SECTION 2: KEJG SEQUENCE AUTOTEST */}
          <div className="bg-[#1F2024] border border-[#2D2E33] rounded-xl overflow-hidden">
            {/* Accordion Header */}
            <div
              onClick={() => setKejgOpen(!kejgOpen)}
              className="w-full flex items-center justify-between px-5 py-3.5 bg-[#25262B] hover:bg-[#2A2C32] transition cursor-pointer border-b border-[#2D2E33]"
            >
              <div className="flex items-center gap-3">
                {kejgOpen ? (
                  <ChevronDown className="w-4 h-4 text-[#A855F7]" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-[#94A3B8]" />
                )}
                <Rocket className="w-4 h-4 text-[#A855F7]" />
                <span className="text-sm font-semibold text-[#E2E8F0]">
                  KEJG Sequence Autotest (Stock + OPM + Grannus)
                </span>
                <span className="text-xs text-[#94A3B8] font-mono">
                  Kerbin ➔ Eve ➔ Jool ➔ Grannus
                </span>
              </div>

              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={handleRunKEJGStep1}
                  disabled={step1Running}
                  className="flex items-center gap-1.5 px-3 py-1 bg-[#A855F7] hover:bg-purple-600 text-white font-medium text-xs rounded transition shadow disabled:opacity-50"
                >
                  <Play className="w-3 h-3 fill-white" />
                  <span>{step1Running ? 'Evaluating...' : 'Run Step 1 (Exact Dates)'}</span>
                </button>

                <button
                  onClick={handleRunKEJGStep2}
                  disabled={step2Running}
                  className="flex items-center gap-1.5 px-3 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 font-medium text-xs rounded transition shadow disabled:opacity-50"
                >
                  <Zap className="w-3 h-3 fill-slate-950" />
                  <span>{step2Running ? 'Searching...' : 'Run Step 2 (Sampled Grid)'}</span>
                </button>
              </div>
            </div>

            {/* Accordion Body */}
            {kejgOpen && (
              <div className="p-5 flex flex-col gap-6">
                {/* STEP 1 RESULT CARD */}
                <div className="bg-[#1A1B1E] border border-[#2D2E33] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#2D2E33]">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#A855F7]" />
                      <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-[#E2E8F0]">
                        Step 1: Exact Date Sequence Evaluation
                      </h4>
                      <span className="text-[11px] font-mono text-[#94A3B8]">
                        (Kerbin: Y6D231 | Eve: Y6D295 | Jool: Y9D308 | Grannus: Y41D192)
                      </span>
                    </div>

                    {kejgStep1Result && (
                      <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-mono font-semibold border ${
                        kejgStep1Result.passed 
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                          : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                      }`}>
                        {kejgStep1Result.passed ? '✓ SUCCESSFUL TRANSFERS' : '✗ FAILED SOLVE'}
                      </span>
                    )}
                  </div>

                  {kejgStep1Result ? (
                    <div className="flex flex-col gap-4">
                      {/* Summary Metrics */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#25262B] p-3 rounded-lg border border-[#2D2E33] font-mono text-xs">
                        <div>
                          <div className="text-[10px] text-[#94A3B8] uppercase">Total Mission Δv</div>
                          <div className="text-sm font-bold text-amber-400">{kejgStep1Result.totalMissionDvMs.toFixed(1)} m/s</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#94A3B8] uppercase">Kerbin LKO Ejection Δv</div>
                          <div className="text-sm font-bold text-[#60A5FA]">{kejgStep1Result.totalEjectionDvMs.toFixed(1)} m/s</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#94A3B8] uppercase">Eve + Jool Powered Flyby Δv</div>
                          <div className="text-sm font-bold text-purple-400">{kejgStep1Result.totalFlybyPoweredDvMs.toFixed(1)} m/s</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#94A3B8] uppercase">Kerbin Launch C3</div>
                          <div className="text-sm font-bold text-emerald-400">{kejgStep1Result.legs[0].c3Dep.toFixed(1)} km²/s²</div>
                        </div>
                      </div>

                      {/* Leg Breakdown */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {kejgStep1Result.legs.map((leg, idx) => (
                          <div key={idx} className="bg-[#25262B] border border-[#2D2E33] p-3 rounded-lg flex flex-col gap-2 font-mono text-xs">
                            <div className="text-[#60A5FA] font-bold text-xs flex items-center justify-between border-b border-[#2D2E33] pb-1.5">
                              <span>Leg {idx + 1}: {leg.departureBody} ➔ {leg.arrivalBody}</span>
                              <span className="text-[10px] text-[#94A3B8]">{leg.flightTimeDays.toFixed(0)} days</span>
                            </div>
                            <div><span className="text-[#94A3B8]">Departure v_inf:</span> {leg.vInfDepMag.toFixed(1)} m/s</div>
                            <div><span className="text-[#94A3B8]">Arrival v_inf:</span> {leg.vInfArrMag.toFixed(1)} m/s</div>
                            {idx === 0 && (
                              <div><span className="text-[#94A3B8]">Ejection Δv (LKO):</span> <span className="text-emerald-400">{leg.ejectionDvMs.toFixed(1)} m/s</span></div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Flyby Evaluations */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {kejgStep1Result.flybys.map((fb, idx) => (
                          <div key={idx} className="bg-[#25262B] border border-[#2D2E33] p-3 rounded-lg flex flex-col gap-2 font-mono text-xs">
                            <div className="text-purple-400 font-bold text-xs flex items-center justify-between border-b border-[#2D2E33] pb-1.5">
                              <span>{fb.bodyName} Flyby Evaluation</span>
                              <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                                fb.isUnpowered 
                                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                              }`}>
                                {fb.isUnpowered ? 'UNPOWERED' : `POWERED (Δv = ${fb.poweredDvMs.toFixed(1)} m/s)`}
                              </span>
                            </div>
                            <div><span className="text-[#94A3B8]">Inbound v_inf:</span> {fb.inboundVInfMag.toFixed(1)} m/s</div>
                            <div><span className="text-[#94A3B8]">Outbound v_inf:</span> {fb.outboundVInfMag.toFixed(1)} m/s</div>
                            <div><span className="text-[#94A3B8]">Turn Angle:</span> {fb.deflectionAngleDeg.toFixed(2)}° (Max: {fb.maxDeflectionAngleDeg.toFixed(2)}°)</div>
                            <div><span className="text-[#94A3B8]">Periapsis Alt:</span> {fb.periapsisAltKm.toFixed(0)} km (Margin: {fb.flybyMarginKm.toFixed(0)} km)</div>
                            <div><span className="text-[#94A3B8]">Stochastic Correction Δv:</span> {fb.stochasticDvMs.toFixed(2)} m/s</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 text-center text-xs text-[#94A3B8] font-mono">
                      Click "Run Step 1" to evaluate exact date transfers and powered/unpowered flyby details.
                    </div>
                  )}
                </div>

                {/* STEP 2 RESULT CARD */}
                <div className="bg-[#1A1B1E] border border-[#2D2E33] rounded-xl p-5 flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#2D2E33]">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-amber-500" />
                      <h4 className="text-xs font-mono font-bold uppercase tracking-wider text-[#E2E8F0]">
                        Step 2: Sampled Dates Transfer Search (Period / {kejgStep2Result?.samplingPerPeriod || 64})
                      </h4>
                    </div>

                    {kejgStep2Result && (
                      <span className={`text-[11px] px-2.5 py-0.5 rounded-full font-mono font-semibold border ${
                        kejgStep2Result.validSequencesFound > 0 
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
                          : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                      }`}>
                        {kejgStep2Result.validSequencesFound > 0 ? `✓ ${kejgStep2Result.validSequencesFound} VALID SEQUENCES FOUND` : '✗ NO VALID FLYBY FOUND'}
                      </span>
                    )}
                  </div>

                  {kejgStep2Result ? (
                    <div className="flex flex-col gap-4">
                      {/* Grid metrics */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-[#25262B] p-3 rounded-lg border border-[#2D2E33] font-mono text-xs">
                        <div>
                          <div className="text-[10px] text-[#94A3B8] uppercase">Porkchop Grid Solves</div>
                          <div className="text-sm font-bold text-amber-400">{kejgStep2Result.porkchopsComputedCount} points</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#94A3B8] uppercase">Valid Flyby Trajectories</div>
                          <div className="text-sm font-bold text-emerald-400">{kejgStep2Result.validSequencesFound}</div>
                        </div>
                        {kejgStep2Result.bestSequence && (
                          <div>
                            <div className="text-[10px] text-[#94A3B8] uppercase">Best Sequence Total Δv</div>
                            <div className="text-sm font-bold text-cyan-400">{kejgStep2Result.bestSequence.totalDvMs.toFixed(1)} m/s</div>
                          </div>
                        )}
                      </div>

                      {/* Best Sequence details */}
                      {kejgStep2Result.bestSequence && (
                        <div className="bg-[#25262B] border border-[#2D2E33] p-4 rounded-lg flex flex-col gap-3 font-mono text-xs">
                          <div className="text-amber-400 font-bold text-xs border-b border-[#2D2E33] pb-1.5 flex justify-between">
                            <span>Optimal Sampled Sequence Breakdown</span>
                            <span>Departure C3: {kejgStep2Result.bestSequence.c3Dep.toFixed(1)} km²/s²</span>
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                            <div><span className="text-[#94A3B8]">Kerbin Dep:</span> {kejgStep2Result.bestSequence.datesFormatted[0]}</div>
                            <div><span className="text-[#94A3B8]">Eve Flyby:</span> {kejgStep2Result.bestSequence.datesFormatted[1]}</div>
                            <div><span className="text-[#94A3B8]">Jool Flyby:</span> {kejgStep2Result.bestSequence.datesFormatted[2]}</div>
                            <div><span className="text-[#94A3B8]">Grannus Arr:</span> {kejgStep2Result.bestSequence.datesFormatted[3]}</div>
                          </div>

                          <div className="text-[11px] text-[#94A3B8] flex gap-4 pt-1 border-t border-[#2D2E33]">
                            <span>Travel Times: Kerbin-Eve {kejgStep2Result.bestSequence.travelTimesDays[0]}d</span>
                            <span>Eve-Jool {kejgStep2Result.bestSequence.travelTimesDays[1]}d</span>
                            <span>Jool-Grannus {kejgStep2Result.bestSequence.travelTimesDays[2]}d</span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-4 text-center text-xs text-[#94A3B8] font-mono">
                      Click "Run Step 2" to trigger sampled grid search across orbital period fractions.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>

        {/* Bottom Sticky/Floating Return Bar */}
        <footer className="sticky bottom-0 z-30 bg-[#1A1B1E]/95 backdrop-blur-md border-t border-[#2D2E33] py-3.5 px-6">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="text-xs text-[#94A3B8] font-mono flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Autotest Inspection Page Active</span>
            </div>
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-4 py-2 bg-[#60A5FA] hover:bg-blue-500 text-slate-950 font-bold text-xs rounded-lg transition shadow-lg"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Return to Mission Planner</span>
            </button>
          </div>
        </footer>
      </div>
    );
  };
