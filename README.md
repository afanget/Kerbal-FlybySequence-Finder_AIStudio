# Space Trajectory & Gravity-Assist Mission Planner

A high-performance interactive mission design tool and astrodynamics solver written in TypeScript and React. It calculates orbital transfers, unpowered/powered gravity assists, multi-body resonance flybys, porkchop plots, and full sequence optimization across Kerbol and Real Solar System planetary systems.

---

## 1. System Architecture Overview

The application follows a clean modular pipeline architecture composed of three main layers:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        User Interface Layer                            │
│  - Interactive Graph Canvas (CanvasGraph)                              │
│  - Task Dependency DAG & Execution Monitor (TaskDependencyGraph)       │
│  - Porkchop Grid Viewers (2-Body & Multi-Body Sequence Porkchops)       │
│  - Tisserand Envelopes & Flyby Geometry Viewers                        │
│  - 3D/2D Solar System Trajectory Visualizer                            │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Dispatches user interactions & parameters
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Orchestration Layer                             │
│  - taskManager.ts: DAG Task Builder, Scheduler, Priority Queue         │
│  - State Synchronization & Stepwise Progress Updates                   │
│  - Intermediate Grid / Sub-Sequence Cache Management                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ Executes discrete astrodynamic workloads
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Core Physics & Numerical Solvers                   │
│  - kepler.ts: Ephemeris propagation, orbital elements, Kepler eq       │
│  - lambert.ts: Universal-variable Lambert targeted transfer solver     │
│  - flyby.ts: Hyperbolic turning angles, v-infinity matching, flybys     │
│  - tisserandRanges.ts: Tisserand contour envelopes & bounds            │
│  - solver.ts: Porkchops, sub-path recursion, global sequence optimizer │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Directory Structure & Script Roles

### `/src/physics/` — Core Astrodynamics & Physics Engine

- **`kepler.ts`**
  - Ephemeris computations and analytical Kepler equation solvers (Newton-Raphson).
  - Converts between Keplerian orbital elements (semi-major axis $a$, eccentricity $e$, inclination $i$, longitude of ascending node $\Omega$, argument of periapsis $\omega$, true/mean anomaly $\nu, M$) and Cartesian state vectors $(\mathbf{r}, \mathbf{v})$.
  - Calculates orbital periods, vis-viva speeds, sphere of influence (SOI), and body position vectors at any target epoch.

- **`lambert.ts`**
  - Universal-variable Lambert targeting solver using Goodyear/Bate formulation.
  - Solves the two-point boundary value problem: given $\mathbf{r}_1$, $\mathbf{r}_2$, and time of flight $\Delta t$, computes departure velocity $\mathbf{v}_1$ and arrival velocity $\mathbf{v}_2$ for both prograde and retrograde orbital transfers.

- **`flyby.ts`**
  - Physics of gravity assists and hyperbolic flybys.
  - Computes hyperbolic excess velocity $\mathbf{v}_\infty$, turning angle $\delta$, periapsis radius $r_p$, and required deflection $\Delta v$.
  - Implements:
    - **`evaluateFlybyTransfer`**: Evaluates 3-body flybys ($B_1 \to B_2 \to B_3$) by matching incoming and outgoing $v_\infty$ spheres at $B_2$.
    - **`evaluateHigherOrderSequenceTransferAddFirstLeg`**: Merges a direct transfer on leg 0 ($B_0 \to B_1$) with an existing computed suffix sequence ($B_1 \to \dots \to B_{N-1}$) by pivoting on body 1.
    - **`evaluateHigherOrderSequenceTransferAddLastLeg`**: Merges a prefix sequence ($B_0 \to \dots \to B_{N-2}$) with a final leg transfer ($B_{N-2} \to B_{N-1}$) by pivoting on body $N-2$.

- **`tisserandRanges.ts`**
  - Computes Tisserand parameter contours ($T_p$) and allowable flyby velocity/energy ranges.
  - Evaluates maximum energy gains, resonant transfer periods, date ranges, and departure $C_3$ bounds for graph nodes and links based on Tisserand invariants.

- **`solver.ts`**
  - High-level combinatorial search and grid calculation engine.
  - **`computePorkchopPlot`**: Generates 2D departure-vs-arrival date transfer grids for single links ($B_1 \to B_2$).
  - **`computeSequencePorkchopPlot` / `computeSequenceNSup3PorkchopPlot`**: Evaluates multi-body sequence porkchops ($B_0 \to \dots \to B_{N-1}$) by recursively leveraging precomputed sub-chains and flyby evaluations.
  - **`runSequenceSearch`**: Runs the forward combinatorial stepwise trajectory search across the node graph.
  - **`extractSequencesFromSequencePorkchops`**: Filters existing sequence porkchop grids for solutions satisfying $\Delta v \le 1\text{ m/s}$.

- **`taskManager.ts`**
  - Asynchronous background task scheduler and DAG dependency engine.
  - Manages the lifecycle of tasks (`pending`, `running`, `completed`, `failed`).
  - Automatically builds DAG task hierarchies:
    1. **Tier 0**: Tisserand parameter & $C_3$ date envelope computations.
    2. **Tier 1**: Two-body direct link transfers ($B_i \to B_{i+1}$).
    3. **Tier 2**: 3-Body sequence porkchops ($B_0 \to B_1 \to B_2$).
    4. **Tier 3**: Higher-order sequence porkchops ($N > 3$, e.g., $B_0 \to B_1 \to B_2 \to B_3$).
    5. **Tier 4**: Sequence searches and trajectory extraction.
  - Dynamically calculates task computational cost ($\text{sample\_count}_{\text{dep}} \times \text{sample\_count}_{\text{arr}}$) and propagates priority boosts to prerequisite dependencies.

- **`autotest.ts`**
  - Unit and integration testing suite for orbital mechanics algorithms (verifies Lambert solutions, Kepler conversions, and known historical flyby trajectories).

---

### `/src/components/` — UI Components

- **`CanvasGraph.tsx`**: Interactive visual mission graph. Allows users to add celestial body instances, connect directed links, configure flyby altitude limits, and inspect transfer states.
- **`TaskDependencyGraph.tsx`**: Hierarchical DAG visualization and execution manager. Shows node status, evaluated sample costs, mini progress bars, execution controls (Run/Stop/Reset), and detailed inspector panel.
- **`PorkchopViewer.tsx`**: 2D contour and heatmap viewer for 2-body Lambert transfer grids ($\Delta v$ vs. departure epoch vs. arrival epoch).
- **`SequencePorkchopViewer.tsx`**: Heatmap and trajectory solution browser for multi-body sequence porkchops ($N \ge 3$).
- **`TisserandPlot.tsx`**: Interactive Tisserand graph displaying periapsis/apoapsis energy curves, pump/crank angles, and reachable orbital states.
- **`SolarSystemTrajectoryView.tsx`**: 2D/3D orbital view depicting planetary orbits, transfer arcs, flyby encounter points, and animated spacecraft paths.
- **`ResultsTable.tsx`**: Tabular list of discovered sequence trajectories with sortable $\Delta v$, times of flight, and maneuver details.
- **`InstanceModal.tsx` & `LinkModal.tsx`**: Configuration modals for adjusting epoch windows, sample counts, flyby altitudes, and $C_3$ bounds on individual nodes and links.
- **`HeaderSelector.tsx`**: Top bar navigation for switching solar system presets (Kerbol System, Real Solar System) and accessing global controls.
- **`AutotestModal.tsx`, `C3DebugModal.tsx`, `FlybyDebugPlotModal.tsx`, `MultiInstanceDebugModal.tsx`**: Astrodynamic debugging tools for inspecting velocity vectors, turning geometry, and multi-encounter matrices.

---

### `/src/data/` & `/src/` Root

- **`src/data/solarSystems.ts`**: Pre-defined gravitational parameters ($\mu$), body radii, orbital elements, and atmosphere boundaries for Kerbol (KSP) and the Real Solar System (Sun, Earth, Venus, Mars, Jupiter, Saturn, etc.).
- **`src/types.ts`**: TypeScript definitions for orbital elements, celestial bodies, graph nodes (`BodyInstance`), links (`InstanceLink`), task DAG structures (`ComputationTask`), and trajectory solutions.
- **`src/App.tsx`**: Root application component holding global mission state, active views, selection states, and task manager bindings.

---

## 3. How Multi-Body Sequence Decomposition Works

For high-order gravity assists ($N \ge 4$ bodies, e.g., Earth $\to$ Venus $\to$ Earth $\to$ Jupiter):

1. **Suffix Sequence Decomposition (Default)**:
   - The sequence $[B_0, B_1, \dots, B_{N-1}]$ uses body index $1$ ($B_1$) as the pivot point.
   - The solver combines the 2-body direct transfer $[B_0 \to B_1]$ with the precalculated suffix sequence porkchop $[B_1 \to \dots \to B_{N-1}]$.
   - It matches $v_\infty$ at $B_1$ across departure/arrival date grids via `evaluateHigherOrderSequenceTransferAddFirstLeg`.

2. **DAG Prerequisite Resolution**:
   - In `taskManager.ts`, task $[B_0 \to \dots \to B_{N-1}]$ automatically declares dependencies on `task-link-(0->1)` and `task-seq-(1->...->N-1)`.
   - Running or prioritizing a higher-tier sequence task automatically promotes and runs its sub-chain prerequisites first.

---

## 4. Codebase Metrics

| File | Category | Lines of Code |
| :--- | :--- | :--- |
| `src/physics/solver.ts` | Physics & Numerical Solvers | 3,134 |
| `src/physics/flyby.ts` | Physics & Numerical Solvers | 2,543 |
| `src/components/TisserandPlot.tsx` | UI Components | 2,360 |
| `src/components/ResultsTable.tsx` | UI Components | 1,905 |
| `src/components/SequencePorkchopViewer.tsx` | UI Components | 1,460 |
| `src/data/solarSystems.ts` | Ephemeris & Body Data | 1,396 |
| `src/components/FlybyDebugPlotModal.tsx` | Astrodynamic Debug Tools | 1,364 |
| `src/components/MultiInstanceDebugModal.tsx` | Astrodynamic Debug Tools | 1,047 |
| `src/components/AutotestModal.tsx` | Astrodynamic Debug Tools | 995 |
| `src/utils/multiInstanceDebug.ts` | Utilities & Algorithms | 969 |
| `src/physics/taskManager.ts` | Task DAG & Scheduler Engine | 908 |
| `src/App.tsx` | Root Application | 899 |
| `src/components/SolarSystemTrajectoryView.tsx` | UI Components | 864 |
| `src/components/TaskDependencyGraph.tsx` | UI Components | 827 |
| `src/physics/autotest.ts` | Unit & Verification Tests | 790 |
| `src/components/PorkchopViewer.tsx` | UI Components | 720 |
| `src/physics/tisserandRanges.ts` | Physics & Numerical Solvers | 656 |
| `src/components/C3DebugModal.tsx` | Astrodynamic Debug Tools | 637 |
| `src/components/CanvasGraph.tsx` | UI Components | 599 |
| `src/utils/c3Debug.ts` | Astrodynamic Debug Tools | 552 |
| `src/components/InstanceModal.tsx` | UI Components | 458 |
| `src/physics/lambert.ts` | Physics & Numerical Solvers | 403 |
| `src/physics/kepler.ts` | Physics & Numerical Solvers | 397 |
| `src/utils/flybyDebugPlot.ts` | Astrodynamic Debug Tools | 281 |
| `src/components/HeaderSelector.tsx` | UI Components | 278 |
| `src/types.ts` | Type Definitions | 266 |
| `src/components/LinkModal.tsx` | UI Components | 163 |
| `src/utils/timeFormat.ts` | Time & Epoch Utilities | 112 |
| `src/index.css` | Global Styling | 47 |
| `src/main.tsx` | Application Bootstrap | 10 |
| **Total Source Code** | **All 30 Files** | **27,040 Lines** |

---

## 5. Development & Build

- **Development server**: `npm run dev` (starts Vite on port 3000)
- **Type checking & Lint**: `npm run lint` (`tsc --noEmit`)
- **Production build**: `npm run build` (`vite build`)

