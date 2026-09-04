# conca

An agent runtime where capability is granted by a file a human can read, and the
actions that cannot be undone stop for a person.

```python
from conca import load_policy, requires_halo, check_conformance

policy = load_policy(".conca")
requires_halo(policy, "send_email")   # True  — irreversible
requires_halo(policy, "web_search")   # False — a read
check_conformance(policy)             # [] — the policy and the executor agree
```

---

## The problem this is about

An agent that hallucinates a sentence produces a bad sentence. An agent that
hallucinates an *action* deletes a repository, sends the wrong invoice, or moves
money. The industry's answer has largely been to write the safety rules into the
system prompt and hope — which is *safety by politeness*, and it fails to the
first prompt injection that outranks it, because you cannot firewall a
probability distribution.

`conca` puts the boundary somewhere a model cannot reach: a deterministic
function, over a declarative file, evaluated after the model has produced a plan
and before any tool is entered.

```
prompt ──► plan (LLM) ──► screen (.conca, no model) ──► gate (human) ──► execute ──► remember
                              │                            │
                         refuses here                  suspends here
```

## The contract

**1. Capability is declared, not prompted.** `.conca` is YAML. It lists every
agent with a global kill-switch, scopes each role to a subset of those agents,
deny-lists paths, allow-lists paths, and sets scalar rules. Nothing grants itself.
Revoking a capability is an edit to one line, reviewable by someone who was not
in the room when the agent ran.

**2. The screen contains no model.** `security.py` is pure functions. Path
checks, a nine-strategy shell normalizer that unwraps hex, octal, ANSI-C quoting,
base64 pipelines, quote concatenation, variable expansion and multi-hop alias
indirection before comparison, and a URL check that refuses loopback, RFC-1918
ranges and cloud instance-metadata endpoints *regardless of what the policy says*.
That last exception is deliberate: an SSRF against `169.254.169.254` hands over the
host's credentials, and no legitimate operator edit should be able to permit it.

**3. Order is part of the contract.** Deny-list before allow-list, so naming a
home directory as permitted does not readmit `~/.ssh` beneath it. Role grants
intersect with global switches, never union, so a role list can only ever narrow.
Reversing either is a silent bug, so both are tests.

**4. Irreversible actions suspend.** Twelve task types reach a human:
`send_email`, `send_sms`, `make_call`, `social_post`, `project_create`,
`python_execute`, `write_file`, `delete_event`, `browser_act`, `shop_checkout`,
`chain_prepare_tx`, `screen_capture`. The gate asks a model for *contextual
options* rather than yes/no, and can inject a helper agent on conditional
approval. Timeout, malformed response and lost connection are all **rejected**.

**5. Flags add, never subtract.** `confirm_before_send_email: false` does not
ungate sending — trigger-set membership is the floor. The same asymmetry holds for
privacy: the content check and the provenance check are OR-ed, so a
`sensitive=False` assertion over distressed text does nothing.

**6. Secrets travel as handles.** No secret is ever a tool argument. Card details
live in a RAM-only jar under an opaque reference, 180-second TTL, single read,
Luhn-validated, never logged or embedded, with screenshots suppressed for the
card-entry step because an image of a filled field is the same leak by another
route. Screen captures use the same discipline for the inverse reason: the pixels
*must* reach a vision model, so the handle protects every other path the bytes
would take.

**7. Privacy has two doors.** Rule 0 keeps emotionally sensitive turns out of the
semantic index — by content (five pattern families) *or* by provenance (where the
turn came from). Provenance is necessary because a content classifier cannot see
what is wrong with a screenshot description: "the invoice shows £4,000 owed to
Ashworth Ltd" matches no distress vocabulary and is precisely the sentence that
must not become a retrievable row. Exclusion is enforced at write and again at
read. The audit log stores a SHA-256 hash of the payload rather than the payload,
so an excluded turn is provably present and permanently unreadable.

---

## `check_conformance` — why it is public API

`HALO_TRIGGERS` compares action names by exact string membership. In this
codebase it once contained `file_write`, `file_delete`, `script_execute`,
`deploy_to_vercel` and `git_commit_push`. The registered tool that writes files
is `write_file`.

So `requires_halo(policy, "write_file")` returned `False`. Every file write ran
ungated. The policy file read as though writes were gated. `write_file`'s own
docstring claimed it was "reached only after HALO approval." Nothing errored,
nothing logged a missing gate, and the test written to verify it asserted on the
same wrong names and passed through several revisions.

Five gates gated nothing. A sixth named a capability that did not exist yet.

**A declarative permission layer that names actions as strings is void whenever a
string is wrong, and it fails in the direction of permitting.** A misspelled
firewall rule drops traffic and someone notices in a minute. A misspelled gate
name is invisible, because "no gate configured" and "gate configured for a name
nothing emits" are behaviourally identical. Prose review does not catch it: a
reviewer reading `file_write` beside a `write_file` tool pattern-matches them as
the same thing.

Hence:

```python
def test_policy_and_registry_agree():
    assert check_conformance(load_policy(".conca")) == []
```

It detects three classes of drift — a gate no tool emits, a provenance exclusion
no tool emits, and a tool whose agent the policy never declares (its kill switch
does not exist as a line anyone can find).

**What it does not do**, stated because the limit matters: it does not prove the
gated set is the *right* set. A tool registered with an ungated task type passes
every check and is exactly as dangerous as the ungated `write_file` was. Whether
an action is irreversible is a human judgement made when the tool is written.
This makes the failure of an *intended* gate detectable; it does not make the
absence of an unconsidered one detectable.

---

## Memory

Four tiers. Three in one SQLite file, one in a text editor.

| Tier | Where | Why |
|---|---|---|
| Durable | SQLite tables — sessions, transcripts, audit, artifacts, orders | The record |
| Semantic | `vec0` virtual table, 768-dim, cosine | Cross-session recall |
| Working | In-session transcript, compressed above ~10k tokens | Long sessions |
| **Operator** | `OPERATOR.md`, re-read on mtime change | The only tier a human edits |

The operator tier is after [Naomi Carrigan's Hikari][hikari], whose memory is a
single always-on markdown file. The design point is auditability: an embedding is
not reviewable by inspection and a text file is. It is never embedded and never
becomes a transcript row, so nothing in it can return as a recall result — it is
context, not history. It is also sent verbatim to whichever provider the ladder
picks, which is why `OPERATOR.md` says so in its own header instead of trusting that
this table gets read.

[hikari]: https://nhcarrigan.com

## Availability

47 ladder slots, 45 distinct models, 14 providers, walked top-down with
fall-through on error, terminating in a deterministic stub so a total outage
degrades rather than crashes. `inventory()` reports reachable-over-total live
(33/47 on the reference deployment) rather than advertising capacity it cannot
reach. When no vision-capable model is available, the capture path returns the
sentence *"the screen was not read"* — never a plausible description. An agentic
system that degrades quietly is worse than one that stops.

## Identity

No password, no PIN, no login. The staff role is granted to callers arriving on
the loopback interface; everyone else gets a configurable public role.
`X-Forwarded-For` is **ignored, not parsed** — it is set by the caller, and
parsing it would convert the one unforgeable fact in the request into an
assertion. A cookie can step a session *down* to a narrower role and is therefore
checked first, but cannot step one up. Credential setup, login and screen capture
additionally require loopback whatever the role.

---

## Introspection

```python
import conca

conca.inventory()          # counted facts, measured at call time
conca.gated_actions()      # the twelve
conca.capabilities()       # agent -> task types it owns
conca.check_conformance(p) # [] when the boundary is coherent
```

`inventory()` measures rather than reports, because a number written into a
document drifts from the code and a number derived from the code cannot.

## Status

127 tests, 1,061 lines, under 9 seconds. Verified by execution: policy loading,
role narrowing, all nine normalizer strategies individually, deny-before-allow
ordering, traversal collapse, card-jar TTL and single-use, PAN absence from the
database file *and* its write-ahead log, key and seed refusal without logging,
`check_url` against loopback and both metadata hosts, Rule-0 exclusion at write
and read, and the three conformance assertions.

Not verified in the reference environment: any live provider call (outbound TLS is
intercepted), the Rust desktop overlay (`cargo build` has not run), the browser
agent against live merchants, and telephony delivery.

`conca` is a facade — every symbol is re-exported from the module that implements
it. Importing it moves no code and breaks no existing import.
