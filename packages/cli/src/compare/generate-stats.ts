import type { IConfidenceInterval } from "@tracerbench/stats";
import {
  convertMicrosecondsToMS,
  roundFloatAndConvertMicrosecondsToMS,
  Stats,
} from "@tracerbench/stats";

import { md5sum } from "../helpers/utils";
export interface ParsedTitleConfigs {
  servers: Array<{ name: string }>;
  plotTitle: string | undefined;
  browserVersion: string;
}

export type Sample = {
  duration: number;
  js: number;
  phases: Array<{
    phase: string;
    start: number;
    duration: number;
    sign: 1 | -1;
    unit: "ms" | "/100";
  }>;
};

export interface ITracerBenchTraceResult {
  meta: {
    browserVersion: string;
    cpus: string[];
    "product-version": string;
  };
  samples: Sample[];
  set: string;
}

type FormattedStatsSamples = {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers: number[];
  samplesMS: number[];
};

type Frequency = {
  labels: string[];
  control: number[];
  experiment: number[];
};

export interface HTMLSectionRenderData {
  stats: Stats;
  isSignificant: boolean;
  ciMin: number;
  ciMax: number;
  hlDiff: number;
  phase: string;
  unit: "ms" | "/100";
  sign: -1 | 1;
  identifierHash: string;
  frequencyHash: string;
  sampleCount: number;
  servers?: Array<{ name: string }>;
  controlFormatedSamples: FormattedStatsSamples;
  experimentFormatedSamples: FormattedStatsSamples;
  frequency: Frequency;
  pValue: number;
  asPercent: IConfidenceInterval["asPercent"];
}

type ValuesByPhase = {
  [key: string]: { values: number[]; sign: -1 | 1; unit: "ms" | "/100" };
};

type ValueGen = {
  start: number;
  duration: number;
  unit: "ms" | "/100";
};

type CumulativeData = {
  categories: string[][];
  controlData: number[][];
  experimentData: number[][];
};

// takes control/experimentData as raw samples in microseconds
export class GenerateStats {
  controlData: ITracerBenchTraceResult;
  experimentData: ITracerBenchTraceResult;
  reportTitles: ParsedTitleConfigs;
  durationSection: HTMLSectionRenderData;
  subPhaseSections: HTMLSectionRenderData[];
  cumulativeData: CumulativeData;
  constructor(
    controlData: ITracerBenchTraceResult,
    experimentData: ITracerBenchTraceResult,
    reportTitles: ParsedTitleConfigs
  ) {
    this.controlData = controlData;
    this.experimentData = experimentData;
    this.reportTitles = reportTitles;

    const { durationSection, subPhaseSections } = this.generateData(
      this.controlData.samples,
      this.experimentData.samples,
      this.reportTitles
    );
    this.durationSection = durationSection;
    this.subPhaseSections = subPhaseSections;

    this.cumulativeData = this.bucketCumulative(
      this.controlData.samples,
      this.experimentData.samples
    );
  }

  private generateData(
    controlDataSamples: Sample[],
    experimentDataSamples: Sample[],
    reportTitles: ParsedTitleConfigs
  ): {
    durationSection: HTMLSectionRenderData;
    subPhaseSections: HTMLSectionRenderData[];
  } {
    const valuesByPhaseControl = this.bucketPhaseValues(controlDataSamples);
    const valuesByPhaseExperiment = this.bucketPhaseValues(
      experimentDataSamples
    );
    const subPhases = Object.keys(valuesByPhaseControl).filter(
      (k) => k !== "duration"
    );
    const durationSection = this.formatPhaseData(
      valuesByPhaseControl["duration"].values,
      valuesByPhaseExperiment["duration"].values,
      "duration",
      "ms",
      1
    );

    const subPhaseSections: HTMLSectionRenderData[] = subPhases.map((phase) => {
      const controlValues = valuesByPhaseControl[phase];
      const experimentValues = valuesByPhaseExperiment[phase];
      const renderDataForPhase = this.formatPhaseData(
        controlValues.values,
        experimentValues.values,
        phase,
        controlValues.unit,
        controlValues.sign
      );

      renderDataForPhase.servers = reportTitles.servers;
      return renderDataForPhase as HTMLSectionRenderData;
    });

    durationSection.servers = reportTitles.servers;

    return {
      durationSection,
      subPhaseSections,
    };
  }

  /**
   * Extract the phases and page load time latency into sorted buckets by phase
   *
   * @param samples - Array of "sample" objects
   * @param valueGen - Calls this function to extract the value from the phase. A
   *   "phase" is passed containing duration and start
   */
  private bucketPhaseValues(
    samples: Sample[],
    valueGen: (a: ValueGen) => number = (a: ValueGen) => a.duration
  ): ValuesByPhase {
    const buckets: ValuesByPhase = {
      ["duration"]: { values: [], sign: 1, unit: "ms" },
    };

    samples.forEach((sample: Sample) => {
      buckets["duration"].values.push(sample["duration"]);

      sample.phases.forEach((phaseData) => {
        const bucket = buckets[phaseData.phase] || {
          values: [],
          sign: phaseData.sign,
          unit: phaseData.unit,
        };
        bucket.values.push(valueGen(phaseData));
        buckets[phaseData.phase] = bucket;
      });
    });

    return buckets;
  }

  /**
   * Instantiate the TB Stats Class. Format the data into HTMLSectionRenderData
   * structure.
   *
   * @param controlValues - Values for the control for the phase in microseconds not arranged
   * @param experimentValues - Values for the experiment for the phase in microseconds not arranged
   * @param phaseName - Name of the phase the values represent
   */
  private formatPhaseData(
    controlValues: number[],
    experimentValues: number[],
    phaseName: string,
    unit: "ms" | "/100",
    sign: -1 | 1
  ): HTMLSectionRenderData {
    // all stats will be converted to milliseconds and rounded to tenths
    const stats = new Stats(
      {
        control: controlValues,
        experiment: experimentValues,
        name: phaseName,
      },
      unit === "ms" ? roundFloatAndConvertMicrosecondsToMS : (a: number) => a
    );

    const estimatorIsSig = Math.abs(stats.estimator) >= 1 ? true : false;
    const frequency: Frequency = {
      labels: [],
      control: [],
      experiment: [],
    };
    stats.buckets.map((bucket) => {
      frequency.labels.push(`${bucket.min}-${bucket.max} ${unit}`);
      frequency.control.push(bucket.count.control);
      frequency.experiment.push(bucket.count.experiment);
    });

    return {
      stats,
      phase: phaseName,
      identifierHash: md5sum(phaseName),
      frequencyHash: md5sum(`${phaseName}-frequency`),
      isSignificant: stats.confidenceInterval.isSig && estimatorIsSig,
      unit,
      sign,
      sampleCount: stats.sampleCount.control,
      ciMin: stats.confidenceInterval.min,
      ciMax: stats.confidenceInterval.max,
      pValue: stats.confidenceInterval.pValue,
      hlDiff: stats.estimator,
      servers: undefined,
      asPercent: stats.confidenceInterval.asPercent,
      frequency,
      controlFormatedSamples: {
        min: stats.sevenFigureSummary.control.min,
        q1: stats.sevenFigureSummary.control[25],
        median: stats.sevenFigureSummary.control[50],
        q3: stats.sevenFigureSummary.control[75],
        max: stats.sevenFigureSummary.control.max,
        outliers: stats.outliers.control.outliers,
        samplesMS: stats.control,
      },
      experimentFormatedSamples: {
        min: stats.sevenFigureSummary.experiment.min,
        q1: stats.sevenFigureSummary.experiment[25],
        median: stats.sevenFigureSummary.experiment[50],
        q3: stats.sevenFigureSummary.experiment[75],
        max: stats.sevenFigureSummary.experiment.max,
        outliers: stats.outliers.experiment.outliers,
        samplesMS: stats.experiment,
      },
    };
  }

  /**
   * Bucket the data for the cumulative chart. Ensure to convert to
   * milliseconds for presentation. Does not mutate samples.
   */
  private bucketCumulative(
    controlDataSamples: Sample[],
    experimentDataSamples: Sample[]
  ): CumulativeData {
    // round and convert from micro to milliseconds
    const cumulativeValueFunc = (a: ValueGen): number => {
      if (a.unit === "ms") {
        return Math.round(convertMicrosecondsToMS(a.start + a.duration));
      } else {
        // Maximum score 100/100 is as high as 10000ms.
        const SCORE_TO_MS_FACTOR = 10000 / 100;
        return a.duration * SCORE_TO_MS_FACTOR;
      }
    };

    const valuesByPhaseControl = this.bucketPhaseValues(
      controlDataSamples,
      cumulativeValueFunc
    );
    const valuesByPhaseExperiment = this.bucketPhaseValues(
      experimentDataSamples,
      cumulativeValueFunc
    );
    const phases = Object.keys(valuesByPhaseControl).filter(
      (k) => k !== "duration"
    );

    return {
      categories: phases.map((k) => [
        k,
        valuesByPhaseControl[k].unit,
        valuesByPhaseControl[k].sign > 0 ? "lower=better" : "higher=better",
      ]),
      controlData: phases.map((k) => valuesByPhaseControl[k].values),
      experimentData: phases.map((k) => valuesByPhaseExperiment[k].values),
    };
  }
}
