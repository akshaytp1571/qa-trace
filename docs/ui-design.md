# Workspace visual design

QA Trace is an evidence-review tool for QA professionals. The interface should make the original requirements, draft results, and human decisions easy to distinguish.

## Direction

The workspace uses midnight navy surfaces with restrained cyan actions and periwinkle evidence links. The technical character comes from a precise hierarchy, fine borders, source IDs, and a subtle grid. It does not use animated decoration, artificial performance charts, or claimed provider connectivity.

The left column holds source input and a separate expandable AI connection section. A configuration prompt opens the settings, and validation reveals a missing field before focusing it. The right panel gives the plan title, real counts, review tabs, and linked evidence the most space. Small screens stack these panels; the evidence table keeps its columns in a keyboard-focusable horizontal scroll region with a visible hint.

Native form labels, disclosure elements, dialogs, and the existing tab semantics are retained. The source modal highlights the exact quoted excerpt. Readiness is labeled with words and color, and the footer continues to state that human review is required. “Settings entered” describes configuration only; it is not a connection test.

## Implementation boundaries

The redesign changes the browser markup, styles, configuration disclosure behavior, and source-link accessibility labels. Backend analysis, document extraction, provider adapters, answer lineage, session retention, and export formats are preserved.

The app uses system fonts and the existing component hooks; no new framework, font service, or production dependency was added. The browser harness now launches through Playwright directly, because CDP-attached screenshots on this Windows host cropped a scrollbar-width strip even though live geometry was correct.

## Rendered review

Current screenshots are captured from a real browser during the smoke test. The evidence set includes the initial matrix, third-party gateway settings, clarification history, an expanded case, source dialog, stale plan, running analysis, error, export menu, focus state, mobile layout, and an empty workspace.

A separate read-only review found clear source-to-evidence hierarchy and readable gateway/clarification controls. Smaller evidence text was enlarged during implementation. Apparent page clipping in earlier CDP captures was checked against live geometry and corrected by changing the capture method; the app itself had no page overflow. Horizontal table scrolling on mobile is intentional.

Functional verification separately exercises document intake, provider setup, multi-round answers, refresh, cancellation, errors, source-link focus return, exports, Arrow/Home/End tab navigation, and mobile evidence scrolling. Representative computed text/background pairs are checked against 4.5:1 contrast. These checks do not establish full accessibility or model quality.

## Owner review

Visual acceptance remains pending the owner's review. Render observations and passing tests are evidence, not aesthetic approval or proof of complete product fit.
