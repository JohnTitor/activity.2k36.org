import type { ActivityItem as ActivityItemType } from "../lib/activity/types";

function kindLabel(kind: ActivityItemType["kind"], reviewState?: ActivityItemType["reviewState"]) {
  switch (kind) {
    case "issue_opened":
      return "Issue";
    case "pull_request_opened":
      return "PR";
    case "pull_request_reopened":
      return "PR: Reopened";
    case "pull_request_closed":
      return "PR: Closed";
    case "pull_request_merged":
      return "PR: Merged";
    case "issue_or_pr_comment":
      return "Comment";
    case "pull_request_review": {
      switch (reviewState) {
        case "approved":
          return "Review: Approve";
        case "changes_requested":
          return "Review: Changes";
        case "commented":
          return "Review: Comment";
        default:
          return "Review";
      }
    }
    case "pull_request_review_comment":
      return "Review comment";
    case "release_published":
      return "Release";
    default:
      return "Activity";
  }
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function formatRelative(iso: string) {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return iso;

  const diffSeconds = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (abs < 60) return rtf.format(Math.round(diffSeconds / 1), "second");
  if (abs < 60 * 60) return rtf.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 60 * 60 * 24) return rtf.format(Math.round(diffSeconds / (60 * 60)), "hour");
  return rtf.format(Math.round(diffSeconds / (60 * 60 * 24)), "day");
}

function kindBadgeClass(
  kind: ActivityItemType["kind"],
  reviewState?: ActivityItemType["reviewState"],
) {
  switch (kind) {
    case "issue_opened":
      return "border-emerald-200/70 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "pull_request_opened":
      return "border-sky-200/70 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200";
    case "pull_request_reopened":
      return "border-sky-200/70 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-200";
    case "pull_request_closed":
      return "border-zinc-200/70 bg-zinc-50 text-zinc-800 dark:border-zinc-800/80 dark:bg-zinc-950/40 dark:text-zinc-200";
    case "pull_request_merged":
      return "border-violet-200/70 bg-violet-50 text-violet-800 dark:border-violet-900/50 dark:bg-violet-950/40 dark:text-violet-200";
    case "issue_or_pr_comment":
      return "border-amber-200/70 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200";
    case "pull_request_review": {
      switch (reviewState) {
        case "approved":
          return "border-emerald-200/70 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200";
        case "changes_requested":
          return "border-rose-200/70 bg-rose-50 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200";
        default:
          return "border-violet-200/70 bg-violet-50 text-violet-800 dark:border-violet-900/50 dark:bg-violet-950/40 dark:text-violet-200";
      }
    }
    case "pull_request_review_comment":
      return "border-violet-200/70 bg-violet-50 text-violet-800 dark:border-violet-900/50 dark:bg-violet-950/40 dark:text-violet-200";
    case "release_published":
      return "border-fuchsia-200/70 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-900/50 dark:bg-fuchsia-950/40 dark:text-fuchsia-200";
    default:
      return "border-zinc-200/70 bg-zinc-50 text-zinc-800 dark:border-zinc-800/80 dark:bg-zinc-950/40 dark:text-zinc-200";
  }
}

export function ActivityItem({ item }: { item: ActivityItemType }) {
  const label = kindLabel(item.kind, item.reviewState);
  const badgeClass = kindBadgeClass(item.kind, item.reviewState);
  const relative = formatRelative(item.createdAt);
  const absolute = formatDateTime(item.createdAt);

  return (
    <article className="min-w-0 rounded-2xl border border-zinc-200/70 bg-white/50 p-4 shadow-sm backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-900/30">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}
        >
          {label}
        </span>
        <a
          className="min-w-0 break-words font-mono text-[11px] text-zinc-600 no-underline hover:underline dark:text-zinc-400"
          href={item.repo.url}
          target="_blank"
          rel="noreferrer"
          title={item.repo.name}
        >
          {item.repo.name}
        </a>
        <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-500" title={absolute}>
          {relative}
        </span>
      </div>

      <h3 className="mt-2 break-words text-base font-medium leading-snug text-zinc-900 dark:text-zinc-100">
        <a
          className="no-underline hover:underline"
          href={item.url}
          target="_blank"
          rel="noreferrer"
        >
          {item.title}
        </a>
      </h3>

      {item.summary ? (
        <p className="mt-2 break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          {item.summary}
        </p>
      ) : null}
    </article>
  );
}
