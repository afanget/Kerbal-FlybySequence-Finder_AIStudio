/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { InstanceNode, DirectionalLink, OrbitalBody, PorkchopPlotData } from '../types';
import { isInstanceSource, isInstanceTarget } from '../physics/solver';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import { Plus, Trash2, ArrowRight, Settings2, Info, Eye, Sliders } from 'lucide-react';

interface CanvasGraphProps {
  instances: InstanceNode[];
  links: DirectionalLink[];
  availableBodies: OrbitalBody[];
  timeFormatMode: 'ksp' | 'earth';
  selectedLinkId: string | null;
  onSelectLink: (linkId: string | null) => void;
  selectedInstanceId: string | null;
  onSelectInstance: (instanceId: string | null) => void;
  onAddInstance: (bodyName: string) => void;
  onRemoveInstance: (instanceId: string) => void;
  onAddLink: (sourceId: string, targetId: string) => void;
  onRemoveLink: (linkId: string) => void;
  onUpdateInstancePosition: (instanceId: string, x: number, y: number) => void;
  onOpenPorkchopModal: (linkId: string) => void;
  onInspectC3?: (instanceId: string) => void;
}

export const CanvasGraph: React.FC<CanvasGraphProps> = ({
  instances,
  links,
  availableBodies,
  timeFormatMode,
  selectedLinkId,
  onSelectLink,
  selectedInstanceId,
  onSelectInstance,
  onAddInstance,
  onRemoveInstance,
  onAddLink,
  onRemoveLink,
  onUpdateInstancePosition,
  onOpenPorkchopModal,
  onInspectC3,
}) => {
  const [selectedBodyForAdd, setSelectedBodyForAdd] = useState<string>('');
  const [linkSourceId, setLinkSourceId] = useState<string | null>(null);
  const [draggingInstanceId, setDraggingInstanceId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const dragStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasMovedRef = useRef<boolean>(false);

  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (availableBodies.length > 0 && !selectedBodyForAdd) {
      setSelectedBodyForAdd(availableBodies[0].name);
    }
  }, [availableBodies, selectedBodyForAdd]);

  // Handle keyboard shortcuts (Escape to cancel link/drag)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkSourceId(null);
        setDraggingInstanceId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Handle node drag initiation (WITHOUT triggering edit modal)
  const handleMouseDownNode = (e: React.MouseEvent | React.TouchEvent, inst: InstanceNode) => {
    e.stopPropagation();

    // In link mode, clicking any target node completes the link
    if (linkSourceId) {
      if (linkSourceId !== inst.id) {
        onAddLink(linkSourceId, inst.id);
      }
      setLinkSourceId(null);
      return;
    }

    onSelectLink(null);

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    dragStartPosRef.current = { x: clientX, y: clientY };
    hasMovedRef.current = false;

    setDraggingInstanceId(inst.id);

    if (svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      setDragOffset({
        x: clientX - rect.left - inst.x,
        y: clientY - rect.top - inst.y,
      });
    }
  };

  const handleMouseMoveCanvas = (e: React.MouseEvent | React.TouchEvent) => {
    if (!svgRef.current) return;
    const svgRect = svgRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const currentX = clientX - svgRect.left;
    const currentY = clientY - svgRect.top;
    setMousePos({ x: currentX, y: currentY });

    if (draggingInstanceId) {
      const dx = clientX - dragStartPosRef.current.x;
      const dy = clientY - dragStartPosRef.current.y;
      if (dx * dx + dy * dy > 16) {
        hasMovedRef.current = true;
      }
      const newX = Math.max(40, Math.min(svgRect.width - 40, currentX - dragOffset.x));
      const newY = Math.max(40, Math.min(svgRect.height - 40, currentY - dragOffset.y));
      onUpdateInstancePosition(draggingInstanceId, newX, newY);
    }
  };

  const handleMouseUpCanvas = () => {
    setDraggingInstanceId(null);
  };

  const bodyColorMap = new Map<string, string>();
  availableBodies.forEach(b => bodyColorMap.set(b.name, b.color || 'rgba(59,130,246,1)'));

  const linkSourceNode = instances.find(i => i.id === linkSourceId);

  return (
    <div id="canvas-container" className="flex flex-col bg-[#1A1B1E] border border-[#2D2E33] rounded-lg overflow-hidden shadow-2xl w-full min-w-full">
      {/* Canvas Toolbar Header */}
      <div className="bg-[#1A1B1E] border-b border-[#2D2E33] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-[#94A3B8]">Add Instance:</label>
          <select
            id="select-add-body"
            value={selectedBodyForAdd}
            onChange={(e) => setSelectedBodyForAdd(e.target.value)}
            className="bg-[#25262B] border border-[#2D2E33] text-[#E2E8F0] text-xs rounded px-3 py-1.5 focus:border-[#60A5FA] focus:outline-none"
          >
            {availableBodies.map(b => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            id="btn-add-instance"
            onClick={() => selectedBodyForAdd && onAddInstance(selectedBodyForAdd)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#334155] hover:bg-[#475569] text-white text-[11px] font-serif uppercase tracking-wider border border-[#475569] rounded transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Body Instance</span>
          </button>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-[#94A3B8]">
          {linkSourceId ? (
            <div className="flex items-center gap-2 bg-[#F59E0B]/10 text-amber-300 border border-[#F59E0B]/40 px-3 py-1 rounded animate-pulse">
              <span>Linking from <strong className="text-amber-200 font-mono">{linkSourceNode?.bodyName}</strong>... Click target node to link</span>
              <button
                onClick={() => setLinkSourceId(null)}
                className="text-xs underline hover:text-white ml-2"
              >
                Cancel (Esc)
              </button>
            </div>
          ) : (
            <span className="hidden md:inline tracking-wide">
              Drag nodes to move • Click node to edit properties • Click <strong className="text-[#60A5FA]">"+"</strong> on right border to link
            </span>
          )}
        </div>
      </div>

      {/* SVG Canvas Area with Radial Dot Pattern */}
      <div className="relative w-full h-[500px] bg-dot-grid overflow-hidden cursor-crosshair">
        <svg
          ref={svgRef}
          className="w-full h-full select-none"
          onMouseMove={handleMouseMoveCanvas}
          onTouchMove={handleMouseMoveCanvas}
          onMouseUp={handleMouseUpCanvas}
          onTouchEnd={handleMouseUpCanvas}
          onClick={() => {
            onSelectInstance(null);
            onSelectLink(null);
            setLinkSourceId(null);
          }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="9"
              refY="3.5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#60A5FA" />
            </marker>
            <marker
              id="arrowhead-selected"
              markerWidth="10"
              markerHeight="7"
              refX="9"
              refY="3.5"
              orient="auto"
            >
              <polygon points="0 0, 10 3.5, 0 7" fill="#F59E0B" />
            </marker>
          </defs>

          {/* Render Directional Links */}
          {links.map(link => {
            const src = instances.find(i => i.id === link.sourceInstanceId);
            const tgt = instances.find(i => i.id === link.targetInstanceId);
            if (!src || !tgt) return null;

            const isSelected = selectedLinkId === link.id;

            // Compute line angle and offset for node radius
            const dx = tgt.x - src.x;
            const dy = tgt.y - src.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            const offsetStart = 55;
            const offsetEnd = 55;

            const startX = src.x + (dx * offsetStart) / (dist || 1);
            const startY = src.y + (dy * offsetStart) / (dist || 1);
            const endX = tgt.x - (dx * offsetEnd) / (dist || 1);
            const endY = tgt.y - (dy * offsetEnd) / (dist || 1);

            const midX = (startX + endX) / 2;
            const midY = (startY + endY) / 2;

            // Perpendicular unit vector for label offset
            const nx = -dy / (dist || 1);
            const ny = dx / (dist || 1);

            // N=XXX sampling label positions (placed away from arrowhead with perpendicular offset)
            const depX = startX + (dx * 16) / (dist || 1) + nx * 10;
            const depY = startY + (dy * 16) / (dist || 1) + ny * 10;
            const arrX = endX - (dx * 35) / (dist || 1) + nx * 10;
            const arrY = endY - (dy * 35) / (dist || 1) + ny * 10;

            return (
              <g key={link.id} className="group cursor-pointer">
                {/* Connection Line */}
                <line
                  x1={startX}
                  y1={startY}
                  x2={endX}
                  y2={endY}
                  stroke={isSelected ? '#F59E0B' : '#2D2E33'}
                  strokeWidth={isSelected ? '2.5' : '1.5'}
                  markerEnd={isSelected ? 'url(#arrowhead-selected)' : 'url(#arrowhead)'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectLink(link.id);
                    onSelectInstance(null);
                  }}
                  className="transition-all hover:stroke-[#60A5FA] hover:stroke-[2.5]"
                />

                {/* Sampling Count Numbers (N=XXX) placed above line with high-contrast halo */}
                {link.departureSampleCount !== undefined && (
                  <text
                    x={depX}
                    y={depY}
                    fill="#38BDF8"
                    stroke="#18181B"
                    strokeWidth="3"
                    paintOrder="stroke fill"
                    fontSize="9.5"
                    fontWeight="700"
                    textAnchor="middle"
                    className="font-mono select-none pointer-events-none drop-shadow"
                  >
                    N={link.departureSampleCount}
                  </text>
                )}

                {link.arrivalSampleCount !== undefined && (
                  <text
                    x={arrX}
                    y={arrY}
                    fill="#38BDF8"
                    stroke="#18181B"
                    strokeWidth="3"
                    paintOrder="stroke fill"
                    fontSize="9.5"
                    fontWeight="700"
                    textAnchor="middle"
                    className="font-mono select-none pointer-events-none drop-shadow"
                  >
                    N={link.arrivalSampleCount}
                  </text>
                )}

                {/* Flight Duration Label & Porkchop hover button - compactly sized to content */}
                <foreignObject
                  x={midX - 55}
                  y={midY - 17}
                  width="110"
                  height="34"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectLink(link.id);
                  }}
                >
                  <div className={`flex flex-col items-center justify-center px-1.5 py-0.5 rounded border text-[9.5px] leading-tight shadow-md transition ${
                    isSelected 
                      ? 'bg-[#18181B] border-[#F59E0B] text-amber-200' 
                      : 'bg-[#18181B]/95 border-[#2D2E33] text-[#94A3B8] hover:border-[#60A5FA] hover:text-[#E2E8F0]'
                  }`}>
                    <span className="font-mono font-medium text-[9.5px] whitespace-nowrap">
                      {link.minFlightDuration !== undefined ? formatDuration(link.minFlightDuration, timeFormatMode) : '0d'} - {link.maxFlightDuration !== undefined ? formatDuration(link.maxFlightDuration, timeFormatMode) : '∞'}
                    </span>
                    {link.possibleTransfersCount !== undefined && (
                      <div className="flex items-center gap-1 text-[9px] mt-0.5">
                        <span className="font-mono text-[#64748B]">Transfers:</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenPorkchopModal(link.id);
                          }}
                          className="text-[#60A5FA] hover:underline font-mono font-bold"
                          title="View Porkchop Plot heatmap"
                        >
                          {link.possibleTransfersCount}
                        </button>
                      </div>
                    )}
                  </div>
                </foreignObject>
              </g>
            );
          })}

          {/* Rubber-band connection preview line when creating a link */}
          {linkSourceNode && (
            <line
              x1={linkSourceNode.x}
              y1={linkSourceNode.y}
              x2={mousePos.x}
              y2={mousePos.y}
              stroke="#F59E0B"
              strokeWidth="2"
              strokeDasharray="4 4"
              className="pointer-events-none animate-pulse"
            />
          )}

          {/* Render Instances (Body Nodes) */}
          {instances.map((inst, index) => {
            const isEditing = selectedInstanceId === inst.id;
            const bodyColor = bodyColorMap.get(inst.bodyName) || '#60A5FA';
            const isLinkSource = linkSourceId === inst.id;
            const isLinkTarget = linkSourceId !== null && linkSourceId !== inst.id;

            // Determine status chip
            const isSrc = isInstanceSource(inst, links);
            const isTgt = isInstanceTarget(inst, links);
            const hasIn = links.some(l => l.targetInstanceId === inst.id);
            const hasOut = links.some(l => l.sourceInstanceId === inst.id);

            let statusLabel = 'FLYBY';
            let statusColor = '#94A3B8';

            if (isSrc && isTgt) {
              statusLabel = 'SRC / TGT';
              statusColor = '#38BDF8';
            } else if (isSrc && !hasIn) {
              statusLabel = 'SOURCE';
              statusColor = '#10B981';
            } else if (isTgt && !hasOut) {
              statusLabel = 'TARGET';
              statusColor = '#F59E0B';
            } else if (hasIn && hasOut) {
              if (inst.isTargetOverride) {
                statusLabel = 'FLYBY (TGT)';
                statusColor = '#F59E0B';
              } else if (inst.isSourceOverride) {
                statusLabel = 'FLYBY (SRC)';
                statusColor = '#10B981';
              } else {
                statusLabel = 'FLYBY';
                statusColor = '#94A3B8';
              }
            } else if (isSrc) {
              statusLabel = 'SOURCE';
              statusColor = '#10B981';
            } else if (isTgt) {
              statusLabel = 'TARGET';
              statusColor = '#F59E0B';
            }

            return (
              <g
                key={inst.id}
                transform={`translate(${inst.x}, ${inst.y})`}
                onMouseDown={(e) => handleMouseDownNode(e, inst)}
                onTouchStart={(e) => handleMouseDownNode(e, inst)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasMovedRef.current) {
                    hasMovedRef.current = false;
                    return;
                  }
                  onSelectInstance(inst.id);
                }}
                className="cursor-grab active:cursor-grabbing group"
              >
                {/* Outer Selection Highlight Ring */}
                <circle
                  r="52"
                  fill="none"
                  stroke={isEditing ? '#60A5FA' : isLinkSource ? '#F59E0B' : isLinkTarget ? '#10B981' : 'transparent'}
                  strokeWidth={isLinkTarget ? "2.5" : "2"}
                  strokeDasharray={isLinkTarget ? "4 2" : "none"}
                  className="transition-all"
                />

                {/* Node Base Circle */}
                <circle
                  r="48"
                  fill="#18181B"
                  stroke={bodyColor}
                  strokeWidth="2.5"
                  className="shadow-2xl transition hover:fill-[#202024]"
                />

                {/* Body Name */}
                <text
                  y="-18"
                  fill="#F8FAFC"
                  fontSize="12.5"
                  fontWeight="700"
                  textAnchor="middle"
                  className="pointer-events-none select-none tracking-wide"
                >
                  {inst.bodyName}
                </text>

                {/* Status Label */}
                <text
                  y="-6"
                  fill={statusColor}
                  fontSize="7.5"
                  fontWeight="700"
                  textAnchor="middle"
                  className="pointer-events-none select-none tracking-widest uppercase opacity-80"
                >
                  {statusLabel}
                </text>

                {/* Date Bounds inside Node */}
                <text
                  y="9"
                  fill="#60A5FA"
                  fontSize="8.5"
                  fontFamily="monospace"
                  textAnchor="middle"
                  className="pointer-events-none select-none"
                >
                  {inst.minDate !== undefined
                    ? formatShortUT(inst.minDate, timeFormatMode)
                    : inst.computedMinDate !== undefined
                      ? formatShortUT(inst.computedMinDate, timeFormatMode)
                      : "Any"}
                  {" - "}
                  {inst.maxDate !== undefined
                    ? formatShortUT(inst.maxDate, timeFormatMode)
                    : inst.computedMaxDate !== undefined
                      ? formatShortUT(inst.computedMaxDate, timeFormatMode)
                      : "Any"}
                </text>

                {/* Flyby Alt & Max C3 inside Node */}
                {(inst.minFlybyAltitude !== undefined || inst.maxC3 !== undefined) && (
                  <text
                    y="21"
                    fill="#34D399"
                    fontSize="7.5"
                    fontFamily="monospace"
                    textAnchor="middle"
                    className="pointer-events-none select-none"
                  >
                    {inst.minFlybyAltitude !== undefined ? `alt:${(inst.minFlybyAltitude / 1000).toFixed(0)}k ` : ""}
                    {inst.maxC3 !== undefined ? `limit:${inst.maxC3}` : ""}
                  </text>
                )}

                {/* Interactive Clickable Gray C3 Range Indication */}
                {(inst.computedMinC3 !== undefined || inst.computedMaxC3 !== undefined || inst.maxC3 !== undefined) && (
                  <g
                    className="cursor-pointer group"
                    onClick={(e) => {
                      e.stopPropagation();
                      onInspectC3?.(inst.id);
                    }}
                  >
                    <rect
                      x="-38"
                      y="23"
                      width="76"
                      height="15"
                      rx="3.5"
                      fill="#1E293B"
                      fillOpacity="0.85"
                      stroke="#475569"
                      strokeWidth="0.8"
                      className="group-hover:fill-[#252B3B] group-hover:stroke-[#60A5FA] group-hover:stroke-width-[1.2] transition"
                    />
                    <text
                      y="33.5"
                      fill="#94A3B8"
                      fontSize="7.5"
                      fontFamily="monospace"
                      fontWeight="600"
                      textAnchor="middle"
                      className="group-hover:fill-[#60A5FA] select-none transition pointer-events-none"
                    >
                      C3: {inst.computedMinC3 !== undefined ? inst.computedMinC3.toFixed(1) : "0"}-
                      {inst.computedMaxC3 !== undefined ? inst.computedMaxC3.toFixed(1) : inst.maxC3 !== undefined ? inst.maxC3.toFixed(1) : "∞"}
                    </text>
                    <title>Click to inspect C3 derivation & Tisserand calculation</title>
                  </g>
                )}

                {/* Top Border Action: Delete (x) */}
                <foreignObject x="-10" y="-60" width="20" height="20">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveInstance(inst.id);
                    }}
                    className="w-5 h-5 rounded-full bg-[#1E293B] hover:bg-rose-950 hover:text-rose-400 text-[#94A3B8] border border-[#475569] flex items-center justify-center text-[10px] font-bold shadow transition transform hover:scale-110"
                    title="Remove node"
                  >
                    ✕
                  </button>
                </foreignObject>

                {/* Right Border Action: Link (+) */}
                <foreignObject x="37" y="-12" width="24" height="24">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isLinkTarget) {
                        onAddLink(linkSourceId!, inst.id);
                        setLinkSourceId(null);
                      } else {
                        setLinkSourceId(inst.id);
                      }
                    }}
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold font-mono border shadow-md transition transform hover:scale-110 ${
                      isLinkSource
                        ? 'bg-[#F59E0B] text-black border-[#F59E0B]'
                        : isLinkTarget
                        ? 'bg-[#10B981] text-black border-[#10B981] animate-bounce'
                        : 'bg-[#1E293B] hover:bg-[#334155] text-[#60A5FA] border-[#475569]'
                    }`}
                    title={isLinkTarget ? "Complete link to this node" : "Start directional link (+)"}
                  >
                    +
                  </button>
                </foreignObject>
              </g>
            );
          })}
        </svg>

        {instances.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-[#0D0D0E]/90 text-[#94A3B8] pointer-events-none">
            <Info className="w-9 h-9 text-[#60A5FA] mb-2" />
            <h3 className="font-serif text-lg text-[#E2E8F0]">Canvas is Empty</h3>
            <p className="text-xs max-w-md mt-1 text-[#94A3B8]">
              Select a body above and click <strong>"Add Body Instance"</strong> or select a preset mission sequence from the header!
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

