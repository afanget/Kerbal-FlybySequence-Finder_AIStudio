/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { InstanceNode, OrbitalBody } from '../types';
import { formatUT, parseKSPTimeToUT, utToYearDay } from '../utils/timeFormat';
import { X, Calendar, Compass, ShieldAlert, Check } from 'lucide-react';
import { getMinFlybyAlt } from '../data/solarSystems';

interface InstanceModalProps {
  instance: InstanceNode;
  body: OrbitalBody;
  timeFormatMode: 'ksp' | 'earth';
  onSave: (updated: InstanceNode) => void;
  onClose: () => void;
  onInspectC3?: (instanceId: string) => void;
}

export const InstanceModal: React.FC<InstanceModalProps> = ({
  instance,
  body,
  timeFormatMode,
  onSave,
  onClose,
  onInspectC3,
}) => {
  const [minDateSec, setMinDateSec] = useState<string>(instance.minDate !== undefined ? String(instance.minDate) : '');
  const [maxDateSec, setMaxDateSec] = useState<string>(instance.maxDate !== undefined ? String(instance.maxDate) : '');

  // Helper inputs for calendar date entry initialized from existing UT or computed bounds
  const initialMinUT = instance.minDate !== undefined ? instance.minDate : instance.computedMinDate;
  const initialMaxUT = instance.maxDate !== undefined ? instance.maxDate : instance.computedMaxDate;

  const initialMinCal = utToYearDay(initialMinUT, timeFormatMode);
  const initialMaxCal = utToYearDay(initialMaxUT, timeFormatMode);

  const [minYear, setMinYear] = useState<number>(initialMinCal.year);
  const [minDay, setMinDay] = useState<number>(initialMinCal.day);
  const [maxYear, setMaxYear] = useState<number>(initialMaxCal.year);
  const [maxDay, setMaxDay] = useState<number>(initialMaxCal.day);

  const [minFlybyAltitude, setMinFlybyAltitude] = useState<string>(String(getMinFlybyAlt(body, instance.minFlybyAltitude)));

  const [maxC3, setMaxC3] = useState<string>(instance.maxC3 !== undefined ? String(instance.maxC3) : '');
  const [dateSampleCount, setDateSampleCount] = useState<string>(
    instance.dateSampleCount !== undefined ? String(instance.dateSampleCount) : ''
  );
  const [isSourceOverride, setIsSourceOverride] = useState<boolean | undefined>(instance.isSourceOverride);
  const [isTargetOverride, setIsTargetOverride] = useState<boolean | undefined>(instance.isTargetOverride);

  const handleMinDateSecChange = (val: string) => {
    setMinDateSec(val);
    if (val !== '') {
      const num = parseFloat(val);
      if (!isNaN(num)) {
        const cal = utToYearDay(num, timeFormatMode);
        setMinYear(cal.year);
        setMinDay(cal.day);
      }
    } else {
      const defaultCal = utToYearDay(instance.computedMinDate, timeFormatMode);
      setMinYear(defaultCal.year);
      setMinDay(defaultCal.day);
    }
  };

  const handleMaxDateSecChange = (val: string) => {
    setMaxDateSec(val);
    if (val !== '') {
      const num = parseFloat(val);
      if (!isNaN(num)) {
        const cal = utToYearDay(num, timeFormatMode);
        setMaxYear(cal.year);
        setMaxDay(cal.day);
      }
    } else {
      const defaultCal = utToYearDay(instance.computedMaxDate, timeFormatMode);
      setMaxYear(defaultCal.year);
      setMaxDay(defaultCal.day);
    }
  };

  const handleUnsetMinDate = () => {
    setMinDateSec('');
    const defaultCal = utToYearDay(instance.computedMinDate, timeFormatMode);
    setMinYear(defaultCal.year);
    setMinDay(defaultCal.day);
  };

  const handleUnsetMaxDate = () => {
    setMaxDateSec('');
    const defaultCal = utToYearDay(instance.computedMaxDate, timeFormatMode);
    setMaxYear(defaultCal.year);
    setMaxDay(defaultCal.day);
  };

  const handleMinYearChange = (year: number) => {
    const y = Math.max(1, year);
    setMinYear(y);
    const ut = parseKSPTimeToUT(y, minDay, 0, 0, 0, timeFormatMode);
    setMinDateSec(String(ut));
  };

  const handleMinDayChange = (day: number) => {
    const d = Math.max(1, day);
    setMinDay(d);
    const ut = parseKSPTimeToUT(minYear, d, 0, 0, 0, timeFormatMode);
    setMinDateSec(String(ut));
  };

  const handleMaxYearChange = (year: number) => {
    const y = Math.max(1, year);
    setMaxYear(y);
    const ut = parseKSPTimeToUT(y, maxDay, 0, 0, 0, timeFormatMode);
    setMaxDateSec(String(ut));
  };

  const handleMaxDayChange = (day: number) => {
    const d = Math.max(1, day);
    setMaxDay(d);
    const ut = parseKSPTimeToUT(maxYear, d, 0, 0, 0, timeFormatMode);
    setMaxDateSec(String(ut));
  };

  const handleApplyCalendarMin = () => {
    const ut = parseKSPTimeToUT(minYear, minDay, 0, 0, 0, timeFormatMode);
    setMinDateSec(String(ut));
  };

  const handleApplyCalendarMax = () => {
    const ut = parseKSPTimeToUT(maxYear, maxDay, 0, 0, 0, timeFormatMode);
    setMaxDateSec(String(ut));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...instance,
      minDate: minDateSec !== '' ? parseFloat(minDateSec) : undefined,
      maxDate: maxDateSec !== '' ? parseFloat(maxDateSec) : undefined,
      minFlybyAltitude: minFlybyAltitude !== '' ? parseFloat(minFlybyAltitude) : undefined,
      maxC3: maxC3 !== '' ? parseFloat(maxC3) : undefined,
      dateSampleCount: dateSampleCount !== '' ? parseInt(dateSampleCount, 10) : undefined,
      isSourceOverride,
      isTargetOverride,
    });
    onClose();
  };

  return (
    <div id="instance-modal-backdrop" className="fixed inset-0 z-50 bg-[#0D0D0E]/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div id="instance-modal-dialog" className="bg-[#1A1B1E] border border-[#2D2E33] rounded-lg w-full max-w-lg shadow-2xl overflow-hidden text-[#E2E8F0]">
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#1A1B1E] border-b border-[#2D2E33]">
          <div className="flex items-center gap-2.5">
            <div
              className="w-3.5 h-3.5 rounded-full border border-white/20"
              style={{ backgroundColor: body?.color || '#60A5FA' }}
            />
            <h2 className="font-serif text-sm uppercase tracking-wider text-[#E2E8F0]">
              Instance Constraints: <span className="text-[#60A5FA] font-mono">{instance.bodyName}</span>
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#25262B] rounded text-[#94A3B8] hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4 text-xs">
          {/* Min & Max Date Constraints */}
          <div className="space-y-3 bg-[#25262B] p-3.5 rounded border border-[#2D2E33]">
            <div className="flex items-center gap-2 text-[#E2E8F0] font-semibold text-xs border-b border-[#2D2E33] pb-2">
              <Calendar className="w-4 h-4 text-[#60A5FA]" />
              <span className="uppercase text-[11px] tracking-wider font-serif">Flyby Date Window (UT Seconds / Calendar)</span>
            </div>

            {/* Min Date Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center">
              <div>
                <div className="flex justify-between items-center">
                  <label className="text-[11px] text-[#94A3B8]">Minimum Date (UT seconds):</label>
                  {minDateSec !== '' && (
                    <button
                      type="button"
                      onClick={handleUnsetMinDate}
                      className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                    >
                      Unset
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  value={minDateSec}
                  onChange={(e) => handleMinDateSecChange(e.target.value)}
                  placeholder="Unconstrained (UT 0)"
                  className="w-full mt-1 bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-[#60A5FA] font-mono text-xs focus:border-[#60A5FA] focus:outline-none"
                />
                <span className="text-[10px] text-[#64748B] mt-0.5 block font-mono">
                  {formatUT(minDateSec ? parseFloat(minDateSec) : null, timeFormatMode)}
                </span>
              </div>

              <div className="bg-[#1A1B1E] p-2 rounded border border-[#2D2E33] flex items-center gap-1">
                <div className="flex-1">
                  <span className="text-[10px] text-[#94A3B8] block">
                    {timeFormatMode === 'ksp' ? 'KSP Calendar:' : 'Earth Calendar:'}
                  </span>
                  <div className="flex gap-1 mt-1 font-mono">
                    <input
                      type="number"
                      min="1"
                      value={minYear}
                      onChange={(e) => handleMinYearChange(parseInt(e.target.value) || 1)}
                      className="w-12 bg-[#25262B] border border-[#2D2E33] text-[#E2E8F0] rounded px-1.5 py-0.5 text-[11px]"
                    />
                    <span className="text-[#64748B]">Y</span>
                    <input
                      type="number"
                      min="1"
                      value={minDay}
                      onChange={(e) => handleMinDayChange(parseInt(e.target.value) || 1)}
                      className="w-12 bg-[#25262B] border border-[#2D2E33] text-[#E2E8F0] rounded px-1.5 py-0.5 text-[11px]"
                    />
                    <span className="text-[#64748B]">D</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleApplyCalendarMin}
                  className="px-2.5 py-1 bg-[#334155] hover:bg-[#475569] text-white text-[10px] font-mono uppercase tracking-wider rounded border border-[#475569] cursor-pointer"
                >
                  Set
                </button>
              </div>
            </div>

            {/* Max Date Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center pt-2 border-t border-[#2D2E33]">
              <div>
                <div className="flex justify-between items-center">
                  <label className="text-[11px] text-[#94A3B8]">Maximum Date (UT seconds):</label>
                  {maxDateSec !== '' && (
                    <button
                      type="button"
                      onClick={handleUnsetMaxDate}
                      className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                    >
                      Unset
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  value={maxDateSec}
                  onChange={(e) => handleMaxDateSecChange(e.target.value)}
                  placeholder="Unconstrained"
                  className="w-full mt-1 bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-[#60A5FA] font-mono text-xs focus:border-[#60A5FA] focus:outline-none"
                />
                <span className="text-[10px] text-[#64748B] mt-0.5 block font-mono">
                  {formatUT(maxDateSec ? parseFloat(maxDateSec) : null, timeFormatMode)}
                </span>
              </div>

              <div className="bg-[#1A1B1E] p-2 rounded border border-[#2D2E33] flex items-center gap-1">
                <div className="flex-1">
                  <span className="text-[10px] text-[#94A3B8] block">
                    {timeFormatMode === 'ksp' ? 'KSP Calendar:' : 'Earth Calendar:'}
                  </span>
                  <div className="flex gap-1 mt-1 font-mono">
                    <input
                      type="number"
                      min="1"
                      value={maxYear}
                      onChange={(e) => handleMaxYearChange(parseInt(e.target.value) || 1)}
                      className="w-12 bg-[#25262B] border border-[#2D2E33] text-[#E2E8F0] rounded px-1.5 py-0.5 text-[11px]"
                    />
                    <span className="text-[#64748B]">Y</span>
                    <input
                      type="number"
                      min="1"
                      value={maxDay}
                      onChange={(e) => handleMaxDayChange(parseInt(e.target.value) || 1)}
                      className="w-12 bg-[#25262B] border border-[#2D2E33] text-[#E2E8F0] rounded px-1.5 py-0.5 text-[11px]"
                    />
                    <span className="text-[#64748B]">D</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleApplyCalendarMax}
                  className="px-2.5 py-1 bg-[#334155] hover:bg-[#475569] text-white text-[10px] font-mono uppercase tracking-wider rounded border border-[#475569] cursor-pointer"
                >
                  Set
                </button>
              </div>
            </div>
          </div>

          {/* Flyby Altitude, C3 & Sample Count Constraints */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <label className="text-[11px] font-serif uppercase tracking-wider text-[#E2E8F0] flex items-center gap-1">
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                  Min Altitude (m)
                </label>
                {minFlybyAltitude !== '' && (
                  <button
                    type="button"
                    onClick={() => setMinFlybyAltitude('')}
                    className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                  >
                    Unset
                  </button>
                )}
              </div>
              <input
                type="number"
                value={minFlybyAltitude}
                onChange={(e) => setMinFlybyAltitude(e.target.value)}
                placeholder="Atmosphere + 10km"
                className="bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-[#60A5FA] font-mono text-xs focus:border-[#60A5FA] focus:outline-none"
              />
              <span className="text-[10px] text-[#64748B]">
                Atmosphere = {body.atmosphereHeight ? (body.atmosphereHeight / 1000).toFixed(0) + 'km' : '0km'}
              </span>
            </div>

            <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <label className="text-[11px] font-serif uppercase tracking-wider text-[#E2E8F0] flex items-center gap-1">
                  <Compass className="w-3.5 h-3.5 text-[#60A5FA]" />
                  Max C3 (km²/s²)
                </label>
                <div className="flex items-center gap-2">
                  {onInspectC3 && (
                    <button
                      type="button"
                      onClick={() => onInspectC3(instance.id)}
                      className="text-[10px] text-[#60A5FA] hover:text-[#93C5FD] underline font-mono cursor-pointer"
                      title="Inspect Tisserand C3 derivation"
                    >
                      Inspect C3
                    </button>
                  )}
                  {maxC3 !== '' && (
                    <button
                      type="button"
                      onClick={() => setMaxC3('')}
                      className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                    >
                      Unset
                    </button>
                  )}
                </div>
              </div>
              <input
                type="number"
                step="0.1"
                value={maxC3}
                onChange={(e) => setMaxC3(e.target.value)}
                placeholder="No limit"
                className="bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-[#60A5FA] font-mono text-xs focus:border-[#60A5FA] focus:outline-none"
              />
              <span className="text-[10px] text-[#64748B]">Hyperbolic excess max</span>
            </div>

            <div className="bg-[#25262B] p-3 rounded border border-[#2D2E33] flex flex-col gap-1">
              <div className="flex justify-between items-center">
                <label className="text-[11px] font-serif uppercase tracking-wider text-[#E2E8F0] flex items-center gap-1">
                  <Compass className="w-3.5 h-3.5 text-emerald-400" />
                  Date Samples (N)
                </label>
                {dateSampleCount !== '' && (
                  <button
                    type="button"
                    onClick={() => setDateSampleCount('')}
                    className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                  >
                    Unset
                  </button>
                )}
              </div>
              <input
                type="number"
                min="1"
                max="100"
                value={dateSampleCount}
                onChange={(e) => setDateSampleCount(e.target.value)}
                placeholder="Auto (Period based)"
                className="bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-emerald-400 font-mono text-xs focus:border-emerald-400 focus:outline-none"
              />
              <span className="text-[10px] text-[#64748B]">1 = fixed date, N &gt; 1 = N samples</span>
            </div>
          </div>

          {/* Sequence Trajectory Role Overrides */}
          <div className="bg-[#25262B] p-3.5 rounded border border-[#2D2E33] flex flex-col gap-2.5">
            <div className="flex items-center gap-2 text-[#E2E8F0] font-semibold text-xs border-b border-[#2D2E33] pb-2">
              <Compass className="w-4 h-4 text-[#38BDF8]" />
              <span className="uppercase text-[11px] tracking-wider font-serif">Sequence Trajectory Role</span>
            </div>
            <p className="text-[11px] text-[#94A3B8] leading-relaxed">
              By default, instances with no incoming arrows act as <strong className="text-emerald-400 font-mono">Source</strong> (starts) and instances with no outgoing arrows act as <strong className="text-amber-400 font-mono">Target</strong> (destinations). You can explicitly enable Source or Target status on any flyby body to evaluate shorter or intermediate sequences in the same results table.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <label className="flex items-start gap-2.5 p-2 bg-[#1A1B1E] border border-[#2D2E33] rounded hover:border-[#38BDF8]/50 cursor-pointer transition select-none">
                <input
                  type="checkbox"
                  checked={isSourceOverride ?? false}
                  onChange={(e) => setIsSourceOverride(e.target.checked)}
                  className="mt-0.5 rounded border-[#2D2E33] bg-[#25262B] text-[#38BDF8] focus:ring-[#38BDF8]"
                />
                <div className="flex flex-col">
                  <span className="text-[#E2E8F0] font-semibold text-xs text-emerald-400">Sequence Source</span>
                  <span className="text-[10px] text-[#64748B]">Allow trajectories to start from this instance</span>
                </div>
              </label>

              <label className="flex items-start gap-2.5 p-2 bg-[#1A1B1E] border border-[#2D2E33] rounded hover:border-[#38BDF8]/50 cursor-pointer transition select-none">
                <input
                  type="checkbox"
                  checked={isTargetOverride ?? false}
                  onChange={(e) => setIsTargetOverride(e.target.checked)}
                  className="mt-0.5 rounded border-[#2D2E33] bg-[#25262B] text-[#38BDF8] focus:ring-[#38BDF8]"
                />
                <div className="flex flex-col">
                  <span className="text-[#E2E8F0] font-semibold text-xs text-amber-400">Sequence Target</span>
                  <span className="text-[10px] text-[#64748B]">Allow trajectories to terminate at this instance</span>
                </div>
              </label>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#2D2E33]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-[#25262B] hover:bg-[#2D2E33] text-[#94A3B8] hover:text-[#E2E8F0] border border-[#2D2E33] rounded text-xs font-mono uppercase tracking-wider transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 bg-[#334155] hover:bg-[#475569] text-white border border-[#475569] rounded font-serif text-xs uppercase tracking-wider shadow-lg transition"
            >
              <Check className="w-4 h-4" /> Save Constraints
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
