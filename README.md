# CONCARETTI: A Fault-Tolerant Multi-Agent Orchestration Architectural Framework with Declarative Execution Authority

[![Tests: 159/159 Passed](https://img.shields.io/badge/Invariants-159%2F159%20Passing-emerald?style=flat-square)](https://github.com/JaimeCabary/concaretti-framework)
[![Architecture: Single-Process](https://img.shields.io/badge/Architecture-Single--Process%20FastAPI-blue?style=flat-square)](https://github.com/JaimeCabary/concaretti-framework)
[![Memory: 4-Tier + Rule 0](https://img.shields.io/badge/Memory-4--Tier%20%2B%20Rule%200-purple?style=flat-square)](https://github.com/JaimeCabary/concaretti-framework)
[![License: MIT](https://img.shields.io/badge/License-MIT-gray?style=flat-square)](LICENSE)

**Short Title:** *Concaretti: Declarative Execution Authority for Multi-Agent AI*  
**Principal Investigator & Corresponding Author:** Shalom Ebere Chidi-Azuwike (`20211280502`) — [chidi-azuwikeshalom.20211280502@futo.edu.ng](mailto:chidi-azuwikeshalom.20211280502@futo.edu.ng)  
**Supervisors & Co-Authors:** Engr. Dr. Mrs. F.O. Elei, Engr. Dr. Azubuike Izuchukwu Erike, Dr. Okoronkwo Chinomso D., Prof. Charles O. Ikerionwu, Dr. Ikenna Caesar Nwandu, Dr. Abraham Ovwonuri  
**Institution:** Department of Software Engineering, School of Information and Communication Technology (SICT), Federal University of Technology Owerri (FUTO), P.M.B. 1526, Owerri, Imo State, Nigeria  

---

## 1. Research Overview & Motivation

The rapid transition of Agentic Artificial Intelligence from isolated reasoning loops to autonomous multi-agent swarms operating at the operating-system level has revealed severe architectural and security vulnerabilities:

1. **Privilege Escalation during Task Delegation:** Complex workflows routinely delegate tasks across sub-agents without strict boundaries, resulting in catastrophic capability creep.
2. **The 49.4% Failure Rate of LLM Self-Verification:** As demonstrated by Kim et al. (2026), employing large language models as their own security verifiers yields an unacceptably high verifier false-acceptance rate (49.4%) against adversarial inputs.
3. **Cross-Session Amnesia vs. Privacy Leakage:** Standard retrieval systems either forget critical operational context across restarts or indiscriminately vectorize sensitive data (e.g. credit card PANs, mnemonic seed phrases, personal therapy sessions), leaking them into future model prompts.

**Concaretti** resolves these systemic vulnerabilities through **declarative execution authority**. In Concaretti, authority is entirely decoupled from stochastic LLM reasoning into an inspectable, human-readable declarative policy contract (`.conca`). Stochastic model plans are screened deterministically *after* planning but *before* any tool executes.

---

## 2. Core Architectural Contributions

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 OPERATOR COMMAND / UI                   │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │          CENTRAL ORCHESTRATOR & DAG PLANNER             │
                  │   Stochastic LLM proposes subtasks & parallel DAG       │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               ▼
        ═════════════════════════════════════════════════════════════════════════
          DETERMINISTIC SECURITY BOUNDARY (.conca declarative policy contract)
          • Nine-Strategy Shell Normalizer (de-obfuscates hex/octal/base64)
          • Role Capability Floor Enforcer (Public / Student / Staff)
          • Destination & SSRF Filter (Blocks loopback, link-local metadata)
          • Zero-Knowledge Financial Boundary (Cardholder/Wallet data)
        ═════════════════════════════════════════════════════════════════════════
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         │                                           │
                 [Read-Only Action]                         [Irreversible Action]
                         │                                           │
                         ▼                                           ▼
              ┌─────────────────────┐                     ┌─────────────────────┐
              │   DIRECT DISPATCH   │                     │      HALO GATE      │
              │  Research, Calendar,│                     │ Human-Agent Loop    │
              │  Browser Read, etc. │                     │ Oversight Approval  │
              └──────────┬──────────┘                     └──────────┬──────────┘
                         │                                           │ (Approved)
                         └─────────────────────┬─────────────────────┘
                                               │
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │              EXECUTION & 4-TIER MEMORY ENGINE           │
                  │  1. Durable SQLite  │  2. Rolling Session Transcript    │
                  │  3. Vector (Rule 0) │  4. Human-Authored Hikari Tier    │
                  └─────────────────────────────────────────────────────────┘
```

### Key Innovations:
- **Declarative Policy Contract (`backend/.conca`):** An auditable YAML specification governing allowed paths, blocked network destinations, and agent kill-switches. Changes take effect on the next dispatch without requiring server recompilation or restarts.
- **Nine-Strategy Shell Normalizer:** Neutralizes obfuscated terminal injections (including ANSI-C decoding, base64 wrapping, alias resolution, adjacent quote concatenation, and relative path traversal) before evaluating deny-lists.
- **Human-Agent Loop Oversight (HALO):** Irreversible task types (e.g., email transmission, SMS broadcast, paper trading, unsigned blockchain transactions) automatically halt at fail-closed approval gates with real-time countdown timers.
- **Four-Tier Memory with Rule 0 Privacy:** Integrates relational tables, raw chronological transcripts, vector semantic search (`sqlite-vec`), and operator prose (Hikari). **Rule 0** deterministically prevents sensitive credentials and therapeutic conversations from ever being indexed into embedding stores.

---

## 3. Empirical Results & Formal Invariants

The runtime was systematically evaluated across **11 distinct control surfaces** using an automated verification suite comprising **159 executable invariant claims**. All 159 invariants pass with a 100% success rate on the current build:

### Table 1: Invariant Verification Matrix (Paper Table 6)

| Surface ID | Control Surface Evaluated | Invariant Tests | Pre-Fix Baseline | Verified Status |
| :---: | :--- | :---: | :--- | :---: |
| **T-01** | Gate declaration integrity | **16** | 5 of 12 triggers named absent task types | **PASS (16/16)** |
| **T-02** | Gate reachability in offline planning | **10** | Only 3 of 12 triggers reachable (25%) | **PASS (10/10)** |
| **T-03** | Secret material at prompt ingress | **13** | Seed phrase recovered from WAL journal | **PASS (13/13)** |
| **T-04** | Filesystem authority & sandbox bounds | **13** | Evaluated directory traversal attacks | **PASS (13/13)** |
| **T-05** | Shell obfuscation (9 de-obfuscation rules) | **24** | Evaluated 8 hostile shell attack variants | **PASS (24/24)** |
| **T-06** | SSRF & link-local metadata protection | **10** | Evaluated loopback, ::1, link-local metadata | **PASS (10/10)** |
| **T-07** | Rule 0 privacy boundary (vector exclusion)| **20** | Sensitive sessions excluded from embeddings | **PASS (20/20)** |
| **T-08** | Cardholder data (PAN/CVC leak resistance)| **8** | PAN verified absent from disk and WAL | **PASS (8/8)** |
| **T-09** | Screen capture authority & handle recovery| **20** | Enforced staff-only explicit grants | **PASS (20/20)** |
| **T-10** | Role & capability authority floors | **11** | Prevented escalation beyond global switch | **PASS (11/11)** |
| **T-11** | Interface conformance & inventory | **14** | Complete mediation across all 42 tools | **PASS (14/14)** |
| **TOTAL** | **11 Security Control Surfaces** | **159** | **Suite Runtime: ~6.7s** | **159 / 159 PASS** |

### Table 2: Architectural Optimization Metrics (Paper Table 5)

| Metric / Dimension | Initial Microservices Stack | Rebuilt Concaretti Runtime | Measured Improvement |
| :--- | :---: | :---: | :---: |
| **Active Processes to Start** | 20 separate containers | **1 single process** | **−95% reduction** |
| **External Dependencies** | 3 (Redis, PostgreSQL, Browserless) | **0 external dependencies** | **Eliminated completely** |
| **Policy Endpoint Latency** | — | **12 ms** | **Sub-millisecond query path** |
| **Persistent Storage Footprint** | Distributed cluster | **3.36 MB single SQLite file** | **Zero-overhead local storage** |
| **Active Capability Surface** | Unbounded swarm delegation | **15 agents / 42 strictly scoped tools** | **Fully inspectable boundary** |

---

## 4. Evaluation Guide for Supervisors & External Examiners

This repository has been structured for immediate, independent verification by academic supervisors and external examiners.

### 4.1 Running the Invariant Verification Suite (159 Tests)
- **Windows (1-Click):** Double-click `RUN_INVARIANT_TESTS.bat`.
- **Command Line:**
  ```bash
  uv run --project backend pytest -v
  ```
*Expected Result:* **159 passed in ~6.7 seconds (0 failures)**.

### 4.2 Launching the Native Desktop Application
- **Windows (1-Click):** Double-click `START_CONCARETTI.bat`.
- **Command Line:**
  ```bash
  uv run --project backend python run_desktop.py
  ```
The launcher initializes the in-process FastAPI backend on `127.0.0.1:8000`, loads the operator identity from `user_profile.json`, and opens the native Windows desktop application shell with persistent storage.

### 4.3 Navigating Key Interactive Demonstrations
1. **The In-App Documentation Hub:** Click **Documentation** in the sidebar footer to access an interactive reference mapping system components directly to the thesis manuscript.
2. **Live Security Policy Defense (`.conca Rules`):**
   - Navigate to the **.conca Rules** tab.
   - Under the *Simulator* box, submit an obfuscated injection command:
     ```bash
     \x72\x6d -rf /
     ```
   - Observe how the 9-stage normalizer simplifies the payload to `rm -rf /`, identifies the deny-list rule, and outputs a deterministic refusal before any model sees it.
3. **Human-Agent Loop Oversight (HALO Gate):**
   - In the Council Cockpit or Email Agent, trigger an irreversible outbound action.
   - Observe the orchestrator automatically suspend execution and route the request to the fail-closed HALO gate, presenting the operator with approval options before any external dispatch occurs.
4. **Rule 0 Privacy Boundary & Memory Isolation:**
   - In the Council Cockpit, observe that sensitive personal or therapeutic context is strictly partitioned: while stored in the chronological session log for conversational coherence, **Rule 0** deterministically prevents it from ever being indexed into persistent vector embeddings.

---

## 5. Repository Structure

```
concaretti-framework/
├── START_CONCARETTI.bat             # 1-click Windows native desktop launcher
├── RUN_INVARIANT_TESTS.bat          # 1-click verification runner (159 invariant tests)
├── SUPERVISOR_EVALUATION_GUIDE.md   # Step-by-step examination and testing manual
├── user_profile.json                # Local persistent operator configuration
├── run_desktop.py                   # PyWebView native desktop window runner
│
├── backend/                         # Single-process Python 3.12+ FastAPI backend
│   ├── .conca                       # Master declarative execution authority policy
│   ├── main.py                      # REST/SSE orchestrator and static asset server
│   ├── agents.py                    # DAG scheduler & 15 specialized domain agents
│   ├── tools.py                     # 42 registered tool implementations
│   ├── security.py                  # Policy parser & 9-strategy shell normalizer
│   ├── memory.py                    # 4-tier memory engine (SQLite + sqlite-vec)
│   ├── halo.py                      # Human-in-the-loop oversight gate manager
│   └── tests/                       # 159 executable invariant test cases
│       ├── test_invariants.py       # Cross-module invariants & disk leak tests
│       ├── test_security.py         # Shell normalizer & policy enforcement tests
│       └── test_facade.py           # DAG planning & orchestration facade tests
│
└── frontend/                        # React + TypeScript UI (Tailwind-free Blueprint design)
    ├── src/
    │   ├── components/              # Blueprint panels (CouncilCockpit, DocsPanel, etc.)
    │   ├── screens/                 # Role views (PublicScreen, StudentScreen, StaffScreen)
    │   ├── store/agentStore.ts      # Zustand state store with real-time SSE reducer
    │   └── lib/api.ts               # Type-safe API client wrapper
    └── dist/                        # Production-compiled client bundle
```

---

## 6. Academic Declaration & Attribution

This software repository and its accompanying research manuscript were developed within the **Department of Software Engineering, School of Information and Communication Technology (SICT), Federal University of Technology Owerri (FUTO)**.

All empirical data, invariant test assertions, and architectural benchmarks reported in the manuscript are fully reproducible from the code contained in this repository.

For academic inquiries or replication details:
- **Author:** Shalom Ebere Chidi-Azuwike (`chidi-azuwikeshalom.20211280502@futo.edu.ng`)
- **Institution:** Federal University of Technology Owerri, P.M.B. 1526, Owerri, Imo State, Nigeria
