/** One finding as `soft-lint --json` reports it. `line` is the first added line of the window asked. */
export type ReportedFinding = {
  path: string;
  line: number;
  rule: string;
  score: number;
  cutoff: number;
  question: string;
};

/**
 * What `soft-lint --json` prints: either the error that stopped the run before it could ask anything, or the run's
 * findings and counts. `reasons` holds each distinct reason a window could not be checked; `unchecked` the paths of
 * those windows. `hunks` counts every hunk in the diff; `requests` the windows of the hunks a rule matched, each one
 * request. A hunk is one window unless it is longer than `maxHunkChars`.
 */
export type Report = { durationMs: number } & (
  | { error: string }
  | {
      model: string;
      files: number;
      hunks: number;
      requests: number;
      gatewayHits: number;
      findings: ReportedFinding[];
      unchecked: string[];
      reasons: string[];
    }
);
