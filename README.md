# wdio-pretty-json-reporter

> A **CTRF (Common Test Report Format)** JSON reporter for **WebdriverIO + Appium + Mocha + TypeScript** with auto-capture service and programmatic attachment API.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your Test Code                                               │
│  ├─ import { ctrf } from 'wdio-pretty-json-reporter'          │
│  ├─ ctrf.attach.screenshot('./path.png')                      │
│  └─ ctrf.log.info('custom message')                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  CtrfService (auto-capture)                                 │
│  ├─ Auto-screenshot on failure                              │
│  ├─ Auto-page-source on failure                             │
│  ├─ Auto-attach log files                                   │
│  └─ Exposes browser.ctrf.* API                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Shared State (in-process)                                  │
│  ├─ Active test tracking                                    │
│  ├─ Attachment queue                                        │
│  └─ Log buffer                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  CtrfReporter (observes + writes)                           │
│  ├─ Test lifecycle hooks                                    │
│  ├─ Hook tracking                                           │
│  ├─ Retry history                                           │
│  ├─ Flaky detection                                         │
│  └─ Writes ./ctrf/wdio-ctrf-report.json                     │
└─────────────────────────────────────────────────────────────┘
```

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
import type { Options } from '@wdio/types';
import CtrfReporter from 'wdio-pretty-json-reporter';
import CtrfService from 'wdio-pretty-json-reporter/service';

export const config: Options.Testrunner = {
  // ... other config

  reporters: [
    'spec',
    [CtrfReporter, {
      outputDir: './ctrf',
      outputFile: 'wdio-ctrf-report.json',
      captureLogs: true,
      includeHooks: true,
      includeRetries: true,
      markFlaky: true,
      tags: ['appium', 'e2e'],
      testType: 'e2e',
    }],
  ],

  services: [
    [CtrfService, {
      screenshot: {
        enabled: true,
        path: './screenshots',
        onFailureOnly: true,
      },
      pageSource: {
        enabled: true,
        onFailureOnly: true,
      },
      attachLogs: [
        './logs/appium.log',
      ],
      appiumLogPath: './logs/appium.log',
    }],
  ],
};
```

Important: do not use `'wdio-pretty-json-reporter'` as a reporter string. WDIO will try to resolve it as `wdio-wdio-pretty-json-reporter-reporter`.

If you prefer string registration, use `'ctrf'`:

```typescript
reporters: ['spec', ['ctrf', { outputDir: './ctrf' }]]
```

If you use CommonJS config, register the class directly:

```js
reporters: [
  'spec',
  [require('wdio-pretty-json-reporter').default, {
    outputDir: './ctrf',
  }],
],

services: [
  [require('wdio-pretty-json-reporter/service').default, {
    screenshot: { enabled: true, onFailureOnly: true },
  }],
]
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
| `includeHooks` | `boolean` | `true` | Include `before`/`after`/`beforeEach`/`afterEach` |
| `includeRetries` | `boolean` | `true` | Include per-attempt retry history |
| `markFlaky` | `boolean` | `true` | Mark tests as `flaky` if passed after retries |
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

## TypeScript Types

```typescript
import type {
  CtrfReport, CtrfTest, CtrfHook, CtrfRetry,
  CtrfAttachment, CtrfEnvironment, CtrfSummary
} from 'wdio-pretty-json-reporter';
```

---

## License

MIT
