// GitHub webhook receivers barrel. The autonomous-intake ISSUES receiver lives here;
// the forge-CI webhook is GONE (the native gate is the merge authority — no-Actions
// delivery model — so there is no forge check-run state for a webhook to advance), and
// the JUnit-upload receiver is GONE (the native gate ingests the runner's JUnit report
// in-process). Only the issues receiver remains.

export { createIssueWebhookRoutes, type IssueWebhookRouteDeps } from "./issues.js";
