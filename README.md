# wdio-pretty-json-reporter

> A JSON reporter for **WebdriverIO + Appium + Mocha + TypeScript** that generates CTRF-standard reports, with an auto-capture service and a programmatic attachment API.

## Why Better Than Other JSON Reporters?

**wdio-pretty-json-reporter** stands out from standard WebdriverIO reporters because:

- **CTRF Standard**: Outputs standardized CTRF format, making your test data portable and tool-agnostic
- **Auto-Capture Service**: Automatically captures screenshots, page source, and logs on failures—no manual code needed
- **Retry & Flaky Detection**: Tracks test retry history and automatically marks flaky tests for analysis
- **Programmatic API**: Full control via `ctrf.attach.*()` and `ctrf.log.*()` from your test code
- **Hook Tracking**: Captures `before`/`after`/`beforeEach`/`afterEach` lifecycle events with timing
- **File Attachments**: Easily embed screenshots, JSON, HTML, and arbitrary files in the report
- **Zero-Config Defaults**: Works out-of-the-box with sensible defaults; only customize what you need

---

## Easy Frontend Integration

The generated **CTRF JSON report** is frontend-friendly and integrates seamlessly with dashboards and test portals:

- **Structured Data**: Every test, hook, retry, and attachment is organized in a parseable JSON hierarchy
- **Embedded Artifacts**: Screenshots and HTML are encoded in the report—no external file fetching needed
- **Rich Metadata**: Custom tags, environment info, and timestamps make filtering and correlation simple
- **FE-Ready Format**: No transformation needed—parse the JSON directly in your React, Vue, or Angular dashboard
- **Programmatic Access**: Loop through test results, render timelines, display artifacts, and build live dashboards
- **Scalable**: Handles large test suites and thousands of attachments without performance impact


---

## Installation

```bash
npm install --save-dev wdio-pretty-json-reporter
```

Peers (already in wdio-appium-mocha-ts projects):
```bash
npm install --save-dev @wdio/reporter @wdio/types
```

---

## Quick Start

### 1. Configure `wdio.conf.ts`

```typescript
import wdioJSONReporter from 'wdio-pretty-json-reporter'
import wdioJSONService from 'wdio-pretty-json-reporter/service'

export const config: Options.Testrunner = {
  // ... other config

  reporters: [
    'spec',
    [
        wdioJSONReporter,
			{
				outputDir: './wdio-pretty-json',
			},
     ],
  ],

  services: [
		[
			wdioJSONService,
			{
				screenshot: { enabled: true, path: './wdio-pretty-json/screenshots', onFailureOnly: true },
				attachLogs: ['./appium.log'],
			},
		],
	]
};
```

### 2. Run tests

```bash
npx wdio run wdio.conf.ts
```

### 3. Find your report

```bash
cat ./ctrf/wdio-ctrf-report.json | jq '.summary'
```

---

## Reporter Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `outputDir` | `string` | `./ctrf` | Directory for JSON report |
| `outputFile` | `string` | `wdio-ctrf-report.json` | Report filename |
| `logLevel` | `string` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `silent` |
| `captureLogs` | `boolean` | `true` | Capture console logs into report |
| `environment` | `object` | `{}` | Custom environment metadata |
| `tags` | `string[]` | `[]` | Tags applied to every test |
| `testType` | `string` | `e2e` | Test type annotation |
| `metadata` | `object` | `{}` | Custom metadata per test |
| `transformTest` | `function` | — | Transform or filter tests before writing |
| `onComplete` | `function` | — | Callback after report is written |

---

## Service Options (Auto-Capture)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `screenshot.enabled` | `boolean` | `true` | Enable auto-screenshot capture |
| `screenshot.path` | `string` | `./screenshots` | Directory for screenshots |
| `screenshot.onFailureOnly` | `boolean` | `true` | Capture only on failure |
| `screenshot.naming` | `string \| function` | `'default'` | Naming pattern or custom function |
| `pageSource.enabled` | `boolean` | `true` | Enable page source capture |
| `pageSource.onFailureOnly` | `boolean` | `true` | Capture only on failure |
| `video.enabled` | `boolean` | `false` | Enable video recording |
| `video.path` | `string` | `./videos` | Directory for videos |
| `attachLogs` | `string[]` | `[]` | Log file paths to attach after each test |
| `appiumLogPath` | `string` | — | Appium server log to attach |
| `networkHarPath` | `string` | — | Network HAR file to attach |

---

## Upload Reports to S3

The package includes a generic S3 uploader for the generated report folder. It uploads every file in the report directory, preserves nested assets such as screenshots, and can maintain a `reports-index.json` for dashboards.

Set the below variables in .env
```bash
REPORTS_S3_BUCKET=my-report-bucket \
REPORTS_S3_PREFIX=my-project \
REPORTS_DIR=./wdio-pretty-json \
npx wdio-pretty-json-upload-s3
```

You can also pass the report folder as the first CLI argument:

```bash
npx wdio-pretty-json-upload-s3
```

### S3 Upload Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REPORTS_S3_BUCKET` | Yes | — | Target S3 bucket |
| `REPORTS_DIR` | No | `./wdio-pretty-json` | Local report directory to upload |
| `REPORTS_S3_PREFIX` | No | `wdio-pretty-json` | S3 prefix/project folder for uploaded runs |
| `REPORTS_RUN_ID` | No | CI run id or timestamp | Run folder name under the prefix |
| `REPORTS_S3_INDEX_KEY` | No | `${REPORTS_S3_PREFIX}/reports-index.json` | S3 key for the reports index |
| `REPORTS_S3_UPDATE_INDEX` | No | `true` | Set to `false` to skip index updates |
| `REPORTS_PROJECT` | No | `wdio-pretty-json` | Project name stored in the index |
| `REPORTS_PLATFORM` | No | `PLATFORM` or `unknown` | Platform metadata stored in the index |
| `REPORTS_DEVICE` | No | `DEVICE` or `unknown` | Device metadata stored in the index |
| `REPORTS_BRANCH` | No | CI branch or `local` | Branch metadata stored in the index |
| `REPORTS_BUILD_NUMBER` | No | CI build number or `local` | Build metadata stored in the index |
| `REPORTS_S3_JSON_NAMES` | No | `report.json,wdio-ctrf-report.json,wdio-report.json` | Preferred JSON report filenames for index `jsonPath` |
| `REPORTS_METADATA_JSON` | No | — | Extra index metadata as a JSON object |
| `AWS_REGION` | No | `us-east-1` | AWS region |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | No | AWS SDK default chain | AWS credentials; IAM role/default profile also work |

Programmatic use is available too:

```typescript
import { uploadWdioPrettyJsonToS3 } from 'wdio-pretty-json-reporter/s3-uploader';

await uploadWdioPrettyJsonToS3({
  bucket: 'my-report-bucket',
  prefix: 'my-project',
  reportsDir: './wdio-pretty-json',
});
```

---

## Programmatic API (from test code)

```typescript
import { ctrf } from 'wdio-pretty-json-reporter';

describe('Login', () => {
  it('should login', async () => {
    await $('#username').setValue('admin');

    // Attach custom JSON
    ctrf.attach.json('login-payload', { username: 'admin', ts: Date.now() });

    // Attach raw text
    ctrf.log.info('Login button clicked');

    // Attach a file
    ctrf.attach.screenshot('./custom-shot.png');

    // Attach HTML page source manually
    ctrf.attach.html('custom-source.html', '<html>...</html>');

    await expect($('#dashboard')).toBeDisplayed();
  });
});
```

### `ctrf.attach.*` Methods

| Method | Description |
|--------|-------------|
| `screenshot(path, name?)` | Attach screenshot file |
| `video(path, name?)` | Attach video file |
| `logFile(path, name?)` | Attach text log file |
| `text(name, content)` | Attach raw text inline |
| `json(name, data)` | Attach JSON inline |
| `html(name, content)` | Attach HTML inline |
| `appiumLog(path)` | Attach Appium server log |
| `networkHar(path)` | Attach network HAR |
| `file(name, path, mime, category?)` | Generic file attachment |
| `custom(attachment)` | Full control |

### `ctrf.log.*` Methods

| Method | Description |
|--------|-------------|
| `trace(msg)` | Trace-level log |
| `debug(msg)` | Debug-level log |
| `info(msg)` | Info-level log |
| `warn(msg)` | Warn-level log |
| `error(msg)` | Error-level log |

### `browser.ctrf` API (available in tests)

```typescript
// Same as import { ctrf } — available globally on browser object
await browser.ctrf.attach.screenshot('./path.png');
browser.ctrf.log.info('message');
```

---

## Report Output Example

```json
{
  "version": "1.0",
  "tool": { "name": "wdio-appium-mocha-ts", "version": "mocha" },
  "summary": {
    "tests": 10,
    "passed": 8,
    "failed": 1,
    "skipped": 1,
    "other": 0,
    "start": 1722100000000,
    "stop": 1722100030000,
    "duration": 30000,
    "suites": 3,
    "flaky": 1
  },
  "tests": [
    {
      "name": "should login with valid credentials",
      "status": "passed",
      "duration": 4523,
      "start": 1722100001000,
      "stop": 1722100005523,
      "suite": "Login Suite",
      "filepath": "/tests/login.spec.ts",
      "tags": ["appium", "e2e"],
      "type": "e2e",
      "retries": 1,
      "flaky": true,
      "platform": "Android",
      "device": "Pixel 7",
      "browser": "Chrome",
      "log": "[2024-07-27T...] [INFO] Login button clicked",
      "attachments": [
        {
          "name": "failure-screenshot",
          "path": "./screenshots/Login_Suite_should_login..._1722100002000.png",
          "type": "image/png",
          "category": "screenshot",
          "timestamp": 1722100002000
        },
        {
          "name": "login-payload.json",
          "content": "{\n  \"username\": \"admin\",\n  \"ts\": 1722100001000\n}",
          "type": "application/json",
          "category": "trace",
          "timestamp": 1722100001500
        }
      ],
      "hooks": [
        {
          "type": "beforeEach",
          "title": "\"before each\" hook",
          "status": "passed",
          "duration": 1200,
          "start": 1722100001000,
          "stop": 1722100002200
        }
      ],
      "retriesDetail": [
        {
          "attempt": 1,
          "status": "failed",
          "duration": 2100,
          "message": "Element not found",
          "trace": "Error: Element not found\n    at ...",
          "log": "[2024-07-27T...] [ERROR] Element not found"
        }
      ]
    }
  ],
  "environment": {
    "platformName": "Android",
    "platformVersion": "14",
    "deviceName": "Pixel 7",
    "browser": "Chrome",
    "browserVersion": "126",
    "appName": "/apps/app-debug.apk"
  }
}
```

---

## Open Source & Contributing

This project is **open source** and licensed under the **MIT License**.

- 📖 **License**: [MIT](LICENSE) — Free to use, modify, and distribute
- 🐛 **Report Issues**: [GitHub Issues](https://github.com/amartanwar42/wdio-pretty-json-reporter/issues)
- 🤝 **Contribute**: Contributions are welcome! Fork the repo and submit a PR
- ⭐ **Star Us**: Show your support by starring the [repository](https://github.com/amartanwar42/wdio-pretty-json-reporter)

### Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and run tests: `npm test && npm run lint`
4. Commit: `git commit -am 'Add my feature'`
5. Push to branch: `git push origin feature/my-feature`
6. Open a Pull Request

---

## License

**MIT License** © 2026 Amar Tanwar

See [LICENSE](LICENSE) file for details.

