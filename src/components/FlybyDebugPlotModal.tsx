/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState } from 'react';
import { FlybyDebugPlotData, extractFlybyDebugData } from '../utils/flybyDebugPlot';
import { PorkchopPlotData, SequencePorkchopData, DirectionalLink, CelestialBody, OrbitalBody } from '../types';
import { computeFlybyPoweredDv, KM2_S2_TO_M2_S2 } from '../physics/flyby';
import { formatShortUT, formatDuration } from '../utils/timeFormat';
import {
  X,
  Activity,
  LineChart,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  Target,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  Compass,
  RefreshCw,
} from 'lucide-react';
import { vecMag } from '../physics/kepler';

interface FlybyDebugPlotModalProps {
  initialData: FlybyDebugPlotData | null;
  seqPorkchop: SequencePorkchopData;
  porkchops: Record<string, PorkchopPlotData>;
  links: DirectionalLink[];
  bodies: OrbitalBody[];
  mainBody: CelestialBody;
  timeFormatMode: 'ksp' | 'earth';
  onClose: () => void;
  onRecomputePoint?: (depIndex: number, arrIndex: number) => void;
}

interface ViewBounds {
  xMin: number;
  xMax: number;
  yMin: number; // Left Y-axis (C3 Energy in km^2/s^2)
  yMax: number;
  yDefMin: number; // Right Y-axis (Deflection Angle in deg)
  yDefMax: number;
}

export const FlybyDebugPlotModal: React.FC<FlybyDebugPlotModalProps> = ({
  initialData,
  seqPorkchop,
  porkchops,
  links,
  bodies,
  mainBody,
  timeFormatMode,
  onClose,
  onRecomputePoint,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [currentDepIndex, setCurrentDepIndex] = useState(initialData?.clickDepIndex ?? 0);
  const [currentArrIndex, setCurrentArrIndex] = useState(initialData?.clickArrIndex ?? 0);
  const [data, setData] = useState<FlybyDebugPlotData | null>(initialData);

  const [isRecomputing, setIsRecomputing] = useState(false);
  const [recomputeFeedback, setRecomputeFeedback] = useState<string | null>(null);

  const handleRecomputeClick = () => {
    setIsRecomputing(true);
    setRecomputeFeedback(null);
    try {
      if (onRecomputePoint) {
        onRecomputePoint(currentDepIndex, currentArrIndex);
      }
      if (seqPorkchop && porkchops && links && bodies && mainBody) {
        const freshData = extractFlybyDebugData(
          seqPorkchop,
          porkchops,
          links,
          currentDepIndex,
          currentArrIndex,
          bodies,
          mainBody
        );
        if (freshData) {
          setData(freshData);
        }
      }
      setRecomputeFeedback('Point updated!');
      setTimeout(() => setRecomputeFeedback(null), 2500);
    } catch (err) {
      console.error('Error recomputing point:', err);
      setRecomputeFeedback('Recompute failed');
      setTimeout(() => setRecomputeFeedback(null), 2500);
    } finally {
      setIsRecomputing(false);
    }
  };

  const [hoverInfo, setHoverInfo] = useState<{
    flybyDate: number;
    c3ArrB: number | null;
    c3DepB: number | null;
    deflectionAngleDeg: number | null;
    maxDeflectionAngleDeg: number | null;
    flybyDvMps: number | null;
    isValidArr: boolean;
    isValidDep: boolean;
    interpDate: number;
    interpC3ArrB: number | null;
    interpC3DepB: number | null;
    interpDeflectionAngleDeg: number | null;
    interpMaxDeflectionAngleDeg: number | null;
    interpFlybyDvMps: number | null;
    xPct: number;
  } | null>(null);

  const [viewBounds, setViewBounds] = useState<ViewBounds | null>(null);

  // Drag selection state for box zoom
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);

  // Re-extract data whenever departure or arrival index steps
  useEffect(() => {
    if (!seqPorkchop || !porkchops) return;
    const extracted = extractFlybyDebugData(
      seqPorkchop,
      porkchops,
      links || [],
      currentDepIndex,
      currentArrIndex,
      bodies,
      mainBody
    );
    if (extracted) {
      setData(extracted);
    }
  }, [currentDepIndex, currentArrIndex, seqPorkchop, porkchops, links, bodies, mainBody]);

  // Initialize viewBounds ONLY if they have not been set yet, so changing dep/arr date does NOT rescale the graph
  useEffect(() => {
    if (!data || data.points.length === 0) {
      return;
    }

    setViewBounds(prevBounds => {
      // Preserve existing graph scale/bounds when stepping departure or arrival date
      if (prevBounds !== null) {
        return prevBounds;
      }

      const points = data.points;
      const xMin = points[0].flybyDate;
      const xMax = points[points.length - 1].flybyDate;

      let yMin = data.minFeasibleC3;
      let yMax = data.maxFeasibleC3;

      if (yMin === yMax || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        yMin = data.minC3;
        yMax = data.maxC3;
      }

      if (yMin === yMax) {
        yMin = Math.max(0, yMin - 10);
        yMax = yMax + 10;
      }

      const padY = Math.max(2, (yMax - yMin) * 0.1);

      let yDefMin = Math.max(0, Math.floor(data.minDeflectionDeg - 5));
      let yDefMax = Math.min(180, Math.ceil(data.maxDeflectionDeg + 10));

      if (yDefMin >= yDefMax || !Number.isFinite(yDefMin) || !Number.isFinite(yDefMax)) {
        yDefMin = 0;
        yDefMax = 180;
      }

      return {
        xMin,
        xMax,
        yMin: Math.max(0, yMin - padY),
        yMax: yMax + padY,
        yDefMin,
        yDefMax,
      };
    });
  }, [data]);

  // Step Departure Index (-1 or +1)
  const handleStepDep = (delta: number) => {
    const maxIndex = Math.max(0, seqPorkchop.depDates.length - 1);
    setCurrentDepIndex(prev => Math.max(0, Math.min(maxIndex, prev + delta)));
  };

  // Step Arrival Index (-1 or +1)
  const handleStepArr = (delta: number) => {
    const maxIndex = Math.max(0, seqPorkchop.arrDates.length - 1);
    setCurrentArrIndex(prev => Math.max(0, Math.min(maxIndex, prev + delta)));
  };

  // Non-passive wheel event listener for smooth zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || !viewBounds) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const marginLeft = 65;
      const marginRight = 65;
      const marginTop = 45;
      const marginBottom = 55;
      const plotW = rect.width - marginLeft - marginRight;
      const plotH = rect.height - marginTop - marginBottom;

      if (
        mouseX < marginLeft ||
        mouseX > rect.width - marginRight ||
        mouseY < marginTop ||
        mouseY > rect.height - marginBottom
      ) {
        return; // Mouse outside plot area
      }

      const factor = e.deltaY < 0 ? 0.8 : 1.25;

      const curXRange = viewBounds.xMax - viewBounds.xMin;
      const curYRange = viewBounds.yMax - viewBounds.yMin;
      const curDefRange = viewBounds.yDefMax - viewBounds.yDefMin;

      const focusXPct = (mouseX - marginLeft) / plotW;
      const focusYPct = (marginTop + plotH - mouseY) / plotH;

      const focusX = viewBounds.xMin + focusXPct * curXRange;
      const focusY = viewBounds.yMin + focusYPct * curYRange;
      const focusDef = viewBounds.yDefMin + focusYPct * curDefRange;

      const newXRange = curXRange * factor;
      const newYRange = curYRange * factor;
      const newDefRange = curDefRange * factor;

      const newXMin = focusX - focusXPct * newXRange;
      const newXMax = focusX + (1 - focusXPct) * newXRange;

      const newYMin = focusY - focusYPct * newYRange;
      const newYMax = focusY + (1 - focusYPct) * newYRange;

      const newDefMin = focusDef - focusYPct * newDefRange;
      const newDefMax = focusDef + (1 - focusYPct) * newDefRange;

      setViewBounds({
        xMin: newXMin,
        xMax: newXMax,
        yMin: Math.max(-50, newYMin),
        yMax: newYMax,
        yDefMin: Math.max(0, newDefMin),
        yDefMax: Math.min(180, newDefMax),
      });
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [data, viewBounds]);

  // Main Canvas Render Effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.points.length === 0 || !viewBounds) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Matplotlib dark theme colors
    const bgColor = '#18181B';
    const plotBgColor = '#09090B';
    const gridColor = '#27272A';
    const axisColor = '#71717A';
    const textColor = '#D4D4D8';

    const curve1Color = '#38BDF8'; // Arrival C3 (Blue)
    const curve2Color = '#FB923C'; // Departure C3 (Orange)
    const curveDefColor = '#A855F7'; // Actual Deflection Angle (Purple)
    const curveMaxDefColor = '#FACC15'; // Max Deflection Angle (Yellow Dashed)

    const highlightColor = '#22C55E'; // Green vertical line for chosen flyby

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, width, height);

    // Margins around plot area (Left & Right equal to accommodate dual Y axes)
    const marginLeft = 65;
    const marginRight = 65;
    const marginTop = 45;
    const marginBottom = 55;

    const plotW = width - marginLeft - marginRight;
    const plotH = height - marginTop - marginBottom;

    // Plot background
    ctx.fillStyle = plotBgColor;
    ctx.fillRect(marginLeft, marginTop, plotW, plotH);
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(marginLeft, marginTop, plotW, plotH);

    // Current View Bounds
    const { xMin, xMax, yMin, yMax, yDefMin, yDefMax } = viewBounds;
    const rangeX = xMax - xMin || 1;
    const rangeY = yMax - yMin || 1;
    const rangeDef = yDefMax - yDefMin || 1;

    // Pixel mapping helpers
    const toPixelX = (val: number) => marginLeft + ((val - xMin) / rangeX) * plotW;
    const toPixelY = (val: number) => marginTop + plotH - ((val - yMin) / rangeY) * plotH;
    const toPixelDefY = (val: number) => marginTop + plotH - ((val - yDefMin) / rangeDef) * plotH;

    // Grid lines
    ctx.strokeStyle = gridColor;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    // Left Y Grid & Ticks (5 divisions) - C3 Energy
    ctx.fillStyle = textColor;
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yTicks = 5;
    for (let k = 0; k <= yTicks; k++) {
      const valY = yMin + (rangeY * k) / yTicks;
      const py = toPixelY(valY);

      if (py >= marginTop - 2 && py <= marginTop + plotH + 2) {
        ctx.beginPath();
        ctx.moveTo(marginLeft, py);
        ctx.lineTo(marginLeft + plotW, py);
        ctx.stroke();

        ctx.fillStyle = textColor;
        ctx.fillText(`${valY.toFixed(1)}`, marginLeft - 8, py);
      }
    }

    // Right Y Ticks - Deflection Angle (deg)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= yTicks; k++) {
      const valDef = yDefMin + (rangeDef * k) / yTicks;
      const py = toPixelDefY(valDef);

      if (py >= marginTop - 2 && py <= marginTop + plotH + 2) {
        ctx.fillStyle = '#C084FC'; // Purple text for right Y axis
        ctx.fillText(`${valDef.toFixed(1)}°`, marginLeft + plotW + 8, py);
      }
    }

    // X Grid & Ticks (5 divisions)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const xTicks = 5;
    for (let k = 0; k <= xTicks; k++) {
      const valX = xMin + (rangeX * k) / xTicks;
      const px = toPixelX(valX);

      if (px >= marginLeft - 2 && px <= marginLeft + plotW + 2) {
        ctx.beginPath();
        ctx.moveTo(px, marginTop);
        ctx.lineTo(px, marginTop + plotH);
        ctx.stroke();

        ctx.fillStyle = textColor;
        ctx.fillText(formatShortUT(valX, timeFormatMode), px, marginTop + plotH + 8);
      }
    }

    ctx.setLineDash([]); // Reset dashed lines

    // Clip plot drawing area
    ctx.save();
    ctx.beginPath();
    ctx.rect(marginLeft, marginTop, plotW, plotH);
    ctx.clip();

    // Points data
    const points = data.points;

    // Draw Curve 1: Arrival C3 (Link 1: Body A -> Body B)
    ctx.strokeStyle = curve1Color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started1 = false;
    for (const p of points) {
      if (p.c3ArrB !== null) {
        const px = toPixelX(p.flybyDate);
        const py = toPixelY(p.c3ArrB);
        if (!started1) {
          ctx.moveTo(px, py);
          started1 = true;
        } else {
          ctx.lineTo(px, py);
        }
      } else {
        started1 = false;
      }
    }
    ctx.stroke();

    // Draw Curve 2: Departure C3 (Link 2: Body B -> Body C)
    ctx.strokeStyle = curve2Color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started2 = false;
    for (const p of points) {
      if (p.c3DepB !== null) {
        const px = toPixelX(p.flybyDate);
        const py = toPixelY(p.c3DepB);
        if (!started2) {
          ctx.moveTo(px, py);
          started2 = true;
        } else {
          ctx.lineTo(px, py);
        }
      } else {
        started2 = false;
      }
    }
    ctx.stroke();

    // Draw Curve 3: Actual Deflection Angle (Purple, Right Y Axis)
    ctx.strokeStyle = curveDefColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let startedDef = false;
    for (const p of points) {
      if (p.deflectionAngleDeg !== null) {
        const px = toPixelX(p.flybyDate);
        const py = toPixelDefY(p.deflectionAngleDeg);
        if (!startedDef) {
          ctx.moveTo(px, py);
          startedDef = true;
        } else {
          ctx.lineTo(px, py);
        }
      } else {
        startedDef = false;
      }
    }
    ctx.stroke();

    // Draw Curve 4: Max Deflection Angle (Yellow Dashed, Right Y Axis)
    ctx.strokeStyle = curveMaxDefColor;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    let startedMaxDef = false;
    for (const p of points) {
      if (p.maxDeflectionAngleDeg !== null) {
        const px = toPixelX(p.flybyDate);
        const py = toPixelDefY(p.maxDeflectionAngleDeg);
        if (!startedMaxDef) {
          ctx.moveTo(px, py);
          startedMaxDef = true;
        } else {
          ctx.lineTo(px, py);
        }
      } else {
        startedMaxDef = false;
      }
    }
    ctx.stroke();
    ctx.setLineDash([]); // Reset dash

    // Draw vertical highlight line for chosen flyby date if present
    if (data.chosenFlybyDateB && data.chosenFlybyDateB >= xMin && data.chosenFlybyDateB <= xMax) {
      const pxChoice = toPixelX(data.chosenFlybyDateB);
      ctx.strokeStyle = highlightColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pxChoice, marginTop);
      ctx.lineTo(pxChoice, marginTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label at top
      ctx.fillStyle = highlightColor;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('Selected Flyby', pxChoice, marginTop - 4);
    }

    // Rubber-band Box Zoom Box Overlay
    if (dragStart && dragCurrent) {
      const bx = Math.min(dragStart.x, dragCurrent.x);
      const by = Math.min(dragStart.y, dragCurrent.y);
      const bw = Math.abs(dragCurrent.x - dragStart.x);
      const bh = Math.abs(dragCurrent.y - dragStart.y);

      ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.5;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
    }

    ctx.restore(); // Restore clip region

    // Axis titles
    ctx.fillStyle = '#A1A1AA';
    ctx.font = '11px sans-serif';

    // X Axis Label
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`Flyby Date at ${data.bodyB} (UT)`, marginLeft + plotW / 2, height - 8);

    // Left Y Axis Label (C3 Energy)
    ctx.save();
    ctx.translate(18, marginTop + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`C3 Energy at ${data.bodyB} (km²/s²)`, 0, 0);
    ctx.restore();

    // Right Y Axis Label (Deflection Angle)
    ctx.save();
    ctx.translate(width - 12, marginTop + plotH / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#C084FC';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`Deflection Angle (deg)`, 0, 0);
    ctx.restore();

    // Matplotlib Legend Box (Top Right inside plot area)
    const legX = marginLeft + plotW - 245;
    const legY = marginTop + 8;
    const legW = 238;
    const legH = 78;

    ctx.fillStyle = 'rgba(18, 18, 21, 0.9)';
    ctx.strokeStyle = '#3F3F46';
    ctx.lineWidth = 1;
    ctx.fillRect(legX, legY, legW, legH);
    ctx.strokeRect(legX, legY, legW, legH);

    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Legend Item 1: Arr C3
    ctx.strokeStyle = curve1Color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legX + 8, legY + 13);
    ctx.lineTo(legX + 26, legY + 13);
    ctx.stroke();

    ctx.fillStyle = '#E4E4E7';
    ctx.fillText(`Arr C3 (${data.bodyA} ➔ ${data.bodyB})`, legX + 32, legY + 13);

    // Legend Item 2: Dep C3
    ctx.strokeStyle = curve2Color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legX + 8, legY + 31);
    ctx.lineTo(legX + 26, legY + 31);
    ctx.stroke();

    ctx.fillStyle = '#E4E4E7';
    ctx.fillText(`Dep C3 (${data.bodyB} ➔ ${data.bodyC})`, legX + 32, legY + 31);

    // Legend Item 3: Actual Deflection
    ctx.strokeStyle = curveDefColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legX + 8, legY + 49);
    ctx.lineTo(legX + 26, legY + 49);
    ctx.stroke();

    ctx.fillStyle = '#E4E4E7';
    ctx.fillText(`Deflection δ (${data.bodyB} frame)`, legX + 32, legY + 49);

    // Legend Item 4: Max Deflection
    ctx.strokeStyle = curveMaxDefColor;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(legX + 8, legY + 67);
    ctx.lineTo(legX + 26, legY + 67);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#E4E4E7';
    ctx.fillText(`Max Deflection δ_max (min C3)`, legX + 32, legY + 67);
  }, [data, viewBounds, timeFormatMode, dragStart, dragCurrent]);

  // Handlers for Zoom Toolbar Actions
  const handleZoomIn = () => {
    if (!viewBounds) return;
    const { xMin, xMax, yMin, yMax, yDefMin, yDefMax } = viewBounds;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const cdef = (yDefMin + yDefMax) / 2;

    const rx = (xMax - xMin) * 0.35;
    const ry = (yMax - yMin) * 0.35;
    const rdef = (yDefMax - yDefMin) * 0.35;

    setViewBounds({
      xMin: cx - rx,
      xMax: cx + rx,
      yMin: cy - ry,
      yMax: cy + ry,
      yDefMin: Math.max(0, cdef - rdef),
      yDefMax: Math.min(180, cdef + rdef),
    });
  };

  const handleZoomOut = () => {
    if (!viewBounds) return;
    const { xMin, xMax, yMin, yMax, yDefMin, yDefMax } = viewBounds;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const cdef = (yDefMin + yDefMax) / 2;

    const rx = (xMax - xMin) * 0.7;
    const ry = (yMax - yMin) * 0.7;
    const rdef = (yDefMax - yDefMin) * 0.7;

    setViewBounds({
      xMin: cx - rx,
      xMax: cx + rx,
      yMin: cy - ry,
      yMax: cy + ry,
      yDefMin: Math.max(0, cdef - rdef),
      yDefMax: Math.min(180, cdef + rdef),
    });
  };

  const handleFocusFeasible = () => {
    if (!data || data.points.length === 0) return;
    const points = data.points;
    const xMin = points[0].flybyDate;
    const xMax = points[points.length - 1].flybyDate;

    let yMin = data.minFeasibleC3;
    let yMax = data.maxFeasibleC3;
    if (yMin === yMax) {
      yMin = Math.max(0, yMin - 10);
      yMax = yMax + 10;
    }
    const padY = Math.max(2, (yMax - yMin) * 0.1);

    let yDefMin = Math.max(0, Math.floor(data.minDeflectionDeg - 5));
    let yDefMax = Math.min(180, Math.ceil(data.maxDeflectionDeg + 10));
    if (yDefMin >= yDefMax) {
      yDefMin = 0;
      yDefMax = 180;
    }

    setViewBounds({
      xMin,
      xMax,
      yMin: Math.max(0, yMin - padY),
      yMax: yMax + padY,
      yDefMin,
      yDefMax,
    });
  };

  const handleShowAllSamples = () => {
    if (!data || data.points.length === 0) return;
    const points = data.points;
    const xMin = points[0].flybyDate;
    const xMax = points[points.length - 1].flybyDate;

    let yMin = data.minC3;
    let yMax = data.maxC3;
    if (yMin === yMax) {
      yMin = Math.max(0, yMin - 10);
      yMax = yMax + 10;
    }
    const padY = Math.max(2, (yMax - yMin) * 0.1);

    setViewBounds({
      xMin,
      xMax,
      yMin: Math.max(0, yMin - padY),
      yMax: yMax + padY,
      yDefMin: 0,
      yDefMax: 180,
    });
  };

  // Mouse drag & hover handlers on canvas
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const marginLeft = 65;
    const marginRight = 65;
    const marginTop = 45;
    const marginBottom = 55;

    if (
      x >= marginLeft &&
      x <= rect.width - marginRight &&
      y >= marginTop &&
      y <= rect.height - marginBottom
    ) {
      setDragStart({ x, y });
      setDragCurrent({ x, y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.points.length === 0 || !viewBounds) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragStart) {
      setDragCurrent({ x, y });
    }

    const marginLeft = 65;
    const marginRight = 65;
    const plotW = rect.width - marginLeft - marginRight;

    const relX = Math.max(0, Math.min(plotW, x - marginLeft));
    const pct = relX / plotW;

    const currentX = viewBounds.xMin + pct * (viewBounds.xMax - viewBounds.xMin);

    // 1. Find nearest sample point (discrete)
    const points = data.points;
    let bestPoint = points[0];
    let bestDiff = Math.abs(points[0].flybyDate - currentX);

    for (let i = 1; i < points.length; i++) {
      const diff = Math.abs(points[i].flybyDate - currentX);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestPoint = points[i];
      }
    }

    // 2. Linear interpolation between 2 surrounding samples
    let k1 = 0;
    while (k1 < points.length - 1 && points[k1 + 1].flybyDate <= currentX) {
      k1++;
    }
    const k2 = Math.min(points.length - 1, k1 + 1);

    const p1 = points[k1];
    const p2 = points[k2];

    let t = 0;
    if (p2.flybyDate > p1.flybyDate) {
      t = Math.max(0, Math.min(1, (currentX - p1.flybyDate) / (p2.flybyDate - p1.flybyDate)));
    }

    const interpNum = (v1: number | null, v2: number | null): number | null => {
      if (v1 === null && v2 === null) return null;
      if (v1 === null) return v2;
      if (v2 === null) return v1;
      return v1 + t * (v2 - v1);
    };

    const interpC3ArrB = interpNum(p1.c3ArrB, p2.c3ArrB);
    const interpC3DepB = interpNum(p1.c3DepB, p2.c3DepB);
    const interpDeflectionAngleDeg = interpNum(p1.deflectionAngleDeg, p2.deflectionAngleDeg);
    const interpMaxDeflectionAngleDeg = interpNum(p1.maxDeflectionAngleDeg, p2.maxDeflectionAngleDeg);

    // Recompute flyby delta-V for interpolated line using shared flyby physics
    let interpFlybyDvMps: number | null = null;
    if (
      interpC3ArrB !== null &&
      interpC3DepB !== null &&
      interpC3ArrB >= 0 &&
      interpC3DepB >= 0
    ) {
      const vInfInMag = Math.sqrt(interpC3ArrB * KM2_S2_TO_M2_S2); // m/s
      const vInfOutMag = Math.sqrt(interpC3DepB * KM2_S2_TO_M2_S2); // m/s
      const muFlyby = data.muFlyby || 3.5316e12;
      const rpMin = data.rpMin || 610000;

      interpFlybyDvMps = computeFlybyPoweredDv(
        vInfInMag,
        vInfOutMag,
        interpDeflectionAngleDeg ?? 0,
        interpMaxDeflectionAngleDeg ?? 0,
        muFlyby,
        rpMin
      );
    }

    setHoverInfo({
      flybyDate: bestPoint.flybyDate,
      c3ArrB: bestPoint.c3ArrB,
      c3DepB: bestPoint.c3DepB,
      deflectionAngleDeg: bestPoint.deflectionAngleDeg,
      maxDeflectionAngleDeg: bestPoint.maxDeflectionAngleDeg,
      flybyDvMps: bestPoint.flybyDvMps,
      isValidArr: bestPoint.isValidArr,
      isValidDep: bestPoint.isValidDep,
      interpDate: currentX,
      interpC3ArrB,
      interpC3DepB,
      interpDeflectionAngleDeg,
      interpMaxDeflectionAngleDeg,
      interpFlybyDvMps,
      xPct: ((marginLeft + relX) / rect.width) * 100,
    });
  };

  const handleMouseUp = () => {
    if (dragStart && dragCurrent && viewBounds && canvasRef.current) {
      const dx = Math.abs(dragCurrent.x - dragStart.x);
      const dy = Math.abs(dragCurrent.y - dragStart.y);

      // Perform box zoom if box is larger than 6x6 pixels
      if (dx > 6 && dy > 6) {
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();

        const marginLeft = 65;
        const marginRight = 65;
        const marginTop = 45;
        const marginBottom = 55;

        const plotW = rect.width - marginLeft - marginRight;
        const plotH = rect.height - marginTop - marginBottom;

        const x1 = Math.min(dragStart.x, dragCurrent.x);
        const x2 = Math.max(dragStart.x, dragCurrent.x);
        const y1 = Math.min(dragStart.y, dragCurrent.y);
        const y2 = Math.max(dragStart.y, dragCurrent.y);

        const relX1 = Math.max(0, Math.min(plotW, x1 - marginLeft));
        const relX2 = Math.max(0, Math.min(plotW, x2 - marginLeft));

        const relY1 = Math.max(0, Math.min(plotH, marginTop + plotH - y2));
        const relY2 = Math.max(0, Math.min(plotH, marginTop + plotH - y1));

        const newXMin =
          viewBounds.xMin + (relX1 / plotW) * (viewBounds.xMax - viewBounds.xMin);
        const newXMax =
          viewBounds.xMin + (relX2 / plotW) * (viewBounds.xMax - viewBounds.xMin);

        const newYMin =
          viewBounds.yMin + (relY1 / plotH) * (viewBounds.yMax - viewBounds.yMin);
        const newYMax =
          viewBounds.yMin + (relY2 / plotH) * (viewBounds.yMax - viewBounds.yMin);

        const newDefMin =
          viewBounds.yDefMin + (relY1 / plotH) * (viewBounds.yDefMax - viewBounds.yDefMin);
        const newDefMax =
          viewBounds.yDefMin + (relY2 / plotH) * (viewBounds.yDefMax - viewBounds.yDefMin);

        setViewBounds({
          xMin: newXMin,
          xMax: newXMax,
          yMin: newYMin,
          yMax: newYMax,
          yDefMin: Math.max(0, newDefMin),
          yDefMax: Math.min(180, newDefMax),
        });
      }
    }

    setDragStart(null);
    setDragCurrent(null);
  };

  return (
    <div
      id="flyby-debug-modal-backdrop"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        id="flyby-debug-modal-dialog"
        className="bg-[#18181B] border border-[#27272A] rounded-lg w-full max-w-4xl shadow-2xl overflow-hidden font-mono text-xs flex flex-col max-h-[95vh]"
      >
        {/* Matplotlib Figure Bar Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#09090B] border-b border-[#27272A] select-none">
          <div className="flex items-center gap-2 text-white font-bold text-xs">
            <LineChart className="w-4 h-4 text-[#38BDF8]" />
            <span>Matplotlib Figure 1: Flyby Debug Plot (C3 & Deflection Angle)</span>
            <span className="text-[10px] text-[#71717A] bg-[#27272A] px-1.5 py-0.5 rounded font-normal">
              2-Body Transfer
            </span>
          </div>

          <button
            onClick={onClose}
            className="p-1 hover:bg-[#27272A] rounded text-[#A1A1AA] hover:text-white transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Subtitle / Stepping Date Controls */}
        {data ? (
          <div className="px-4 py-2 bg-[#121215] border-b border-[#27272A] flex flex-wrap items-center justify-between gap-3 text-xs">
            {/* Departure Date A Controls */}
            <div className="flex items-center gap-2 bg-[#18181B] border border-[#27272A] px-2.5 py-1.5 rounded">
              <span className="text-[#71717A] text-[10px] font-semibold uppercase tracking-wider">Dep ({data.bodyA}):</span>
              <button
                onClick={() => handleStepDep(-1)}
                disabled={currentDepIndex <= 0}
                title="Previous Departure Sample (-1 step)"
                className="p-1 rounded bg-[#27272A] hover:bg-[#3F3F46] disabled:opacity-30 disabled:pointer-events-none text-[#38BDF8] transition"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <div className="text-center min-w-[110px]">
                <strong className="text-white block leading-none text-xs">
                  {formatShortUT(data.depDateA, timeFormatMode)}
                </strong>
                <span className="text-[9px] text-[#71717A]">
                  Sample #{currentDepIndex + 1} / {data.maxDepIndex + 1}
                </span>
              </div>
              <button
                onClick={() => handleStepDep(1)}
                disabled={currentDepIndex >= data.maxDepIndex}
                title="Next Departure Sample (+1 step)"
                className="p-1 rounded bg-[#27272A] hover:bg-[#3F3F46] disabled:opacity-30 disabled:pointer-events-none text-[#38BDF8] transition"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Flyby Body B Info */}
            <div className="text-center bg-[#18181B] border border-[#27272A] px-3 py-1.5 rounded min-w-[120px]">
              <span className="text-[#71717A] text-[10px] font-semibold uppercase tracking-wider block">Flyby Body:</span>
              <strong className="text-[#38BDF8] text-sm">{data.bodyB}</strong>
            </div>

            {/* Arrival Date C Controls */}
            <div className="flex items-center gap-2 bg-[#18181B] border border-[#27272A] px-2.5 py-1.5 rounded">
              <span className="text-[#71717A] text-[10px] font-semibold uppercase tracking-wider">Arr ({data.bodyC}):</span>
              <button
                onClick={() => handleStepArr(-1)}
                disabled={currentArrIndex <= 0}
                title="Previous Arrival Sample (-1 step)"
                className="p-1 rounded bg-[#27272A] hover:bg-[#3F3F46] disabled:opacity-30 disabled:pointer-events-none text-[#38BDF8] transition"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <div className="text-center min-w-[110px]">
                <strong className="text-white block leading-none text-xs">
                  {formatShortUT(data.arrDateC, timeFormatMode)}
                </strong>
                <span className="text-[9px] text-[#71717A]">
                  Sample #{currentArrIndex + 1} / {data.maxArrIndex + 1}
                </span>
              </div>
              <button
                onClick={() => handleStepArr(1)}
                disabled={currentArrIndex >= data.maxArrIndex}
                title="Next Arrival Sample (+1 step)"
                className="p-1 rounded bg-[#27272A] hover:bg-[#3F3F46] disabled:opacity-30 disabled:pointer-events-none text-[#38BDF8] transition"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : null}

        {/* Interactive Matplotlib Zoom Controls Bar */}
        {data && viewBounds && (
          <div className="px-4 py-1.5 bg-[#09090B] border-b border-[#27272A] flex flex-wrap items-center justify-between gap-2 text-[11px] select-none">
            <div className="flex items-center gap-1">
              <button
                onClick={handleZoomIn}
                title="Zoom In"
                className="flex items-center gap-1 px-2 py-1 bg-[#27272A] hover:bg-[#3F3F46] text-white rounded transition"
              >
                <ZoomIn className="w-3.5 h-3.5 text-[#38BDF8]" />
                <span>Zoom In</span>
              </button>
              <button
                onClick={handleZoomOut}
                title="Zoom Out"
                className="flex items-center gap-1 px-2 py-1 bg-[#27272A] hover:bg-[#3F3F46] text-white rounded transition"
              >
                <ZoomOut className="w-3.5 h-3.5 text-[#38BDF8]" />
                <span>Zoom Out</span>
              </button>
              <button
                onClick={handleFocusFeasible}
                title="Focus View on Feasible Solution Range"
                className="flex items-center gap-1 px-2 py-1 bg-[#27272A] hover:bg-[#3F3F46] text-amber-300 rounded transition border border-amber-500/30"
              >
                <Target className="w-3.5 h-3.5 text-amber-400" />
                <span>Feasible View</span>
              </button>
              <button
                onClick={handleShowAllSamples}
                title="Expand Axes to Show All Samples"
                className="flex items-center gap-1 px-2 py-1 bg-[#27272A] hover:bg-[#3F3F46] text-sky-300 rounded transition"
              >
                <Maximize2 className="w-3.5 h-3.5 text-sky-400" />
                <span>All Samples</span>
              </button>
              <button
                onClick={handleFocusFeasible}
                title="Reset Zoom View"
                className="flex items-center gap-1 px-2 py-1 bg-[#27272A] hover:bg-[#3F3F46] text-[#A1A1AA] hover:text-white rounded transition"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            </div>

            <div className="text-[10px] text-[#71717A] flex items-center gap-3">
              <span>
                C3 Range:{' '}
                <strong className="text-white">
                  {viewBounds.yMin.toFixed(1)}–{viewBounds.yMax.toFixed(1)} km²/s²
                </strong>
              </span>
              <span className="text-[#52525B]">|</span>
              <span>
                Deflection:{' '}
                <strong className="text-[#C084FC]">
                  {viewBounds.yDefMin.toFixed(1)}°–{viewBounds.yDefMax.toFixed(1)}°
                </strong>
              </span>
              <span className="hidden sm:inline-block text-[#52525B]">|</span>
              <span className="hidden sm:inline-flex items-center gap-1 text-[#A1A1AA]">
                <HelpCircle className="w-3 h-3 text-[#71717A]" />
                Click & drag box to zoom
              </span>
            </div>
          </div>
        )}

        {/* Plot Area */}
        <div className="p-4 flex flex-col items-center">
          {data ? (
            <div className="relative w-full max-w-[760px] aspect-[16/9] bg-[#18181B] rounded overflow-hidden">
              <canvas
                ref={canvasRef}
                width={760}
                height={420}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => {
                  setHoverInfo(null);
                  setDragStart(null);
                  setDragCurrent(null);
                }}
                className="w-full h-full cursor-crosshair select-none"
              />

              {/* Hover Cursor Vertical Guide */}
              {hoverInfo && (
                <div
                  className="absolute top-[45px] bottom-[55px] border-l border-dashed border-white/60 pointer-events-none"
                  style={{ left: `${hoverInfo.xPct}%` }}
                />
              )}
            </div>
          ) : (
            <div className="py-12 px-6 text-center text-[#A1A1AA]">
              <Activity className="w-10 h-10 text-amber-500 mx-auto mb-3 animate-pulse" />
              <p className="text-sm font-semibold text-white mb-1">
                Direct Transfer Porkchops Not Found
              </p>
              <p className="text-xs max-w-md mx-auto text-[#71717A]">
                Direct porkchop plots for Link 1 ('A' ➔ 'B') or Link 2 ('B' ➔ 'C') must be computed first before inspecting flyby curves.
              </p>
            </div>
          )}

          {/* Matplotlib Bottom Status Bar - Dual Hover Legend with Reserved Height */}
          <div className="w-full max-w-[760px] mt-3 bg-[#09090B] border border-[#27272A] px-3 py-2 rounded text-[11px] text-[#A1A1AA] flex flex-col gap-1.5 min-h-[64px] justify-center shrink-0">
            {/* Row 1: Nearest Sample Point */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white border-b border-[#27272A]/70 pb-1.5">
              <span className="text-[10px] font-bold text-[#38BDF8] bg-[#38BDF8]/10 border border-[#38BDF8]/20 px-1.5 py-0.5 rounded mr-1 shrink-0">
                Sample
              </span>
              {hoverInfo ? (
                <>
                  <div>
                    <span className="text-[#71717A] mr-1">Flyby Date:</span>
                    <strong className="text-[#38BDF8]">
                      {formatShortUT(hoverInfo.flybyDate, timeFormatMode)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Arr C3:</span>
                    <strong className="text-[#38BDF8]">
                      {hoverInfo.c3ArrB !== null ? `${hoverInfo.c3ArrB.toFixed(2)} km²/s²` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Dep C3:</span>
                    <strong className="text-[#FB923C]">
                      {hoverInfo.c3DepB !== null ? `${hoverInfo.c3DepB.toFixed(2)} km²/s²` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Deflection δ:</span>
                    <strong className="text-[#A855F7]">
                      {hoverInfo.deflectionAngleDeg !== null ? `${hoverInfo.deflectionAngleDeg.toFixed(1)}°` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Max δ:</span>
                    <strong className="text-[#FACC15]">
                      {hoverInfo.maxDeflectionAngleDeg !== null ? `${hoverInfo.maxDeflectionAngleDeg.toFixed(1)}°` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Flyby Δv:</span>
                    <strong className="text-[#EC4899]">
                      {hoverInfo.flybyDvMps !== null
                        ? hoverInfo.flybyDvMps < 0.1
                          ? '0 m/s'
                          : `${Math.round(hoverInfo.flybyDvMps).toLocaleString()} m/s`
                        : '--'}
                    </strong>
                  </div>
                  <div>
                    <span
                      className={
                        hoverInfo.isValidArr &&
                        hoverInfo.isValidDep &&
                        (hoverInfo.deflectionAngleDeg === null ||
                          hoverInfo.maxDeflectionAngleDeg === null ||
                          hoverInfo.deflectionAngleDeg <= hoverInfo.maxDeflectionAngleDeg + 0.1) &&
                        (hoverInfo.flybyDvMps === null || hoverInfo.flybyDvMps < 0.1)
                          ? 'text-emerald-400 font-bold text-[10px] bg-emerald-950/60 border border-emerald-800/50 px-1.5 py-0.5 rounded'
                          : 'text-amber-400 font-normal text-[10px] bg-amber-950/60 border border-amber-800/50 px-1.5 py-0.5 rounded'
                      }
                    >
                      {hoverInfo.isValidArr &&
                      hoverInfo.isValidDep &&
                      (hoverInfo.deflectionAngleDeg === null ||
                        hoverInfo.maxDeflectionAngleDeg === null ||
                        hoverInfo.deflectionAngleDeg <= hoverInfo.maxDeflectionAngleDeg + 0.1) &&
                      (hoverInfo.flybyDvMps === null || hoverInfo.flybyDvMps < 0.1)
                        ? 'Unpowered'
                        : hoverInfo.flybyDvMps !== null && hoverInfo.flybyDvMps >= 0.1
                        ? 'Powered'
                        : 'Infeasible Sample'}
                    </span>
                  </div>
                </>
              ) : (
                <span className="text-[#71717A] italic text-[10px]">
                  Flyby Date: -- | Arr C3: -- | Dep C3: -- | Deflection δ: -- | Max δ: -- | Flyby Δv: --
                </span>
              )}
            </div>

            {/* Row 2: Continuous Interpolated Value at Mouse Position */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-white">
              <span className="text-[10px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded mr-1 shrink-0">
                Interpolated
              </span>
              {hoverInfo ? (
                <>
                  <div>
                    <span className="text-[#71717A] mr-1">Flyby Date:</span>
                    <strong className="text-[#38BDF8]">
                      {formatShortUT(hoverInfo.interpDate, timeFormatMode)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Arr C3:</span>
                    <strong className="text-[#38BDF8]">
                      {hoverInfo.interpC3ArrB !== null ? `${hoverInfo.interpC3ArrB.toFixed(2)} km²/s²` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Dep C3:</span>
                    <strong className="text-[#FB923C]">
                      {hoverInfo.interpC3DepB !== null ? `${hoverInfo.interpC3DepB.toFixed(2)} km²/s²` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Deflection δ:</span>
                    <strong className="text-[#A855F7]">
                      {hoverInfo.interpDeflectionAngleDeg !== null ? `${hoverInfo.interpDeflectionAngleDeg.toFixed(1)}°` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Max δ:</span>
                    <strong className="text-[#FACC15]">
                      {hoverInfo.interpMaxDeflectionAngleDeg !== null ? `${hoverInfo.interpMaxDeflectionAngleDeg.toFixed(1)}°` : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#71717A] mr-1">Flyby Δv:</span>
                    <strong className="text-[#EC4899]">
                      {hoverInfo.interpFlybyDvMps !== null
                        ? hoverInfo.interpFlybyDvMps < 0.1
                          ? '0 m/s'
                          : `${Math.round(hoverInfo.interpFlybyDvMps).toLocaleString()} m/s`
                        : '--'}
                    </strong>
                  </div>
                  <div>
                    <span className="text-blue-300 font-mono text-[10px] bg-blue-950/60 border border-blue-800/50 px-1.5 py-0.5 rounded">
                      Mouse Cursor
                    </span>
                  </div>
                </>
              ) : (
                <span className="text-[#71717A] italic text-[10px]">
                  Hover mouse over canvas plot to inspect continuous values along the curve.
                </span>
              )}
            </div>
          </div>

          {/* Trajectory Inspection Card & Recompute Button */}
          <div className="w-full max-w-[760px] mt-3 bg-[#09090B] border border-[#27272A] rounded-lg p-3 font-mono text-[11px] flex flex-col justify-between gap-2.5">
            <div className="flex flex-wrap items-center justify-between border-b border-[#27272A] pb-2 text-[11px] gap-2">
              <span className="text-[#A1A1AA] font-bold flex items-center gap-1.5">
                <Compass className="w-4 h-4 text-[#38BDF8]" /> Trajectory Inspection
              </span>
              <div className="flex items-center gap-2">
                <span className={data?.hasFeasible ? 'text-emerald-400 font-semibold bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded text-[10px]' : 'text-amber-400 font-semibold bg-amber-950/60 border border-amber-800/50 px-2 py-0.5 rounded text-[10px]'}>
                  {data?.hasFeasible ? 'Valid Solution' : 'Invalid / High Δv'}
                </span>
                <button
                  onClick={handleRecomputeClick}
                  disabled={isRecomputing}
                  title="Trigger high-precision recomputation of this specific matrix cell on the main plot"
                  className="flex items-center gap-1.5 px-3 py-1 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold text-[11px] rounded transition border border-sky-400/30 shadow-sm active:scale-95 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRecomputing ? 'animate-spin' : ''}`} />
                  <span>{recomputeFeedback ? recomputeFeedback : isRecomputing ? 'Recomputing...' : 'Recompute Main Plot Point'}</span>
                </button>
              </div>
            </div>

            {/* Row 1: Key Dates & Flight Time */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div>
                <span className="text-[#71717A] block text-[9.5px]">Dep ({data?.bodyA || 'Src'}):</span>
                <span className="text-white font-semibold">
                  {data ? formatShortUT(data.depDateA, timeFormatMode) : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9.5px]">Flyby ({data?.bodyB || 'Flyby'}):</span>
                <span className="text-[#38BDF8] font-semibold">
                  {data ? formatShortUT(data.chosenFlybyDateB || data.optimalFlybyDate, timeFormatMode) : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9.5px]">Arr ({data?.bodyC || 'Tgt'}):</span>
                <span className="text-white font-semibold">
                  {data ? formatShortUT(data.arrDateC, timeFormatMode) : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9.5px]">Total Flight Time:</span>
                <span className="text-white font-semibold">
                  {data ? formatDuration(data.arrDateC - data.depDateA, timeFormatMode) : '--'}
                </span>
              </div>
            </div>

            {/* Row 2: Metrics Breakdown */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-[#27272A] pt-2 text-[11px]">
              <div>
                <span className="text-[#71717A] block text-[9.5px]">Dep C3 ({data?.bodyA || 'Src'}):</span>
                <span className="text-slate-200 font-semibold">
                  {data && data.optimalSample ? `${vecMag(data.optimalSample.c3DepA).toFixed(1)} km²/s²` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9.5px]">Arr C3 ({data?.bodyC || 'Tgt'}):</span>
                <span className="text-slate-200 font-semibold">
                  {data && data.optimalSample ? `${vecMag(data.optimalSample.c3ArrC).toFixed(1)} km²/s²` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9.5px]">Flyby Powered Δv:</span>
                <span className="text-[#38BDF8] font-bold">
                  {data && data.optimalSample ? `${data.optimalSample.flybyDvMps.toFixed(1)} m/s` : '--'}
                </span>
              </div>

              <div>
                <span className="text-[#71717A] block text-[9.5px]">Total Powered Δv:</span>
                <span className="text-emerald-400 font-semibold">
                  {data && data.optimalSample ? `${data.optimalSample.totalDv.toFixed(1)} m/s` : '--'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
