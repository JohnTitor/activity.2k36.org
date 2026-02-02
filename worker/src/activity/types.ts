export type ActivityKind =
  | "issue_opened"
  | "pull_request_opened"
  | "pull_request_reopened"
  | "pull_request_closed"
  | "pull_request_merged"
  | "issue_or_pr_comment"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "release_published";

export type ActivityRepo = {
  name: string;
  url: string;
};

export type ActivityActor = {
  login: string;
  url: string;
  avatarUrl: string;
};

export type ActivityCommit = {
  sha: string;
  message: string;
  url: string;
};

export type PullRequestReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed"
  | "pending"
  | "unknown";

export type ActivityErrorInfo = {
  kind:
    | "rate_limit"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "validation"
    | "server"
    | "network"
    | "timeout"
    | "unknown";
  status?: number;
  retryAfter?: number;
  rateLimitReset?: number;
  requestId?: string;
  message?: string;
};

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  actor: ActivityActor;
  repo: ActivityRepo;
  title: string;
  url: string;
  summary?: string;
  body?: string;
  reviewState?: PullRequestReviewState;
};

export type ActivityResponse = {
  username: string;
  generatedAt: string;
  items: ActivityItem[];
  partial?: boolean;
  errorInfo?: ActivityErrorInfo;
};
