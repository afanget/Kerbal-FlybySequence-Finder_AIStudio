/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { DirectionalLink, InstanceNode } from '../types';
import { formatDuration, daysToSeconds, secondsToDays } from '../utils/timeFormat';
import { X, Clock, Trash2, Check } from 'lucide-react';

interface LinkModalProps {
  link: DirectionalLink;
  sourceInstance: InstanceNode | undefined;
  targetInstance: InstanceNode | undefined;
  timeFormatMode: 'ksp' | 'earth';
  onSave: (updated: DirectionalLink) => void;
  onRemove: (linkId: string) => void;
  onClose: () => void;
}

export const LinkModal: React.FC<LinkModalProps> = ({
  link,
  sourceInstance,
  targetInstance,
  timeFormatMode,
  onSave,
  onRemove,
  onClose,
}) => {
  const [minDays, setMinDays] = useState<string>(
    link.minFlightDuration !== undefined ? String(secondsToDays(link.minFlightDuration, timeFormatMode).toFixed(1)) : ''
  );
  const [maxDays, setMaxDays] = useState<string>(
    link.maxFlightDuration !== undefined ? String(secondsToDays(link.maxFlightDuration, timeFormatMode).toFixed(1)) : ''
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const minVal = parseFloat(minDays);
    const maxVal = parseFloat(maxDays);

    const minSec = !isNaN(minVal) ? daysToSeconds(minVal, timeFormatMode) : undefined;
    const maxSec = !isNaN(maxVal) ? daysToSeconds(maxVal, timeFormatMode) : undefined;

    onSave({
      ...link,
      minFlightDuration: minSec,
      maxFlightDuration: maxSec,
    });
    onClose();
  };

  return (
    <div id="link-modal-backdrop" className="fixed inset-0 z-50 bg-[#0D0D0E]/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div id="link-modal-dialog" className="bg-[#1A1B1E] border border-[#2D2E33] rounded-lg w-full max-w-md shadow-2xl overflow-hidden text-[#E2E8F0]">
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#1A1B1E] border-b border-[#2D2E33]">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#60A5FA]" />
            <h2 className="font-serif text-sm uppercase tracking-wider text-[#E2E8F0]">
              Link Constraints: <span className="text-[#60A5FA] font-mono">{sourceInstance?.bodyName}</span> ➔ <span className="text-[#60A5FA] font-mono">{targetInstance?.bodyName}</span>
            </h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#25262B] rounded text-[#94A3B8] hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4 text-xs">
          <div className="bg-[#25262B] p-4 rounded border border-[#2D2E33] flex flex-col gap-3">
            <label className="text-[11px] font-serif uppercase tracking-wider text-[#E2E8F0] flex items-center gap-1.5">
              Flight Duration Range ({timeFormatMode === 'ksp' ? '6h Days' : '24h Days'})
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between items-center">
                  <label className="text-[11px] text-[#94A3B8]">Min Duration (days):</label>
                  {minDays !== '' && (
                    <button
                      type="button"
                      onClick={() => setMinDays('')}
                      className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                    >
                      Unset
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  step="0.5"
                  value={minDays}
                  onChange={(e) => setMinDays(e.target.value)}
                  placeholder="Optional (0d)"
                  className="w-full mt-1 bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-[#60A5FA] font-mono text-xs focus:border-[#60A5FA] focus:outline-none"
                />
              </div>

              <div>
                <div className="flex justify-between items-center">
                  <label className="text-[11px] text-[#94A3B8]">Max Duration (days):</label>
                  {maxDays !== '' && (
                    <button
                      type="button"
                      onClick={() => setMaxDays('')}
                      className="text-[10px] text-rose-400 hover:text-rose-300 underline font-mono cursor-pointer"
                    >
                      Unset
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  step="0.5"
                  value={maxDays}
                  onChange={(e) => setMaxDays(e.target.value)}
                  placeholder="Optional (Unconstrained)"
                  className="w-full mt-1 bg-[#1A1B1E] border border-[#2D2E33] rounded p-2 text-[#60A5FA] font-mono text-xs focus:border-[#60A5FA] focus:outline-none"
                />
              </div>
            </div>

            <div className="text-[11px] text-[#94A3B8] bg-[#1A1B1E] p-2 rounded border border-[#2D2E33] flex justify-between font-mono">
              <span>Duration Window:</span>
              <strong className="text-[#60A5FA]">
                {minDays !== '' ? formatDuration(daysToSeconds(parseFloat(minDays) || 0, timeFormatMode), timeFormatMode) : '0d'} to{' '}
                {maxDays !== '' ? formatDuration(daysToSeconds(parseFloat(maxDays) || 0, timeFormatMode), timeFormatMode) : 'Unconstrained'}
              </strong>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-[#2D2E33]">
            <button
              type="button"
              onClick={() => {
                onRemove(link.id);
                onClose();
              }}
              className="flex items-center gap-1.5 px-3 py-2 bg-[#25262B] hover:bg-rose-950/60 text-rose-400 rounded text-xs font-mono uppercase tracking-wider transition border border-[#2D2E33]"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove Link
            </button>

            <div className="flex items-center gap-2">
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
                <Check className="w-4 h-4" /> Save Link
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
