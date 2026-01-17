import { useEffect, useState } from "react";
import { ActivityList } from "./components/ActivityList";
import type { ActivityResponse } from "./lib/activity/types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: ActivityResponse };

type Profile = {
  login: string;
  url: string;
  avatarUrl: string;
};

type ProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; profile: Profile };

function formatGeneratedAt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short" }).format(d);
}

export default function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [profileState, setProfileState] = useState<ProfileState>({ status: "loading" });

  useEffect(() => {
    const ac = new AbortController();

    async function run() {
      try {
        const res = await fetch("/api/profile.json", {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          setProfileState({ status: "error" });
          return;
        }
        const profile = (await res.json()) as Profile;
        if (!profile?.login || !profile?.avatarUrl) {
          setProfileState({ status: "error" });
          return;
        }
        setProfileState({ status: "loaded", profile });
      } catch {
        if (ac.signal.aborted) return;
        setProfileState({ status: "error" });
      }
    }

    void run();
    return () => ac.abort();
  }, []);

  useEffect(() => {
    const ac = new AbortController();

    async function fetchPreview() {
      try {
        const res = await fetch("/api/activity.preview.json", {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as ActivityResponse;
        if (ac.signal.aborted) return;
        setState({ status: "loaded", data });
      } catch {
        // Ignore preview errors and keep going.
      }
    }

    async function fetchFull() {
      try {
        const res = await fetch("/api/activity.json", {
          headers: { accept: "application/json" },
          signal: ac.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as ActivityResponse;
        if (ac.signal.aborted) return;
        setState({ status: "loaded", data });
      } catch (e) {
        if (ac.signal.aborted) return;
        const message = e instanceof Error ? e.message : "Unknown error";
        setState((prev) => (prev.status === "loaded" ? prev : { status: "error", message }));
      }
    }

    void fetchPreview();
    void fetchFull();
    return () => ac.abort();
  }, []);

  const subtitle = "Latest GitHub activities for @JohnTitor";

  const profile = profileState.status === "loaded" ? profileState.profile : null;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(900px_circle_at_15%_5%,rgba(14,165,233,0.12),transparent_45%),radial-gradient(700px_circle_at_85%_0%,rgba(168,85,247,0.10),transparent_40%)] dark:bg-[radial-gradient(900px_circle_at_15%_5%,rgba(14,165,233,0.18),transparent_50%),radial-gradient(700px_circle_at_85%_0%,rgba(168,85,247,0.14),transparent_45%)]" />

      <div className="mx-auto max-w-4xl px-6 py-12">
        <header className="space-y-6">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">activity.2k36.org</h1>
              <p className="mt-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                {subtitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <a
                className="rounded-full border border-zinc-200/70 bg-white/50 px-4 py-2 text-s text-zinc-700 shadow-sm backdrop-blur hover:text-zinc-900 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-300 dark:hover:text-zinc-100"
                href="https://www.2k36.org/en/about"
                target="_blank"
                rel="noreferrer"
              >
                About me
              </a>
              <a
                className="rounded-full border border-zinc-200/70 bg-white/50 px-4 py-2 text-s text-zinc-700 shadow-sm backdrop-blur hover:text-zinc-900 dark:border-zinc-800/70 dark:bg-zinc-900/30 dark:text-zinc-300 dark:hover:text-zinc-100"
                href="https://github.com/JohnTitor"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-600 dark:text-zinc-400">
            {profileState.status === "loading" ? (
              <span className="inline-flex items-center gap-3">
                <span className="h-7 w-7 animate-pulse rounded-full bg-zinc-200/80 ring-1 ring-zinc-200/70 dark:bg-zinc-800/70 dark:ring-zinc-800/70" />
                <span className="h-4 w-24 animate-pulse rounded bg-zinc-200/80 dark:bg-zinc-800/70" />
              </span>
            ) : null}

            {profile ? (
              <a
                className="inline-flex items-center gap-3 no-underline hover:underline"
                href={profile.url}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="h-7 w-7 rounded-full ring-1 ring-zinc-200/70 dark:ring-zinc-800/70"
                  src={profile.avatarUrl}
                  alt={profile.login}
                  loading="lazy"
                />
                <span className="font-mono text-xs sm:text-sm">{profile.login}</span>
              </a>
            ) : null}

            <span className="basis-full h-0" aria-hidden="true" />

            {state.status === "loaded" ? (
              <span className="font-mono text-xs sm:text-sm">
                updated: {formatGeneratedAt(state.data.generatedAt)}
              </span>
            ) : null}
          </div>

          <div className="h-px w-full bg-gradient-to-r from-transparent via-zinc-200/80 to-transparent dark:via-zinc-800/80" />
        </header>

        <main className="mt-10">
          {state.status === "loading" ? (
            <ol className="relative grid gap-6 before:absolute before:inset-y-0 before:left-4 before:w-px before:bg-zinc-200/70 before:content-[''] dark:before:bg-zinc-800/70">
              {Array.from({ length: 6 }).map((_, i) => (
                <li key={i} className="relative pl-10">
                  <span
                    className="absolute left-2.5 top-6 h-3 w-3 rounded-full bg-zinc-300 ring-4 ring-zinc-50 dark:bg-zinc-700 dark:ring-zinc-950"
                    aria-hidden="true"
                  />
                  <div className="animate-pulse rounded-2xl border border-zinc-200/70 bg-white/50 p-4 shadow-sm backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-900/30">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-14 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                      <div className="h-3 w-40 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                    </div>
                    <div className="mt-3 h-5 w-3/4 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                    <div className="mt-2 h-4 w-2/3 rounded bg-zinc-200/80 dark:bg-zinc-800/80" />
                  </div>
                </li>
              ))}
            </ol>
          ) : null}

          {state.status === "error" ? (
            <div className="space-y-3 rounded-2xl border border-red-200/70 bg-white/50 p-4 text-sm text-zinc-700 shadow-sm backdrop-blur dark:border-red-900/40 dark:bg-zinc-900/30 dark:text-zinc-300">
              <p className="font-medium text-red-700 dark:text-red-300">Failed to load activity</p>
              <p className="break-words font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
                {state.message}
              </p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                For local development, start the Worker API in another terminal:{" "}
                <code className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-950/40">
                  pnpm worker:dev
                </code>
              </p>
            </div>
          ) : null}

          {state.status === "loaded" ? <ActivityList items={state.data.items} /> : null}
        </main>

        <footer className="mt-14 flex items-center justify-between gap-4 border-t border-zinc-200/70 pt-6 text-xs text-zinc-500 dark:border-zinc-800/70 dark:text-zinc-500">
          <p className="font-mono text-[11px]">© 2026 Yuki Okushi. All Rights Reserved.</p>
          <a
            className="inline-flex font-mono text-[11px] underline-offset-2 hover:underline"
            href="https://github.com/JohnTitor/activity.2k36.org"
            target="_blank"
            rel="noreferrer"
          >
            Source code
          </a>
        </footer>
      </div>
    </div>
  );
}
