import chalk from 'chalk';
import { launch, LaunchedChrome } from 'chrome-launcher';
import { writeFileSync } from 'fs';
import lighthouse from 'lighthouse';
import { RaceCancellation } from 'race-cancellation';

import {
  Marker,
  NavigationBenchmarkOptions
} from './create-trace-navigation-benchmark';
import {
  NavigationSample,
  PhaseSample
} from './metrics/extract-navigation-sample';
import { Benchmark, BenchmarkSampler } from './run';

// Read console errors whitelist from environement variable.
const allowedConsoleErrors: string[] = (
  process.env.TRACERBENCH_ALLOWED_CONSOLE_ERRORS || ''
).split(',');

async function runLighthouse(
  prefix: string,
  url: string,
  lhSettings: any
): Promise<PhaseSample[]> {
  const runnerResult = await lighthouse(url, lhSettings);

  runnerResult.lhr.categories;
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const path = parsedUrl.pathname;

  const namePrefix = `tracerbench-results/${prefix}${host.replace(
    ':',
    '_'
  )}_${path.replace(/\//g, '_')}`;

  writeFileSync(`${namePrefix}_lighthouse_report.html`, runnerResult.report);
  writeFileSync(
    `${namePrefix}_performance_profile.json`,
    JSON.stringify(runnerResult.artifacts)
  );
  if (runnerResult.lhr.runtimeError) {
    throw new Error(
      `Tracerbench encountered runtime error when running ${url}: ${JSON.stringify(
        runnerResult.lhr.runtimeError,
        null,
        2
      )}`
    );
  }
  runnerResult.artifacts.ConsoleMessages?.forEach((message) => {
    if (
      message.level === 'error' &&
      !allowedConsoleErrors.some((allowedError) =>
        message.text.includes(allowedError)
      )
    ) {
      throw new Error(
        `Tracerbench encountered console error when running ${url}: ${JSON.stringify(
          message,
          null,
          2
        )}`
      );
    }
  });

  let results: PhaseSample[] = [];

  if (runnerResult.lhr.categories.performance) {
    results = [
      'first-contentful-paint',
      'speed-index',
      'largest-contentful-paint',
      'interactive',
      'total-blocking-time',
      'cumulative-layout-shift'
    ].map((phase) => ({
      phase: prefix + phase,
      duration:
        runnerResult.lhr.audits[phase].numericValue *
        (phase === 'cumulative-layout-shift' ? 100 : 1000),
      start: 0,
      sign: 1,
      unit: phase === 'cumulative-layout-shift' ? '/100' : 'ms'
    }));

    results.push({
      phase: prefix + 'total-score',
      duration: runnerResult.lhr.categories.performance.score * 100,
      sign: -1,
      start: 0,
      unit: '/100'
    });
  }

  if (runnerResult.lhr.categories.accessibility) {
    runnerResult.artifacts.Accessibility?.violations.forEach((violation) => {
      console.log(
        chalk.red(
          `Lighthouse acessibility violation on ${url}: ${violation.id}`
        )
      );
    });
    results.unshift({
      phase: prefix + 'accessibility',
      duration: runnerResult.lhr.categories.accessibility.score * 100,
      sign: -1,
      start: 0,
      unit: '/100'
    });
  }

  return results;
}
class LighthouseSampler implements BenchmarkSampler<NavigationSample> {
  constructor(
    private chrome: LaunchedChrome,
    private url: string,
    private options: Partial<NavigationBenchmarkOptions>
  ) {}

  async dispose(): Promise<void> {
    await this.chrome.kill();
  }

  async sample(
    _iteration: number,
    _isTrial: boolean,
    _raceCancellation: RaceCancellation
  ): Promise<NavigationSample> {
    const lhPresets: { [key: string]: any } = {
      accessibility: {
        formFactor: 'desktop',
        screenEmulation: {
          mobile: false,
          width: 1920,
          height: 8000,
          deviceScaleFactor: 1
        },
        throttling: false,
        logLevel: 'error',
        output: 'html',
        onlyCategories: ['accessibility'],
        port: this.chrome.port
      },
      mobile: {
        formFactor: 'mobile',
        logLevel: 'error',
        screenEmulation: {
          mobile: true,
          width: 375,
          height: 812,
          deviceScaleFactor: 3
        },
        throttling: {
          rttMs: 300,
          throughputKbps: 700,
          requestLatencyMs: 1125,
          downloadThroughputKbps: 700,
          uploadThroughputKbps: 700,
          cpuSlowdownMultiplier: 6
        },
        output: 'html',
        onlyCategories: ['performance'],
        port: this.chrome.port
      },
      desktop: {
        formFactor: 'desktop',
        screenEmulation: {
          mobile: false,
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1
        },
        logLevel: 'error',
        output: 'html',
        onlyCategories: ['performance'],
        port: this.chrome.port
      }
    };

    const presetsToRun = (
      this.options.pageSetupOptions?.lhPresets ?? 'mobile'
    ).split(',');

    let phases: PhaseSample[] = [];

    for (const preset of presetsToRun) {
      const lhSettings = lhPresets[preset];
      if (!lhSettings) {
        throw new Error(`Unknown LH preset ${preset}`);
      }
      phases = [
        ...phases,
        ...(await runLighthouse(
          presetsToRun.length === 1 ? '' : preset + '-',
          this.url,
          lhSettings
        ))
      ];
    }

    return {
      metadata: {},
      duration: 0,
      phases
    };
  }
}

export default function createLighthouseBenchmark(
  group: string,
  url: string,
  _markers: Marker[],
  options: Partial<NavigationBenchmarkOptions> = {}
): Benchmark<NavigationSample> {
  return {
    group,
    async setup(_raceCancellation) {
      const chrome = await launch({ chromeFlags: ['--headless'] });
      return new LighthouseSampler(chrome, url, options);
    }
  };
}
