/**
 * GitHub — Repository Intelligence & Git Activity Explorer.
 *
 * Replaces the obsolete in-app browser viewer. Concaretti opens external browser
 * windows natively; this panel surfaces real GitHub commit velocity, PR queues,
 * and repository telemetry for the active project.
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { GithubSummary } from "../types";
import { Spinner, relTime } from "./ui";

const POPULAR_REPOS = [
  "JaimeCabary/concaretti-framework",
  "facebook/react",
  "tailwindlabs/tailwindcss",
];

export function GithubPanel() {
  const [repo, setRepo] = useState("JaimeCabary/concaretti-framework");
  const [inputRepo, setInputRepo] = useState("JaimeCabary/concaretti-framework");
  const [data, setData] = useState<GithubSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<"commits" | "prs">("commits");

  const fetchSummary = useCallback((targetRepo: string) => {
    const trimmed = targetRepo.trim();
    if (!trimmed) return;
    setLoading(true);
    setErr(null);
    api
      .githubSummary(trimmed)
      .then((res) => {
        if (res.ok) {
          setData(res);
        } else {
          setErr(res.summary || "Failed to load repository summary");
        }
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : "GitHub API request failed");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchSummary(repo);
  }, [fetchSummary, repo]);

  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = inputRepo.trim();
    if (trimmed && trimmed !== repo) {
      setRepo(trimmed);
    } else if (trimmed) {
      fetchSummary(trimmed);
    }
  };

  return (
    <div className="flex flex-col h-full bg-void text-fg overflow-hidden">
      {/* ── Top Bar ── */}
      <div className="shrink-0 flex items-center justify-between border-b border-hairline px-6 py-3 bg-void gap-4">
        {/* Title & Live Status */}
        <div className="flex items-center gap-3 shrink-0">
          <h1 className="type-display text-[22px] leading-none text-fg">GitHub</h1>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-dim bg-obsidian px-2.5 py-1 rounded-full border border-hairline shadow-2xs">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live Sync
          </span>
        </div>

        {/* Repo Search */}
        <form onSubmit={handleSearch} className="flex-1 max-w-md flex items-center gap-2">
          <input
            value={inputRepo}
            onChange={(e) => setInputRepo(e.target.value)}
            placeholder="owner/repo…"
            autoComplete="off"
            spellCheck={false}
            className="field w-full font-mono text-[12px] bg-obsidian/60 py-1.5 px-3"
          />
          <button
            type="submit"
            disabled={loading || !inputRepo.trim()}
            className="btn btn-primary shrink-0 px-4 py-1.5 text-[12px] font-bold"
          >
            {loading ? <Spinner label="" /> : "Load"}
          </button>
        </form>

        {/* Quick Presets & Link */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-1.5">
            {POPULAR_REPOS.map((r) => {
              const shortName = r.split("/")[1] || r;
              const isCurrent = repo === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    setInputRepo(r);
                    setRepo(r);
                  }}
                  className={`px-2.5 py-1 rounded-full text-[11px] transition-all cursor-pointer ${
                    isCurrent
                      ? "bg-[#ffd93d] text-black font-semibold border border-amber-400/80 shadow-2xs"
                      : "bg-obsidian border border-hairline text-dim hover:text-fg hover:border-fg/30"
                  }`}
                >
                  {shortName}
                </button>
              );
            })}
          </div>

          <a
            href={`https://github.com/${repo}`}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-muted hover:text-fg transition-colors p-1"
            title="Open in GitHub"
          >
            ↗
          </a>
        </div>
      </div>

      {err && (
        <div className="shrink-0 border-b border-danger-soft bg-danger-soft px-6 py-2 text-[11px] text-danger font-semibold">
          ⚠ {err}
        </div>
      )}

      {/* ── Main Content Area ── */}
      <div className="flex flex-1 min-h-0">
        {/* Left Column: Repository Info & Key Metrics */}
        <div className="w-[300px] shrink-0 border-r border-hairline bg-void flex flex-col">
          <div className="p-5 border-b border-hairline bg-obsidian/30">
            <h2 className="text-[15px] font-bold text-fg break-all leading-snug">
              {data?.repo || repo}
            </h2>
            <p className="text-[12px] text-dim mt-2 leading-relaxed line-clamp-4">
              {data?.description || "No repository description provided."}
            </p>
          </div>

          {/* Metrics Tiles */}
          <div className="grid grid-cols-2 gap-2 p-4 border-b border-hairline">
            <div className="bg-obsidian/60 border border-hairline rounded-lg p-3">
              <span className="text-[10px] text-muted block">Stars</span>
              <span className="type-mono text-[16px] font-bold text-fg mt-0.5 block">
                {data?.stars ?? "—"}
              </span>
            </div>
            <div className="bg-obsidian/60 border border-hairline rounded-lg p-3">
              <span className="text-[10px] text-muted block">Open Issues</span>
              <span className="type-mono text-[16px] font-bold text-fg mt-0.5 block">
                {data?.open_issues ?? "—"}
              </span>
            </div>
            <div className="bg-obsidian/60 border border-hairline rounded-lg p-3">
              <span className="text-[10px] text-muted block">Branch</span>
              <span className="type-mono text-[13px] font-semibold text-fg mt-0.5 block truncate">
                {data?.default_branch || "main"}
              </span>
            </div>
            <div className="bg-obsidian/60 border border-hairline rounded-lg p-3">
              <span className="text-[10px] text-muted block">CI Status</span>
              <span className="type-mono text-[12px] font-medium text-emerald-600 mt-0.5 block truncate">
                {data?.ci_status || "passing"}
              </span>
            </div>
          </div>

          <div className="p-4 flex-1 flex flex-col justify-end">
            <a
              href={`https://github.com/${repo}`}
              target="_blank"
              rel="noreferrer"
              className="btn w-full justify-center py-2 text-[12px] font-semibold border-hairline bg-obsidian hover:bg-elevated text-fg transition-colors"
            >
              View on GitHub ↗
            </a>
          </div>
        </div>

        {/* Right Column: Commits & PRs List */}
        <div className="flex-1 flex flex-col min-w-0 bg-void">
          {/* Sub-tabs: Commits / Pull Requests */}
          <div className="shrink-0 px-6 py-2.5 border-b border-hairline bg-obsidian/30 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setActiveFilter("commits")}
                className={`text-[12px] font-semibold pb-0.5 transition-colors cursor-pointer ${
                  activeFilter === "commits"
                    ? "text-fg border-b-2 border-fg"
                    : "text-muted hover:text-dim"
                }`}
              >
                Commits {data?.commits ? `(${data.commits.length})` : ""}
              </button>
              <button
                type="button"
                onClick={() => setActiveFilter("prs")}
                className={`text-[12px] font-semibold pb-0.5 transition-colors cursor-pointer ${
                  activeFilter === "prs"
                    ? "text-fg border-b-2 border-fg"
                    : "text-muted hover:text-dim"
                }`}
              >
                Pull Requests {data?.pull_requests ? `(${data.pull_requests.length})` : "(0)"}
              </button>
            </div>

            {data?.pushed_at && (
              <span className="text-[11px] text-muted">
                Last push {new Date(data.pushed_at).toLocaleDateString()}
              </span>
            )}
          </div>

          {/* List Area */}
          <div className="flex-1 overflow-y-auto">
            {loading && !data ? (
              <div className="flex items-center justify-center h-full">
                <Spinner label="Fetching repository data…" />
              </div>
            ) : activeFilter === "commits" ? (
              (!data?.commits || data.commits.length === 0) ? (
                <div className="p-8 text-center text-muted text-[13px]">
                  No recent commits recorded
                </div>
              ) : (
                <div className="divide-y divide-hairline">
                  {data.commits.map((c) => (
                    <div
                      key={c.sha}
                      className="px-6 py-3 hover:bg-obsidian/40 transition-colors flex items-start justify-between gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-fg leading-snug">
                          {c.message.split("\n")[0]}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted">
                          <span className="font-semibold text-dim">{c.author}</span>
                          <span>·</span>
                          <span className="type-mono">{c.sha.slice(0, 7)}</span>
                        </div>
                      </div>
                      <span className="type-mono text-[11px] text-muted shrink-0 pt-0.5">
                        {c.date ? relTime(Math.floor(new Date(c.date).getTime() / 1000)) : "recent"}
                      </span>
                    </div>
                  ))}
                </div>
              )
            ) : (
              (!data?.pull_requests || data.pull_requests.length === 0) ? (
                <div className="p-8 text-center text-muted text-[13px]">
                  No open pull requests
                </div>
              ) : (
                <div className="divide-y divide-hairline">
                  {data.pull_requests.map((pr) => (
                    <div
                      key={pr.number}
                      className="px-6 py-3 hover:bg-obsidian/40 transition-colors flex items-center justify-between gap-4"
                    >
                      <div>
                        <p className="text-[13px] font-medium text-fg">{pr.title}</p>
                        <p className="type-mono text-[11px] text-muted mt-0.5">
                          #{pr.number} by {pr.author}
                        </p>
                      </div>
                      <span className="text-[11px] text-emerald-600 font-semibold uppercase">
                        {pr.draft ? "Draft" : "Open"}
                      </span>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
