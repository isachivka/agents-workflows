/** A pull request (GitHub) or merge request (GitLab) URL. src/cli.ts has the same rule. */
export const isPrUrl = (v) => /^https?:\/\/\S+\/(pull|merge_requests)\/\d+/.test(String(v));

/** The run's PR: the standard `pr` var, else the first var that holds a PR URL; never any other link. */
export const prUrl = (vars) => {
  if (vars && vars.pr && /^https?:\/\//.test(vars.pr)) return vars.pr;
  return Object.values(vars || {}).find(isPrUrl) || null;
};
