#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import type { CtrfAttachment, CtrfLogEntry, CtrfReport, CtrfSuite, CtrfSummary, CtrfTest } from './types';

export type MergeWdioPrettyJsonReportsOptions = {
  inputDir?: string;
  outputDir?: string;
  outputFile?: string;
};

const DEFAULT_INPUT_DIR = 'wdio-pretty-json';
const DEFAULT_OUTPUT_DIR = 'wdio-pretty-json-merged';
const DEFAULT_OUTPUT_FILE = 'wdio-ctrf-report.json';

const normalize = (value?: string): string | undefined => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const env = (key: string): string | undefined => normalize(process.env[key]);

const collectFiles = (dirPath: string): string[] => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
};

const readJsonFile = (filePath: string): CtrfReport | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CtrfReport>;
    if (!parsed.summary || (!parsed.tests && !parsed.suite)) return undefined;
    return parsed as CtrfReport;
  } catch (error) {
    console.warn(`[merge] Skipping invalid JSON ${filePath}: ${(error as Error).message}`);
    return undefined;
  }
};

const isSamePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

const copyAssets = (inputDir: string, outputDir: string, outputFile: string): void => {
  if (isSamePath(inputDir, outputDir)) return;

  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputDir, { recursive: true });

  for (const filePath of collectFiles(inputDir)) {
    if (path.extname(filePath).toLowerCase() === '.json') continue;

    const relativePath = path.relative(inputDir, filePath);
    const targetPath = path.join(outputDir, relativePath);
    if (isSamePath(targetPath, path.join(outputDir, outputFile))) continue;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(filePath, targetPath);
  }
};

const mergeSummary = (reports: CtrfReport[]): CtrfSummary => {
  const starts = reports.map((report) => report.summary.start).filter((value) => Number.isFinite(value));
  const stops = reports.map((report) => report.summary.stop).filter((value) => Number.isFinite(value));
  const start = starts.length > 0 ? Math.min(...starts) : Date.now();
  const stop = stops.length > 0 ? Math.max(...stops) : start;

  return {
    tests: reports.reduce((total, report) => total + Number(report.summary.tests ?? 0), 0),
    passed: reports.reduce((total, report) => total + Number(report.summary.passed ?? 0), 0),
    failed: reports.reduce((total, report) => total + Number(report.summary.failed ?? 0), 0),
    pending: reports.reduce((total, report) => total + Number(report.summary.pending ?? 0), 0),
    skipped: reports.reduce((total, report) => total + Number(report.summary.skipped ?? 0), 0),
    other: reports.reduce((total, report) => total + Number(report.summary.other ?? 0), 0),
    start,
    stop,
    duration: stop - start,
    suites: reports.reduce((total, report) => total + Number(report.summary.suites ?? 0), 0),
    flaky: reports.reduce((total, report) => total + Number(report.summary.flaky ?? 0), 0),
  };
};

const mergeSuites = (reports: CtrfReport[]): CtrfSuite[] | undefined => {
  const suiteMap = new Map<string, CtrfSuite>();

  for (const report of reports) {
    for (const suite of report.suite ?? []) {
      const key = `${suite.filepath ?? ''}::${suite.name}`;
      const existing = suiteMap.get(key);
      if (!existing) {
        suiteMap.set(key, {
          ...suite,
          globalHooks: suite.globalHooks ? [...suite.globalHooks] : undefined,
          hooks: suite.hooks ? [...suite.hooks] : undefined,
          tests: [...suite.tests],
        });
        continue;
      }

      existing.tests.push(...suite.tests);
      if (suite.globalHooks?.length) existing.globalHooks = [...(existing.globalHooks ?? []), ...suite.globalHooks];
      if (suite.hooks?.length) existing.hooks = [...(existing.hooks ?? []), ...suite.hooks];
    }
  }

  return suiteMap.size > 0 ? [...suiteMap.values()] : undefined;
};

const collectTests = (reports: CtrfReport[]): CtrfTest[] => {
  const tests: CtrfTest[] = [];
  for (const report of reports) {
    tests.push(...(report.tests ?? []));
  }
  return tests;
};

const dedupeAttachments = (attachments: CtrfAttachment[]): CtrfAttachment[] => {
  const seen = new Set<string>();
  const result: CtrfAttachment[] = [];
  for (const attachment of attachments) {
    const key = `${attachment.category}|${attachment.path ?? attachment.content ?? attachment.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attachment);
  }
  return result;
};

const mergeLogs = (reports: CtrfReport[]): CtrfLogEntry[] | undefined => {
  const logs = reports.flatMap((report) => report.logs ?? []);
  return logs.length > 0 ? logs : undefined;
};

export function mergeWdioPrettyJsonReports(options: MergeWdioPrettyJsonReportsOptions = {}): string {
  const inputDir = path.resolve(process.cwd(), options.inputDir ?? env('REPORTS_DIR') ?? env('WDIO_PRETTY_JSON_REPORT_DIR') ?? DEFAULT_INPUT_DIR);
  const outputDir = path.resolve(process.cwd(), options.outputDir ?? env('MERGED_REPORTS_DIR') ?? DEFAULT_OUTPUT_DIR);
  const outputFile = options.outputFile ?? env('MERGED_REPORT_FILE') ?? DEFAULT_OUTPUT_FILE;

  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`[merge] Input report directory not found: ${inputDir}`);
  }

  const reportFiles = collectFiles(inputDir)
    .filter((filePath) => path.extname(filePath).toLowerCase() === '.json')
    .filter((filePath) => !isSamePath(filePath, path.join(outputDir, outputFile)));
  const reports = reportFiles
    .map((filePath) => readJsonFile(filePath))
    .filter((report): report is CtrfReport => Boolean(report));

  if (reports.length === 0) {
    throw new Error(`[merge] No CTRF JSON reports found in: ${inputDir}`);
  }

  copyAssets(inputDir, outputDir, outputFile);

  const suites = mergeSuites(reports);
  const tests = collectTests(reports);
  const attachments = dedupeAttachments(reports.flatMap((report) => report.attachments ?? []));
  const mergedReport: CtrfReport = {
    version: reports[0]?.version ?? '1.0',
    tool: reports[0]?.tool ?? { name: 'wdio-pretty-json-reporter' },
    summary: mergeSummary(reports),
    ...(tests.length > 0 ? { tests } : {}),
    ...(suites ? { suite: suites } : {}),
    environment: reports.find((report) => report.environment)?.environment,
    ...(attachments.length > 0 ? { attachments } : {}),
    logs: mergeLogs(reports),
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, outputFile);
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(mergedReport, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, outputPath);
  console.log(`[merge] Merged ${reports.length} reports into: ${outputPath}`);
  return outputPath;
}

if (require.main === module) {
  mergeWdioPrettyJsonReports({
    inputDir: normalize(process.argv[2]),
    outputDir: normalize(process.argv[3]),
    outputFile: normalize(process.argv[4]),
  });
}