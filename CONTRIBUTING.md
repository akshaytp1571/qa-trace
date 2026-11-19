# Contributing to QA Trace

QA Trace helps QA engineers turn requirements into a source-linked draft test plan. Contributions should make that plan easier to inspect, reproduce and challenge.

## Development

Use Node.js 22.13 or newer; Node 24 is recommended.

```sh
npm ci --ignore-scripts
npm start
```

The app starts on `http://127.0.0.1:4173`. The bundled example needs no API key.

## Checks

```sh
npm test
npx playwright install --with-deps chromium
npm run test:browser
```

On Windows, browser checks prefer installed Edge or Chrome; `QA_TRACE_BROWSER` can select an executable. The automated suite uses synthetic documents, mocked AI responses and local test gateways. It must not need a real API key or a paid call.

## Pull requests

- Describe the problem, intended behavior and verification performed.
- Keep requirements-to-source references and follow-up answer lineage explicit.
- Include tests for substantive validation, provider or state-handling changes.
- For interface changes, include actual desktop/mobile screenshots and check keyboard behavior.
- Report model behavior separately from deterministic schema validation. A passing test suite does not prove completeness or AI output quality.
- Keep API keys and connection settings out of storage, reports and logs.

## Reporting problems

Provide a small synthetic input, reproduction steps, expected and actual results, and relevant browser/Node versions. Remove keys, gateway credentials and confidential text before sharing screenshots or logs. Do not send working credentials or production customer data.

## License

Contributions are provided under the repository's MIT License.
