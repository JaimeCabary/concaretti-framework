/**
 * Documentation & Supervisor Evaluation Panel
 *
 * Provides a native reference within Concaretti for supervisors and evaluators:
 * 1. Paper Thesis & Empirical Metrics Mapping (Table 5 & Table 6)
 * 2. Step-by-step Verification & Live Demonstration Guide
 * 3. 15-Agent & 42-Tool Capability Directory
 * 4. Architectural Invariants & Security Boundaries
 */

import { useState } from "react";

type DocSection = "overview" | "evaluation" | "metrics" | "agents" | "security";

export function DocsPanel() {
  const [section, setSection] = useState<DocSection>("overview");

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4 md:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6 border-b-2 border-fg pb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <span className="type-mono text-[11px] font-bold text-accent uppercase tracking-wider">
              Research & Evaluation Reference
            </span>
            <h1 className="type-display text-2xl md:text-3xl mt-1 text-fg">
              Concaretti Architecture & Evaluation
            </h1>
            <p className="type-mono text-[12px] text-dim mt-1">
              Federal University of Technology Owerri (FUTO) • Department of Software Engineering
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 text-xs font-mono rounded bg-emerald-100 text-emerald-800 border border-emerald-300 font-semibold">
              159 / 159 Invariants Passing
            </span>
            <span className="px-2.5 py-1 text-xs font-mono rounded bg-void text-fg border border-fg font-semibold">
              v1.0-UJEAS
            </span>
          </div>
        </div>

        {/* Section Navigation Tabs */}
        <div className="mt-6 flex flex-wrap gap-2">
          {[
            { id: "overview", label: "Overview & Thesis" },
            { id: "evaluation", label: "Supervisor Evaluation Guide" },
            { id: "metrics", label: "Paper Metrics (Table 5 & 6)" },
            { id: "agents", label: "Agent Directory (15/42)" },
            { id: "security", label: ".conca & HALO Boundaries" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSection(tab.id as DocSection)}
              className={`px-3 py-1.5 text-xs font-mono transition-all rounded ${
                section === tab.id
                  ? "bg-fg text-void font-bold shadow-sm"
                  : "bg-elevated text-dim hover:text-fg hover:bg-void border border-hairline"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content Areas */}
      {section === "overview" && (
        <div className="space-y-6">
          <div className="rounded-lg border-2 border-fg bg-elevated p-5 shadow-sm">
            <h2 className="type-display text-lg font-bold text-fg mb-2">
              Research Abstract & Purpose
            </h2>
            <p className="text-sm leading-relaxed text-dim mb-3">
              The evolution of Agentic AI from single reasoning loops to swarms capable of autonomous operating-system execution introduces fundamental safety and coordination failures: cross-session amnesia, privilege escalation during delegation, and vulnerability to prompt-injected tool overrides.
            </p>
            <p className="text-sm leading-relaxed text-dim mb-3">
              <strong>Concaretti</strong> is an open-source, fault-tolerant multi-agent orchestration framework featuring <em>declarative execution authority</em>. Authority is decoupled entirely from stochastic LLM reasoning into an inspectable, deterministic declarative policy file (<code className="bg-void px-1.5 py-0.5 rounded border border-hairline text-fg">.conca</code>). The runtime incorporates a 4-tier memory architecture with strict semantic privacy boundaries (Rule 0) and Hierarchical Autonomous Logic-Oriented (HALO) human-in-the-loop oversight gates.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-lg border-2 border-hairline bg-void p-4">
              <span className="type-mono text-[10px] text-muted uppercase">Core Pillar 1</span>
              <h3 className="font-bold text-sm text-fg mt-1">Declarative Authority</h3>
              <p className="text-xs text-dim mt-2 leading-relaxed">
                Tool dispatch is verified against the <code className="text-xs">.conca</code> contract <em>after</em> the model plans but <em>before</em> any tool executes. Model hallucination or adversarial prompts cannot bypass this layer.
              </p>
            </div>

            <div className="rounded-lg border-2 border-hairline bg-void p-4">
              <span className="type-mono text-[10px] text-muted uppercase">Core Pillar 2</span>
              <h3 className="font-bold text-sm text-fg mt-1">4-Tier Memory & Rule 0</h3>
              <p className="text-xs text-dim mt-2 leading-relaxed">
                Durable SQLite tables, chronological transcript, vector embeddings (<code className="text-xs">sqlite-vec</code>), and human-authored Hikari context. Rule 0 guarantees sensitive data is never embedded or recalled.
              </p>
            </div>

            <div className="rounded-lg border-2 border-hairline bg-void p-4">
              <span className="type-mono text-[10px] text-muted uppercase">Core Pillar 3</span>
              <h3 className="font-bold text-sm text-fg mt-1">HALO Oversight Gate</h3>
              <p className="text-xs text-dim mt-2 leading-relaxed">
                Irreversible operations (financial checkout handoffs, external communications, file writes, code execution) suspend automatically for operator approval with fail-closed timeout defaults.
              </p>
            </div>
          </div>

          <div className="rounded-lg border-2 border-hairline bg-elevated p-5">
            <h3 className="font-bold text-sm text-fg mb-2">Author & Affiliation Details</h3>
            <ul className="text-xs space-y-1.5 text-dim font-mono">
              <li>• <strong>Principal Investigator:</strong> Shalom Ebere Chidi-Azuwike (Reg No: 20211280502)</li>
              <li>• <strong>Supervisors / Co-Authors:</strong> Engr. Dr. Mrs. F.O. Elei, Engr. Dr. Azubuike Izuchukwu Erike, Dr. Okoronkwo Chinomso D., Prof. Charles O. Ikerionwu, Dr. Ikenna Caesar Nwandu, Dr. Abraham Ovwonuri</li>
              <li>• <strong>Institution:</strong> Department of Software Engineering, SICT, Federal University of Technology Owerri (FUTO)</li>
            </ul>
          </div>
        </div>
      )}

      {section === "evaluation" && (
        <div className="space-y-6">
          <div className="rounded-lg border-2 border-fg bg-elevated p-5 shadow-sm">
            <h2 className="type-display text-lg font-bold text-fg mb-1">
              Supervisor Evaluation & Verification Guide
            </h2>
            <p className="text-xs text-dim mb-4">
              Follow these three practical steps to independently audit the claims made in the research paper:
            </p>

            <div className="space-y-4">
              <div className="border-l-4 border-fg pl-4 py-1 bg-void rounded-r p-3">
                <h3 className="font-bold text-sm text-fg">Step 1: Execute the 159 Invariant Tests</h3>
                <p className="text-xs text-dim mt-1">
                  Open a terminal in the project root directory and run:
                </p>
                <pre className="mt-2 p-2 bg-obsidian text-paper rounded text-xs font-mono overflow-x-auto">
uv run --project backend pytest
                </pre>
                <p className="text-[11px] text-muted mt-2">
                  ✓ Expected outcome: <strong>159 passed in ~6.7s (0 failures)</strong> covering all 11 control surfaces (T-01 to T-11).
                </p>
              </div>

              <div className="border-l-4 border-fg pl-4 py-1 bg-void rounded-r p-3">
                <h3 className="font-bold text-sm text-fg">Step 2: Test the .conca Policy Simulator</h3>
                <p className="text-xs text-dim mt-1">
                  Navigate to the <strong>.conca Rules</strong> tab in this app. Under the <em>Simulator</em> section, paste an obfuscated shell attack:
                </p>
                <pre className="mt-2 p-2 bg-obsidian text-paper rounded text-xs font-mono overflow-x-auto">
\x72\x6d -rf /
                </pre>
                <p className="text-[11px] text-muted mt-2">
                  ✓ Expected outcome: The nine-strategy Shell Normalizer de-obfuscates the input to <code className="text-xs">rm -rf /</code>, detects the command on the deny-list, and outputs an immediate deterministic <strong>REFUSAL</strong> without passing to an LLM.
                </p>
              </div>

              <div className="border-l-4 border-fg pl-4 py-1 bg-void rounded-r p-3">
                <h3 className="font-bold text-sm text-fg">Step 3: Test Role Capability Confinement</h3>
                <p className="text-xs text-dim mt-1">
                  In Settings or the Role Switcher, switch the active role from <strong>Staff</strong> to <strong>Student</strong> or <strong>Public</strong>.
                </p>
                <p className="text-[11px] text-muted mt-2">
                  ✓ Expected outcome: High-privilege agents (such as Screen Capture or Chain transactions) disappear from the DAG routing surface. The backend cryptographically re-verifies role HMAC cookies on every request to prevent client-side privilege escalation.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {section === "metrics" && (
        <div className="space-y-6">
          <div className="rounded-lg border-2 border-hairline bg-elevated p-5">
            <h2 className="type-display text-lg font-bold text-fg mb-1">
              Table 5: Architectural Metrics (Before vs. Rebuilt)
            </h2>
            <p className="text-xs text-dim mb-4">
              Comparison between the original distributed microservices architecture and the rebuilt single-process Concaretti runtime.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono border-collapse">
                <thead>
                  <tr className="border-b-2 border-fg bg-void">
                    <th className="p-2 font-bold">Property</th>
                    <th className="p-2">First Architecture</th>
                    <th className="p-2 font-bold">Rebuilt Runtime</th>
                    <th className="p-2">Measured Delta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  <tr>
                    <td className="p-2 font-semibold">Processes to start</td>
                    <td className="p-2 text-dim">20</td>
                    <td className="p-2 font-bold text-fg">1</td>
                    <td className="p-2 text-emerald-600 font-bold">−95%</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-semibold">External services required</td>
                    <td className="p-2 text-dim">3 (Redis, Postgres, Browserless)</td>
                    <td className="p-2 font-bold text-fg">0</td>
                    <td className="p-2 text-emerald-600 font-bold">Eliminated</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-semibold">Policy status endpoint latency</td>
                    <td className="p-2 text-dim">—</td>
                    <td className="p-2 font-bold text-fg">12 ms</td>
                    <td className="p-2 text-dim">Measured</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-semibold">Full invariant test suite</td>
                    <td className="p-2 text-dim">Not present</td>
                    <td className="p-2 font-bold text-emerald-600">159 tests (6.72 s)</td>
                    <td className="p-2 text-dim">100% Pass Rate</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-semibold">Persistent store on disk</td>
                    <td className="p-2 text-dim">PostgreSQL cluster</td>
                    <td className="p-2 font-bold text-fg">3.36 MB single SQLite file</td>
                    <td className="p-2 text-dim">Measured</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-semibold">Memory tiers</td>
                    <td className="p-2 text-dim">3</td>
                    <td className="p-2 font-bold text-fg">4 (Hikari added)</td>
                    <td className="p-2 text-emerald-600 font-bold">+1 Tier</td>
                  </tr>
                  <tr>
                    <td className="p-2 font-semibold">Model ladder slots</td>
                    <td className="p-2 text-dim">37 models / 13 tiers</td>
                    <td className="p-2 font-bold text-fg">47 slots / 33 live / 7 providers</td>
                    <td className="p-2 text-dim">+10 slots</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border-2 border-hairline bg-elevated p-5">
            <h2 className="type-display text-lg font-bold text-fg mb-1">
              Table 6: 11 Control Surfaces & Invariant Breakdown
            </h2>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-left text-xs font-mono border-collapse">
                <thead>
                  <tr className="border-b-2 border-fg bg-void">
                    <th className="p-2">Surface ID</th>
                    <th className="p-2">Target Boundary</th>
                    <th className="p-2">Tests</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {[
                    { id: "T-01", name: "Gate declaration integrity", tests: 16 },
                    { id: "T-02", name: "Gate reachability, offline planning", tests: 10 },
                    { id: "T-03", name: "Secret material at prompt ingress", tests: 13 },
                    { id: "T-04", name: "Filesystem authority & directory bounds", tests: 13 },
                    { id: "T-05", name: "Shell obfuscation (9 de-obfuscation strategies)", tests: 24 },
                    { id: "T-06", name: "SSRF & blocked cloud metadata/loopback", tests: 10 },
                    { id: "T-07", name: "Rule 0 privacy boundary (exclusion from vector DB)", tests: 20 },
                    { id: "T-08", name: "Cardholder data (PAN/CVC never touches disk)", tests: 8 },
                    { id: "T-09", name: "Screen capture authority (explicit staff permission)", tests: 20 },
                    { id: "T-10", name: "Role & capability authority floors", tests: 11 },
                    { id: "T-11", name: "Interface conformance & Hikari tier integrity", tests: 14 },
                  ].map((row) => (
                    <tr key={row.id}>
                      <td className="p-2 font-bold text-fg">{row.id}</td>
                      <td className="p-2">{row.name}</td>
                      <td className="p-2 font-bold">{row.tests} tests</td>
                      <td className="p-2 text-emerald-600 font-bold">✓ 100% Passed</td>
                    </tr>
                  ))}
                  <tr className="bg-void font-bold border-t-2 border-fg">
                    <td className="p-2" colSpan={2}>Total Verified Invariants</td>
                    <td className="p-2 text-emerald-700">159 tests</td>
                    <td className="p-2 text-emerald-700">All Passed</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {section === "agents" && (
        <div className="space-y-6">
          <div className="rounded-lg border-2 border-hairline bg-elevated p-5">
            <h2 className="type-display text-lg font-bold text-fg mb-1">
              Active Agent Directory (15 Agents, 42 Tools)
            </h2>
            <p className="text-xs text-dim mb-4">
              All tools are strictly confined to their parent agent's capability screen and cannot be invoked cross-boundary.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono">
              {[
                { name: "Orchestrator", count: "1 tool", role: "All Roles", desc: "Coordinates subtask breakdown and parallel DAG dispatch." },
                { name: "Research", count: "2 tools", role: "Public / Student / Staff", desc: "ArXiv paper retrieval and DuckDuckGo web search." },
                { name: "File", count: "4 tools", role: "Student / Staff", desc: "Sandbox filesystem reading, writing, and searching." },
                { name: "Calendar", count: "3 tools", role: "Student / Staff", desc: "Local timetable and meeting event scheduling." },
                { name: "Scheduler", count: "3 tools", role: "Student / Staff", desc: "Autonomous cron schedules and background tasks." },
                { name: "Therapy", count: "2 tools", role: "Student / Staff", desc: "Conversational well-being, strictly excluded by Rule 0." },
                { name: "News", count: "2 tools", role: "Student / Staff", desc: "Current events and verified headline syndication." },
                { name: "Browser", count: "4 tools", role: "Student / Staff", desc: "Read-only web scraping and screened page extraction." },
                { name: "Market", count: "4 tools", role: "Student / Staff", desc: "Financial ticker quotes and local paper trading." },
                { name: "Shopper", count: "4 tools", role: "Staff Only", desc: "Product comparison; checkout handoff gated by HALO." },
                { name: "Email", count: "4 tools", role: "Staff Only", desc: "IMAP/SMTP messaging with HALO pre-send confirmation." },
                { name: "Telecom (SMS)", count: "3 tools", role: "Staff Only", desc: "Twilio SMS messaging with HALO confirmation." },
                { name: "GitHub", count: "3 tools", role: "Staff Only", desc: "Repository summaries, issues, and commit analysis." },
                { name: "Social", count: "2 tools", role: "Staff Only", desc: "Social media drafts requiring explicit operator sign-off." },
                { name: "Chain", count: "3 tools", role: "Staff Only", desc: "Solana unsigned transaction construction (keys never stored)." },
              ].map((a) => (
                <div key={a.name} className="border border-hairline rounded bg-void p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-fg">{a.name} Agent</span>
                    <span className="text-[10px] text-muted">{a.count}</span>
                  </div>
                  <span className="inline-block mt-1 text-[10px] px-1.5 py-0.5 rounded bg-elevated border border-hairline text-dim">
                    {a.role}
                  </span>
                  <p className="text-xs text-dim mt-2 leading-relaxed font-sans">
                    {a.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section === "security" && (
        <div className="space-y-6">
          <div className="rounded-lg border-2 border-hairline bg-elevated p-5">
            <h2 className="type-display text-lg font-bold text-fg mb-1">
              Deterministic Security Contracts (.conca)
            </h2>
            <p className="text-xs text-dim mb-4 leading-relaxed">
              Traditional frameworks rely on system prompts (e.g. <em>"Please do not delete files or execute arbitrary shell commands"</em>). Research by Kim et al. (2026) demonstrates that LLM verifiers exhibit a <strong>49.4% false-acceptance rate</strong> when evaluating adversarial commands. Concaretti removes the model from the security verification loop entirely.
            </p>

            <div className="space-y-3 font-mono text-xs">
              <div className="p-3 bg-void border border-hairline rounded">
                <span className="text-accent font-bold">1. Pre-Execution DAG Filtering</span>
                <p className="font-sans text-xs text-dim mt-1">
                  When the orchestrator generates a parallel subtask execution DAG, each node is screened against <code className="text-xs">.conca</code>. If an agent is disabled or not granted to the caller's role, the node is pruned before worker allocation.
                </p>
              </div>

              <div className="p-3 bg-void border border-hairline rounded">
                <span className="text-accent font-bold">2. Nine-Strategy Shell Normalizer</span>
                <p className="font-sans text-xs text-dim mt-1">
                  Adversarial attacks using hex encoding, octal encoding, ANSI-C quotes, base64 wrapping, alias chaining, variable expansion, or relative path traversal are recursively unnested into canonical syntax prior to evaluation.
                </p>
              </div>

              <div className="p-3 bg-void border border-hairline rounded">
                <span className="text-accent font-bold">3. Zero-Knowledge Financial Boundary</span>
                <p className="font-sans text-xs text-dim mt-1">
                  Cardholder details (PAN / CVC) and cryptocurrency private keys never touch disks, databases, or third-party LLM providers. PAN check-digits are validated in volatile memory with single-use references.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
