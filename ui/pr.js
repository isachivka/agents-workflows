/** A pull request (GitHub) or merge request (GitLab) URL. src/cli.ts has the same rule. */
export const isPrUrl = (v) => /^https?:\/\/\S+\/(pull|merge_requests)\/\d+/.test(String(v));

/** The run's PR: the standard `pr` var, else the first var that holds a PR URL; never any other link. */
export const prUrl = (vars) => {
  if (vars && vars.pr && /^https?:\/\//.test(vars.pr)) return vars.pr;
  return Object.values(vars || {}).find(isPrUrl) || null;
};

/** The repository a run works in, from its PR URL, without the owner: "web-app". */
export const repoName = (vars) => {
  const m = /([^/]+)\/(?:pull|merge_requests)\/\d+/.exec((prUrl(vars) || "").replace("/-/", "/")); // GitLab: …/api/-/merge_requests/3
  return m ? m[1] : null;
};

/** A Slack thread link. src/cli.ts has the same rule. */
export const isSlackUrl = (v) => /^https:\/\/[\w-]+\.slack\.com\/archives\//.test(String(v));

/** The run's Slack thread: the standard `slack_thread` var, else the first var holding a Slack link. */
export const slackUrl = (vars) => {
  if (vars && vars.slack_thread && /^https?:\/\//.test(vars.slack_thread)) return vars.slack_thread;
  return Object.values(vars || {}).find(isSlackUrl) || null;
};
