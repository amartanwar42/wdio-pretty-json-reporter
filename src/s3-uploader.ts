#!/usr/bin/env node

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

type ReportStats = {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  duration: number;
};

type ReportIndexEntry = {
  id: string;
  project: string;
  platform: string;
  device: string;
  date: string;
  buildNumber: string;
  branch: string;
  jsonPath: string;
  screenshotsPrefix: string;
  stats: ReportStats;
  metadata?: Record<string, string>;
};

type ReportsIndex = {
  project: string;
  lastUpdated: string;
  count: number;
  reports: ReportIndexEntry[];
};

export type UploadWdioPrettyJsonToS3Options = {
  reportsDir?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  indexKey?: string;
  updateIndex?: boolean;
  project?: string;
  platform?: string;
  device?: string;
  branch?: string;
  buildNumber?: string;
  runId?: string;
  metadata?: Record<string, string>;
};

const DEFAULT_REPORT_DIR = 'wdio-pretty-json';
const DEFAULT_PREFIX = 'wdio-pretty-json';
const DEFAULT_PROJECT = 'wdio-pretty-json';

const contentTypeByExt: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.har': 'application/json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const env = (key: string): string | undefined => normalize(process.env[key]);
const normalize = (value?: string): string | undefined => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
};
const boolEnv = (key: string, defaultValue: boolean): boolean => {
  const value = env(key);
  if (!value) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
};
const toS3SafePath = (value: string): string => value.split(path.sep).join('/');

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

const readJsonFile = <T>(filePath: string): T | undefined => {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    console.warn(`[S3] Unable to parse JSON file ${filePath}: ${(error as Error).message}`);
    return undefined;
  }
};

const findPrimaryReportFile = (files: string[], reportsDir: string): string | undefined => {
  const preferredNames = (env('REPORTS_S3_JSON_NAMES') ?? 'report.json,wdio-ctrf-report.json,wdio-report.json')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  return preferredNames
    .map((name) => files.find((filePath) => path.relative(reportsDir, filePath) === name))
    .find((filePath): filePath is string => Boolean(filePath))
    ?? files.find((filePath) => path.extname(filePath).toLowerCase() === '.json');
};

const getReportStats = (primaryReportFile?: string): ReportStats => {
  const report = primaryReportFile
    ? readJsonFile<{ summary?: Partial<ReportStats> }>(primaryReportFile)
    : undefined;
  const summary = report?.summary ?? {};

  return {
    passed: Number(summary.passed ?? 0),
    failed: Number(summary.failed ?? 0),
    flaky: Number(summary.flaky ?? 0),
    skipped: Number(summary.skipped ?? 0),
    duration: Number(summary.duration ?? 0),
  };
};

const streamToString = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const getObjectText = async (client: S3Client, bucket: string, key: string): Promise<string | undefined> => {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!(response.Body instanceof Readable)) {
      throw new Error('[S3] Invalid response body type');
    }
    return streamToString(response.Body);
  } catch (error) {
    const err = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
    const errorName = err.name ?? err.Code ?? err.code;
    if (errorName === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return undefined;
    }
    throw error;
  }
};

const uploadBuffer = async (client: S3Client, bucket: string, key: string, body: Buffer | string, contentType: string): Promise<string> => {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return `s3://${bucket}/${key}`;
};

const createS3Client = (region?: string): S3Client => {
  const accessKeyId = env('AWS_ACCESS_KEY_ID') ?? env('AWS_ACCESS_KEY');
  const secretAccessKey = env('AWS_SECRET_ACCESS_KEY') ?? env('AWS_SECRET_KEY');
  const sessionToken = env('AWS_SESSION_TOKEN');

  return new S3Client({
    region,
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } }
      : {}),
  });
};

const getOptionsFromEnv = (): Required<Omit<UploadWdioPrettyJsonToS3Options, 'metadata'>> & { metadata?: Record<string, string> } => {
  const uploadedAt = new Date().toISOString();
  const runId = env('REPORTS_RUN_ID') ?? env('BITBUCKET_BUILD_NUMBER') ?? env('GITHUB_RUN_ID') ?? uploadedAt.replace(/[:.]/g, '-');
  const prefix = env('REPORTS_S3_PREFIX') ?? env('WDIO_PRETTY_JSON_S3_PREFIX') ?? DEFAULT_PREFIX;
  const project = env('REPORTS_PROJECT') ?? env('PROJECT_NAME') ?? DEFAULT_PROJECT;
  const metadataJson = env('REPORTS_METADATA_JSON');
  let metadata: Record<string, string> | undefined;
  if (metadataJson) {
    try {
      metadata = JSON.parse(metadataJson) as Record<string, string>;
    } catch (error) {
      console.warn(`[S3] Ignoring invalid REPORTS_METADATA_JSON: ${(error as Error).message}`);
    }
  }

  return {
    reportsDir: path.resolve(process.cwd(), env('REPORTS_DIR') ?? env('WDIO_PRETTY_JSON_REPORT_DIR') ?? DEFAULT_REPORT_DIR),
    bucket: env('REPORTS_S3_BUCKET') ?? env('WDIO_PRETTY_JSON_S3_BUCKET') ?? '',
    prefix,
    region: env('AWS_REGION') ?? env('AWS_DEFAULT_REGION') ?? 'us-east-1',
    indexKey: env('REPORTS_S3_INDEX_KEY') ?? `${prefix}/reports-index.json`,
    updateIndex: boolEnv('REPORTS_S3_UPDATE_INDEX', true),
    project,
    platform: env('REPORTS_PLATFORM') ?? 'mobile',
    device: env('REPORTS_DEVICE') ?? env('DEVICE') ?? env('PLATFORM') ?? 'unknown',
    branch: env('REPORTS_BRANCH') ?? env('BITBUCKET_BRANCH') ?? env('GITHUB_REF_NAME') ?? env('BRANCH_NAME') ?? 'local',
    buildNumber: env('REPORTS_BUILD_NUMBER') ?? env('APP_BUILD_NUMBER') ?? env('BITBUCKET_BUILD_NUMBER') ?? env('GITHUB_RUN_NUMBER') ?? 'local',
    runId,
    metadata,
  };
};

const mergeOptions = (options: UploadWdioPrettyJsonToS3Options = {}): Required<Omit<UploadWdioPrettyJsonToS3Options, 'metadata'>> & { metadata?: Record<string, string> } => {
  const fromEnv = getOptionsFromEnv();
  const prefix = options.prefix ?? fromEnv.prefix;
  const project = options.project ?? env('REPORTS_PROJECT') ?? env('PROJECT_NAME') ?? prefix;
  return {
    ...fromEnv,
    ...options,
    prefix,
    project,
    indexKey: options.indexKey ?? env('REPORTS_S3_INDEX_KEY') ?? `${prefix}/reports-index.json`,
    reportsDir: path.resolve(process.cwd(), options.reportsDir ?? fromEnv.reportsDir),
    metadata: options.metadata ?? fromEnv.metadata,
  };
};

export async function uploadWdioPrettyJsonToS3(options: UploadWdioPrettyJsonToS3Options = {}): Promise<void> {
  const resolved = mergeOptions(options);

  if (!resolved.bucket) {
    throw new Error('[S3] Missing REPORTS_S3_BUCKET');
  }

  if (!fs.existsSync(resolved.reportsDir) || !fs.statSync(resolved.reportsDir).isDirectory()) {
    console.log(`[S3] Report folder not found, skipping upload: ${resolved.reportsDir}`);
    return;
  }

  const files = collectFiles(resolved.reportsDir);
  if (!files.length) {
    console.log(`[S3] No files found in report folder, skipping upload: ${resolved.reportsDir}`);
    return;
  }

  const client = createS3Client(resolved.region);
  const uploadedAt = new Date().toISOString();
  const runPath = `${resolved.prefix.replace(/\/+$/, '')}/${resolved.runId}`;
  const primaryReportFile = findPrimaryReportFile(files, resolved.reportsDir);
  const primaryJsonPath = primaryReportFile
    ? `${runPath}/${toS3SafePath(path.relative(resolved.reportsDir, primaryReportFile))}`
    : `${runPath}/report.json`;

  console.log(`[S3] Uploading ${files.length} report files to s3://${resolved.bucket}/${runPath}/`);

  for (const filePath of files) {
    const relativePath = path.relative(resolved.reportsDir, filePath);
    const key = `${runPath}/${toS3SafePath(relativePath)}`;
    const contentType = contentTypeByExt[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    await uploadBuffer(client, resolved.bucket, key, fs.readFileSync(filePath), contentType);
  }

  if (resolved.updateIndex) {
    const existingIndexText = await getObjectText(client, resolved.bucket, resolved.indexKey);
    let existingIndex: ReportsIndex | undefined;
    if (existingIndexText) {
      try {
        existingIndex = JSON.parse(existingIndexText) as ReportsIndex;
      } catch (error) {
        console.warn(`[S3] Unable to parse existing index ${resolved.indexKey}, rebuilding it: ${(error as Error).message}`);
      }
    }

    const reportEntry: ReportIndexEntry = {
      id: `${resolved.project}-${resolved.platform}-${resolved.device}-${resolved.buildNumber}-${resolved.runId}`,
      project: resolved.project,
      platform: resolved.platform,
      device: resolved.device,
      date: uploadedAt,
      buildNumber: resolved.buildNumber,
      branch: resolved.branch,
      jsonPath: primaryJsonPath,
      screenshotsPrefix: `${runPath}/screenshots/`,
      stats: getReportStats(primaryReportFile),
      ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
    };
    const reports = existingIndex?.reports ?? [];
    reports.unshift(reportEntry);

    const nextIndex: ReportsIndex = {
      project: resolved.project,
      lastUpdated: uploadedAt,
      count: reports.length,
      reports,
    };

    await uploadBuffer(client, resolved.bucket, resolved.indexKey, `${JSON.stringify(nextIndex, null, 2)}\n`, 'application/json');
    console.log(`[S3] Reports index updated: s3://${resolved.bucket}/${resolved.indexKey}`);
  }

  console.log(`[S3] Report upload completed: s3://${resolved.bucket}/${runPath}/`);
}

if (require.main === module) {
  uploadWdioPrettyJsonToS3({ reportsDir: normalize(process.argv[2]) }).catch((error) => {
    console.error('[S3] Report upload failed:', error?.message ?? error);
    process.exit(1);
  });
}