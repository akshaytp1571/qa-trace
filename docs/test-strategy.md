# Test strategy

QA Trace's main risk is a plausible-looking plan that hides unresolved behavior or loses traceability. The checks focus on those decisions, document intake, and handling user keys without persistence.

## Automated layers

| Layer | What is checked | Boundary |
| --- | --- | --- |
| Plan validation | Exact excerpts match source lines; unique IDs; valid requirement/scenario/case/question links; consistent ready/blocked outcomes; derived reverse links; blocked recommendation deferral; uncovered scenario requirements | Does not judge whether an excerpt supports the model's interpretation |
| Clarifications | Stable answer IDs; parent ordering; combined context cap; every submitted answer reviewed once; follow-up evidence must cite its own parent answer; review states match current linked follow-ups | Does not assess semantic adequacy of an answer or guarantee useful model questions |
| Workspace | Allowlisted session storage retains document/plan/answers/drafts; excludes provider/key/endpoint settings; malformed or unavailable storage fails safely; explicit reset | Browser session storage is local to the tab, not a durable project database |
| Documents | UTF-8 handling; DOCX and PDF fixtures; malformed, oversized, scanned-only and excessive-expansion documents; page/character limits | Complex tables, reading order and diagrams require manual review |
| Providers | Native OpenAI/Anthropic envelopes; gateway URL/auth/model validation; all three JSON modes; endpoint path construction; safe upstream errors, refusals, truncation, timeout and cancellation | Native and external gateway responses are mocked; no live provider or model-quality claim |
| Gateway integration | Local HTTP gateway receives the real Chat Completions request from the app server; delayed responses return validated plans; the selected token cap reaches the gateway | Synthetic fixture and loopback service only |
| Request limits | Five-minute gateway default; bounded numeric settings; deterministic deadline abort during headers or body; external cancellation; distinct app/upstream/transport timeout errors | Timeout signals are simulated; no five-minute paid model call |
| HTTP | Local Host/origin boundaries; body limits; input validation; static allowlist; source validation; extraction; sanitized exceptions | No claim of internet-hosting readiness |
| Exports | Mappings and case information; formula neutralization; markup escaping; no key or full raw-source export | Exported excerpts may contain confidential product text |
| Browser | Demo; source modal and focus return; linked-case navigation; recommendations; clarification drafts across tabs; two-round answer/follow-up history; refresh and failure retention; stale source/answers; missing key; request settings; elapsed time; cancellation and failure cleanup; mocked analysis; JSON download; Markdown upload; Arrow/Home/End tab keys, dialog focus return, visible keyboard focus; representative text contrast; native screenshot width; narrow page and table scrolling | One installed Chromium browser, fixed demo response; sampled contrast is not a full accessibility audit; no screen-reader audit |

The browser check writes screenshots to `artifacts`. It serves an ephemeral local app instance and a separate temporary browser profile. It closes both when finished. A Windows file sandbox may block Chromium's internal process channels even though the application itself runs; browser verification needs an environment in which Chromium can launch normally.

## Manual live-provider check

This has not been executed using a real key during development.

1. Start the app and load `examples/refund-requirements.md`.
2. Select a direct provider or configure an OpenAI-compatible gateway's base URL, exact model ID, JSON mode and key if required. Expect a paid API call when using a paid service. Verify the gateway belongs to the account that issued the key.
3. Analyze. Confirm the actual document was analyzed and that the model returned a usable plan.
4. Check each extracted requirement against the original; split conflated requirements or correct the source where needed.
5. Follow all source references. Confirm the case's expected behavior is supported, not merely that its quote matches.
6. Review day-30 timing, email delay and support reopening questions. Exact wording and counts can vary by model.
7. Confirm blocked cases retain open expected outcomes and are deferred from both recommendations.
8. Type a partial answer, select **Analyze with answers**, and inspect the saved answer's review. If a follow-up is needed, verify its parent answer and source excerpt. Reply using **Save and analyze**. Confirm that prior answers remain visible after another analysis and refresh. Re-enter connection settings after refresh, because credentials are not saved.
9. Review automation layers against your system's real test interfaces and data setup. An API recommendation is conditional on that interface being available.
10. Download the plan and inspect it before committing it to a public repository.

## Adversarial and incomplete source review

Try a short document with contradictory statements, vague adjectives, no product requirements, or embedded instructions addressed to the AI. The prompt treats source text as data and domain validation checks shape/evidence, but that is not a semantic prompt-injection guarantee. A draft must be reviewed before adoption.

## Deliberate limits

- Readiness describes drafted cases, not test execution, correctness, or exhaustive coverage.
- The model can miss requirements or ask unnecessary questions even when structured validation passes.
- Source excerpts validate bytes and line references. They do not automatically validate interpretation, business priority, or expected outcomes.
- There is no semantic scoring benchmark, cross-provider quality comparison, account system, durable/shared project storage beyond this tab's session workspace, cross-document version diff, test execution, or automation-code generation in this release.
- Text-only PDF/DOCX extraction does not understand layout diagrams or images.
- The included CI workflow has been authored for a standalone repository; its GitHub-hosted run requires publishing the repository.
