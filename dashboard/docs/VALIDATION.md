# Integration validation

Date: 2026-09-12. All bookings, detections and vehicle conditions used for validation are synthetic. No physical vehicle was operated.

## English dashboard and real DeepSeek calls

The browser clicked the actual dashboard controls, received results through the server and SSE, and inspected the returned JSON.

| Scenario | Mode | API calls | Latency | Tokens | Result |
|---|---|---:|---:|---:|---|
| Wheelchair | single | 1 | 1597 ms | 1932 | Valid simulated automatic-ramp plan |
| Crutches | two_turn | 2 | 2405 ms | 3747 | English summary and actions; ramp kept stowed |

`docs/english-api-check.json` records these calls. Browser checks confirm English output, passenger locale `en-SG`, document language `en`, no page exceptions and no horizontal overflow at 390 px. The interface, system prompt, rule facts, fallback messages and passenger templates are in English. Screenshot checks also cover English labels on desktop and mobile.

These are individual observations, not statistical latency or reliability guarantees. During earlier development, one malformed API response correctly produced `API_INVALID_JSON` and a fallback plan. Paid requests are not automatically retried.

## Python → HTTP → dashboard

`scripts/check-python.mjs` sends only booking and perception through the Python client. It checks for a READY ramp simulation with `SIMULATED_SCENARIO` vehicle provenance and exactly two signal channels. The same result remains visible after sending stops, with no repeated API calls. This check uses free rules mode; output is in `outputs/python-check.json`.

The trained YOLO model and camera hardware have not been supplied, so real camera recognition has not been validated. The integration adapter is available for the vision team.

## Existing automated checks

The 39 Node policy/communication checks cover scenarios, signal fusion, deduplication, confidence jitter, superseded runs, separate summary events, retained presentation snapshots and HTTP/SSE authentication. Preset checks also verify English results and passenger locale. A separate server-rendering check verifies the actual dashboard and its English document language.

TypeScript, ESLint and the existing frontend build paths are used for verification. The original dependency lockfile and deployment configuration are preserved. Ultralytics is needed only in the vision environment, not to run the website presets.

## Historical records

`docs/live-api-check.json` and `docs/web-demo-api-check.json` retain the original API evidence from before the English conversion. Their recorded response text is unchanged. The earlier two-input live check used one API call, 1342 ms and 1946 tokens, with no vehicle endpoint.

This remains a single-booking prototype with in-memory state. Changes are local; no GitHub push, new public backend or website deployment has been performed.
