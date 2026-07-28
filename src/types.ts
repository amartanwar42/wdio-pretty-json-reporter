/**
 * CTRF (Common Test Report Format) Types + Reporter/Service Options
 */

// ═════════════════════════════════════════════════════════════════════════════
// Attachment
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfAttachment {
  name: string;
  path?: string;
  content?: string;
  type: string;
  category: 'screenshot' | 'video' | 'log' | 'trace' | 'network' | 'file';
  size?: number;
  timestamp?: number;
}

export interface CtrfLogEntry {
  timestamp: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Test
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfTest {
  name: string;
  status: 'passed' | 'failed' | 'pending' | 'skipped' | 'other';
  duration: number;
  start: number;
  stop: number;
  suite?: string;
  message?: string;
  trace?: string;
  rawStatus?: string;
  tags?: string[];
  type?: string;
  filepath?: string;
  retries?: number;
  flaky?: boolean;
  browser?: string;
  platform?: string;
  device?: string;
  appVersion?: string;
  metadata?: Record<string, unknown>;
  logs?: CtrfLogEntry[];
  log?: string;
  attachments?: CtrfAttachment[];
  hooks?: CtrfHook[];
  retriesDetail?: CtrfRetry[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Hook
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfHook {
  type: 'before' | 'after' | 'beforeEach' | 'afterEach' | 'unknown';
  title: string;
  status: 'passed' | 'failed' | 'skipped' | 'pending';
  message?: string;
  trace?: string;
  logs?: CtrfLogEntry[];
  duration: number;
  start: number;
  stop: number;
  log?: string;
  attachments?: CtrfAttachment[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Retry
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfRetry {
  attempt: number;
  status: 'passed' | 'failed' | 'skipped' | 'pending';
  duration: number;
  start: number;
  stop: number;
  message?: string;
  trace?: string;
  logs?: CtrfLogEntry[];
  log?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// Summary / Tool / Environment / Report
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfSummary {
  tests: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  other: number;
  start: number;
  stop: number;
  duration?: number;
  suites?: number;
  flaky?: number;
}

export interface CtrfTool {
  name: string;
  version?: string;
}

export interface CtrfEnvironment {
  appName?: string;
  appVersion?: string;
  buildName?: string;
  buildNumber?: string;
  platformName?: string;
  platformVersion?: string;
  deviceName?: string;
  browser?: string;
  browserVersion?: string;
  ci?: string;
  ciBuildId?: string;
  os?: string;
  osVersion?: string;
  testEnvironment?: string;
  [key: string]: unknown;
}

// ═════════════════════════════════════════════════════════════════════════════
// Suite (hierarchical structure with global hooks)
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfSuite {
  name: string;
  filepath?: string;
  globalHooks?: CtrfHook[]; // before all / after all hooks
  hooks?: CtrfHook[]; // beforeEach / afterEach hooks (can be at suite level)
  logs?: CtrfLogEntry[]; // logs from global hooks
  tests: CtrfTest[];
}

export interface CtrfReport {
  version: string;
  tool: CtrfTool;
  summary: CtrfSummary;
  tests: CtrfTest[];
  suite?: CtrfSuite[]; // hierarchical structure (when structureByHooks is true)
  environment?: CtrfEnvironment;
  attachments?: CtrfAttachment[];
  logs?: CtrfLogEntry[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Screenshot Capture Config
// ═════════════════════════════════════════════════════════════════════════════

export interface ScreenshotConfig {
  /** Enable screenshot capture */
  enabled?: boolean;
  /** Directory to save screenshots (default: ./screenshots) */
  path?: string;
  /** Capture only on failure (default: true) */
  onFailureOnly?: boolean;
  /** Naming pattern: {suite}_{test}_{timestamp} (default) or custom function */
  naming?: 'default' | ((suite: string, test: string, timestamp: number) => string);
}

// ═════════════════════════════════════════════════════════════════════════════
// Page Source Config
// ═════════════════════════════════════════════════════════════════════════════

export interface PageSourceConfig {
  enabled?: boolean;
  onFailureOnly?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Video Config
// ═════════════════════════════════════════════════════════════════════════════

export interface VideoConfig {
  enabled?: boolean;
  path?: string;
  /** Attach video per-test (default) or per-suite */
  scope?: 'test' | 'suite';
}

// ═════════════════════════════════════════════════════════════════════════════
// Reporter Options (used in reporters:[])
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfReporterOptions {
  /** Output directory for JSON report (default: ./ctrf) */
  outputDir?: string;
  /** Output filename (default: wdio-ctrf-report.json) */
  outputFile?: string;
  /** Minimum log level: trace, debug, info, warn, error, silent (default: info) */
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Capture console logs into report (default: true) */
  captureLogs?: boolean;
  /** Include hook details (default: true) */
  includeHooks?: boolean;
  /** Include retry details (default: true) */
  includeRetries?: boolean;
  /** Mark tests flaky if passed after retries (default: true) */
  markFlaky?: boolean;
  /** Custom environment metadata */
  environment?: Partial<CtrfEnvironment>;
  /** Tags applied to every test */
  tags?: string[];
  /** Test type annotation (default: e2e) */
  testType?: string;
  /** Custom metadata per test */
  metadata?: Record<string, unknown>;
  /** Transform/filter tests before writing */
  transformTest?: (test: CtrfTest) => CtrfTest | null;
  /** Callback after report is written */
  onComplete?: (report: CtrfReport, outputPath: string) => void | Promise<void>;
  /** Structure report by suites with global hooks outside tests (default: false) */
  structureByHooks?: boolean;
  /** Capture logs from global (before/after all) hooks (default: true when structureByHooks is true) */
  captureGlobalHookLogs?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Service Options (used in services:[])
// ═════════════════════════════════════════════════════════════════════════════

export interface CtrfServiceOptions {
  /** Screenshot auto-capture settings */
  screenshot?: ScreenshotConfig;
  /** Page source auto-capture settings */
  pageSource?: PageSourceConfig;
  /** Video recording settings */
  video?: VideoConfig;
  /** Custom log file paths to attach after each test */
  attachLogs?: string[];
  /** Appium server log path to attach */
  appiumLogPath?: string;
  /** Network HAR file path to attach */
  networkHarPath?: string;
}
