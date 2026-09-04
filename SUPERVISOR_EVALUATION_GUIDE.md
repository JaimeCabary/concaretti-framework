# CONCARETTI: SUPERVISOR & EVALUATION GUIDE

**Project Title:** CONCARETTI: A FAULT-TOLERANT MULTI-AGENT ORCHESTRATION ARCHITECTURAL FRAMEWORK WITH DECLARATIVE EXECUTION AUTHORITY  
**Short Title:** Concaretti: Declarative Execution Authority for Multi-Agent AI  
**Principal Investigator:** Shalom Ebere Chidi-Azuwike (Reg No: 20211280502)  
**Supervisors / Co-Authors:** Engr. Dr. Mrs. F.O. Elei, Engr. Dr. Azubuike Izuchukwu Erike, Dr. Okoronkwo Chinomso D., Prof. Charles O. Ikerionwu, Dr. Ikenna Caesar Nwandu, Dr. Abraham Ovwonuri  
**Department:** Software Engineering, School of Information and Communication Technology (SICT)  
**Institution:** Federal University of Technology Owerri (FUTO), P.M.B. 1526, Owerri, Imo State, Nigeria  
**Corresponding Email:** chidi-azuwikeshalom.20211280502@futo.edu.ng  

---

## 1. Executive Summary

This repository contains the complete implementation and empirical verification suite for the **Concaretti** multi-agent orchestration framework.

Concaretti decouples execution authority from stochastic Large Language Model (LLM) reasoning into an inspectable, declarative policy contract (`backend/.conca`). All tool invocations are filtered deterministically *before* tool execution. The runtime features a **4-tier memory system** with **Rule 0** semantic privacy filtering, **HALO** (Human-Agent Loop Oversight) approval gates for irreversible actions, and a **9-strategy Shell Normalizer** to neutralize adversarial obfuscation.

---

## 2. Invariant Verification & Paper Metrics (Table 5 & 6)

### All 159 Invariant Tests Pass (100% Pass Rate)

The invariant test suite corresponds **1:1** to the metrics published in **Table 6** of the paper:

| Test ID | Control Surface | Invariants | Status |
| :--- | :--- | :---: | :---: |
| **T-01** | Gate declaration integrity | 16 | **PASS (16/16)** |
| **T-02** | Gate reachability, offline planning | 10 | **PASS (10/10)** |
| **T-03** | Secret material at prompt ingress | 13 | **PASS (13/13)** |
| **T-04** | Filesystem authority & sandbox bounds | 13 | **PASS (13/13)** |
| **T-05** | Shell obfuscation (9 de-obfuscation strategies) | 24 | **PASS (24/24)** |
| **T-06** | SSRF & blocked cloud metadata/loopback | 10 | **PASS (10/10)** |
| **T-07** | Rule 0 privacy boundary (exclusion from vector DB) | 20 | **PASS (20/20)** |
| **T-08** | Cardholder data (PAN/CVC never touches disk) | 8 | **PASS (8/8)** |
| **T-09** | Screen capture authority (explicit staff permission) | 20 | **PASS (20/20)** |
| **T-10** | Role & capability authority floors | 11 | **PASS (11/11)** |
| **T-11** | Interface conformance & Hikari tier integrity | 14 | **PASS (14/14)** |
| **TOTAL** | **11 Control Surfaces** | **159** | **159 / 159 PASS** |

### How to Run the Invariant Tests:
- **Option A (1-Click):** Double-click `RUN_INVARIANT_TESTS.bat`.
- **Option B (CLI):** Run in terminal:
  ```bash
  uv run --project backend pytest -v
  ```

---

## 3. Running the Desktop Application

### Option A: 1-Click Desktop Launcher
Double-click `START_CONCARETTI.bat` in this folder. It will:
1. Initialize the FastAPI backend on `127.0.0.1:8000`.
2. Load the operator profile (`user_profile.json`).
3. Open Concaretti in a native Windows desktop window (via PyWebView / WebView2) with persistent storage.

### Option B: Manual CLI Run
```bash
uv run --project backend python run_desktop.py
```

---

## 4. Key Demonstrations for Evaluation

### A. Live Policy Defense (.conca)
1. In the app, open the **.conca Rules** tab.
2. In the **Simulator** input box, enter an obfuscated command:
   ```bash
   \x72\x6d -rf /
   ```
3. Observe how the 9-strategy Shell Normalizer decodes the command to `rm -rf /` and refuses it deterministically without delegating the judgment to an LLM.

### B. HALO Human-in-the-Loop Oversight Gate
1. Submit an irreversible action (e.g. asking to send an email or initiate an order checkout).
2. The orchestrator halts execution at the HALO gate and presents a modal prompt for operator confirmation.
3. If unanswered or rejected, the operation fails closed.

### C. Rule 0 Semantic Privacy Isolation
1. Submit a prompt containing sensitive credentials (e.g., credit card number or private seed phrase).
2. The ingestion screener intercepts the turn; the data is excluded from vector index embeddings and cannot be leaked into subsequent sessions.

### D. Native Documentation Tab
1. Click **Documentation** in the sidebar footer to view the interactive thesis architecture and agent directory inside the application itself.

---

## 5. Repository Structure

```
New Concaretti/
├── START_CONCARETTI.bat       # 1-click Windows desktop application launcher
├── RUN_INVARIANT_TESTS.bat    # 1-click test suite verification runner (159 tests)
├── SUPERVISOR_EVALUATION_GUIDE.md  # This document
├── user_profile.json          # Persistent operator profile
├── run_desktop.py             # Desktop shell launcher with WebView2 persistence
├── backend/
│   ├── .conca                 # Master declarative execution authority contract
│   ├── main.py                # Single-process FastAPI orchestrator and API routes
│   ├── agents.py              # Central DAG dispatch & 15 domain agents
│   ├── tools.py               # 42 registered tool implementations
│   ├── security.py            # Normalizer & declarative policy enforcement
│   ├── memory.py              # 4-tier memory engine (SQLite + sqlite-vec)
│   └── tests/                 # 159 invariant test implementations
└── frontend/                  # React + TypeScript + Tailwind-free Blueprint UI
    ├── src/components/        # UI panels (Council, Cockpit, .conca, Docs, Calendar)
    └── dist/                  # Production-compiled static assets
```
