/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CelestialBody {
  flightGlobalsIndex?: number;
  name: string;
  radius: number; // meters
  maxTerrainHeight?: number; // meters
  atmosphereHeight?: number; // meters
  geeASL?: number;
  mass?: number; // kg
  stdGravParam?: number; // m^3 / s^2
  rotationPeriod?: number; // seconds
  initialRotation?: number; // deg
  tidallyLocked?: string | boolean;
  semiMajorAxis?: number; // meters
  eccentricity?: number;
  inclination?: number; // degrees
  argOfPeriapsis?: number; // degrees
  ascNodeLongitude?: number; // degrees
  meanAnomalyEpoch?: number; // radians
  epoch?: number; // seconds
  color?: string; // CSS color or rgba
  referenceBody?: string; // name of parent body
  templateName?: string;
  soi?: number; // Sphere of Influence radius in meters
}

export interface SolarSystem {
  id: string;
  name: string;
  description: string;
  bodies: CelestialBody[];
}

export interface InstanceNode {
  id: string;
  bodyName: string;
  label?: string;
  x: number;
  y: number;
  
  // User input constraints
  minDate?: number; // UT in seconds (undefined = unconstrained)
  maxDate?: number; // UT in seconds (undefined = unconstrained)
  minFlybyRadius?: number; // meters above surface (default = atmosphereHeight || 10000)
  maxC3?: number; // m^2 / s^2 (undefined = no limit)
  dateSampleCount?: number; // Override date sampling count N for this instance
  isSourceOverride?: boolean; // Explicitly mark instance as a valid sequence source/start
  isTargetOverride?: boolean; // Explicitly mark instance as a valid sequence target/end

  // Step 1 computed bounds (derived)
  computedMinDate?: number;
  computedMaxDate?: number;

  // Step 4 computed valid dates
  validFlybyDates?: number[];
}

export interface DirectionalLink {
  id: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  
  // User input constraints
  minFlightDuration?: number; // seconds (optional)
  maxFlightDuration?: number; // seconds (optional)

  // Step 2 computed dates at link ends
  departureSampleCount?: number;
  arrivalSampleCount?: number;

  // Step 3 & 5 computed transfer data
  possibleTransfersCount?: number;
  porkchopData?: PorkchopPlotData;
}

export interface CanvasGraphConfig {
  version: string;
  solarSystemId: string;
  mainBodyName: string;
  instances: InstanceNode[];
  links: DirectionalLink[];
  timeFormatMode: 'ksp' | 'earth'; // KSP = 6h days / 426d years, Earth = 24h days / 365d years
}

export interface LambertTransferResult {
  depDate: number;
  arrDate: number;
  flightTime: number;
  vInfDep: [number, number, number]; // m/s relative to departure body
  vInfArr: [number, number, number]; // m/s relative to arrival body
  c3Dep: number; // (m/s)^2
  c3Arr: number; // (m/s)^2
  depAngle: number; // degrees
  arrAngle: number; // degrees
  transferOrbitSemiMajorAxis: number;
  vTransDep: [number, number, number];
  vTransArr: [number, number, number];
  isValid: boolean;
}

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface PorkchopPlotData {
  linkId: string;
  sourceBody: string;
  targetBody: string;
  depDates: number[];
  arrDates: number[];
  c3DepMatrix: number[][]; // [depIndex][arrIndex]
  c3ArrMatrix: number[][];
  dvMatrix: number[][]; // Total transfer v_infinity or C3 sum
  flightTimeMatrix: number[][];
  validMatrix: boolean[][];
  vTransDepMatrix?: Vector3D[][];
  vTransArrMatrix?: Vector3D[][];
}

export interface SequencePorkchopData {
  id: string;
  sequenceLabel: string;
  is4Body?: boolean;
  sourceInstanceId: string;
  flybyInstanceId: string;
  flyby2InstanceId?: string;
  targetInstanceId: string;
  sourceBody: string;
  flybyBody: string;
  flyby2Body?: string;
  targetBody: string;
  depDates: number[];
  arrDates: number[];
  c3DepAMatrix: number[][];
  c3ArrBMatrix: number[][];
  c3DepBMatrix: number[][];
  c3ArrCMatrix: number[][];
  c3DepCMatrix?: number[][];
  c3ArrDMatrix?: number[][];
  poweredDvBMatrix: number[][];
  poweredDvCMatrix?: number[][];
  totalPoweredDvMatrix?: number[][];
  flybyDateMatrix: number[][];
  flyby2DateMatrix?: number[][];
  flightTimeMatrix: number[][];
  validMatrix: boolean[][];
}

export interface FlybyDetail {
  bodyName: string;
  instanceId: string;
  flybyDate: number;
  flybyDateSampling?: number; // Sampling interval used during search (seconds)
  periapsisAlt: number; // meters above surface
  flybyMargin: number; // meters above atmosphere/safe terrain
  deflectionAngle: number; // degrees
  maxDeflectionAngle: number; // degrees achievable at minFlybyRadius
  stochasticDv: number; // m/s required to correct trajectory post-flyby due to 10km alt & 1m/s speed errors
  vInfInMag: number; // m/s
  vInfOutMag: number; // m/s
}

export interface FlyableSequenceResult {
  id: string;
  instanceIds: string[];
  bodyNames: string[];
  depDate: number;
  arrDate: number;
  depC3: number; // km^2/s^2 or m^2/s^2
  arrC3: number;
  totalFlightTime: number; // seconds
  totalStochasticDv: number; // m/s
  totalDv: number; // total delta-V sum
  flybys: FlybyDetail[];
  transfers: LambertTransferResult[];
}

export type ResultTableColumnKey = 
  | 'sequence'
  | 'depDate'
  | 'arrDate'
  | 'flightTime'
  | 'depC3'
  | 'arrC3'
  | 'totalStochasticDv'
  | 'c3PlusStochDv2'
  | 'flybyHeight'
  | 'flybyDeflection'
  | 'flybyC3';

export interface ResultTableColumn {
  key: ResultTableColumnKey;
  label: string;
  visible: boolean;
}
