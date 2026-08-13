/**
 * `@signal-desk/ai` — the Anthropic client wrapper. The only package that spends money.
 *
 * Every call in the system goes through here so that the controls in
 * ARCHITECTURE.md §6 apply without exception:
 *
 *   - token accounting into `llm_calls`, per call, with the event id and stage
 *   - a hard daily USD ceiling that *degrades* rather than crashes, and never
 *     silently stops detection
 *   - model tiering (Haiku triage / Opus analysis) and the Batch API path
 *   - prompt caching, with a verified cache hit rather than an assumed one
 *   - structured outputs on every call — THREAT-MODEL.md §T-1 mitigation 2
 *   - no tools, ever, on any model that reads untrusted content (mitigation 1)
 *
 * Contents by phase:
 *   Phase 6 — client, budget guard, envelope, triage + analysis calls, MOCK twin
 */

export const PACKAGE_NAME = '@signal-desk/ai';
