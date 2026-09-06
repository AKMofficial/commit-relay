// Every user-visible string lives here, so a locale contribution is a single-file
// diff rather than a hunt through the renderer. v1 is English and LTR only.
export const S = {
  repository: 'Repository',
  author: 'Author',
  branch: 'Branch',
  tag: 'Tag',
  files: 'Files',
  changes: 'Changes',
  commitMessage: 'Commit message',
  rollupCap: 'More commits in this push',
  rollupBranchCreate: 'New branch created',
  rollupForced: 'Force push',
  commitsNotShown: 'Individual commits are not shown for this push.',
  authors: 'Authors',
  viewCommit: 'View the commit',
  viewComparison: 'View the full comparison',
  viewPullRequest: 'View the pull request',
  pullRequest: 'Pull request',
  /** Separator in the Branch row of a pull request: head to base. */
  branchArrow: ' → ',
  prOpened: 'opened',
  prMerged: 'merged',
  prClosed: 'closed without merging',
  prReopened: 'reopened',
  prReadyForReview: 'ready for review',
  prReviewApproved: 'approved',
  prReviewChangesRequested: 'changes requested',
} as const;
