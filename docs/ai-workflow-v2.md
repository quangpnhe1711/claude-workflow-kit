# AI Workflow V2 — spec to implementation

The V2 specification ("Mission Control & Adaptive Workflow Engine") describes an
agent that classifies work, plans before acting, collects evidence, tracks
confidence and risk, stops at human checkpoints, and reports on a Mission Board.

This file records, per spec section, **where that behaviour actually lives** and
how strongly it holds. Three strengths:

| Strength | Meaning |
| --- | --- |
| **enforced** | code refuses the wrong behaviour; a skill cannot talk its way past it |
| **derived** | code computes the requirement, so it cannot drift per task |
| **instructed** | prose in `CLAUDE.md` or a skill; the model can still ignore it |

> **Status (2026-08-31): historical, and partly superseded.** The V2 spec asked
> for an agent that classifies every task before acting. That turned out to cost
> latency on ordinary work without improving the result, so the `senior-dev`
> preset no longer does it — see the capability architecture note in
> `docs/architecture.md` and decisions D42-D47. Every row below marked
> **enforced** or **derived** is still true: the router, thresholds, checkpoints,
> monitors and board are runtime code and still behave exactly as described, and
> are what a project gets when it drives a multi-phase topology deliberately.
> The rows marked **instructed** described preset prose that no longer exists —
> `skills/work`, the Mission Header, the `wf-*` phase skills — and are the part
> that was replaced.

## Section map

| Spec | Implementation | Strength |
| --- | --- | --- |
| §0-§1 Role, goals | `skills/work` (router + Mission Header), `claude-md.md` "Mission Control" | instructed |
| §2.1 Planner first | `work` publishes the header before task work; `cw mission classify` / `plan` record it | instructed |
| §2.2 Adaptive workflow | `routeMission()` in `mission.ts`; five classes over the five existing topologies | derived |
| §2.3 Evidence before decision | `EvidenceStatus` per area; `MISSING`/`CONFLICTING`/`OUTDATED` deny writes and block implementation | enforced |
| §2.4 Human control | `cw checkpoint resolve`, `cw mission pause/resume/cancel`, board actions; silence is never approval | enforced |
| §2.5 Minimum necessary work | class-scaled validation strategy and confidence floors; Lightning owes two numbers, not six | derived |
| §3 Workflow state machine | `MissionState` + `NEXT_STATES`; illegal jumps refused, `--force` recorded as forced | enforced |
| §4 Workflow router | `cw mission route` / `classify`; prints class, topology, checkpoints, validation, thresholds, template | derived |
| §5 Complexity | `Complexity` floor table (`COMPLEXITY_CLASS`) | derived |
| §6 Workflow library | `topologyFor()`: Lightning/Fast → `quick-fix`, Standard → `standard-change`, Deep → `bug-fix`/`feature-change`, Research → `solution-analysis` | derived |
| §7 Execution Plan contract | `cw mission plan` (objective, scope, out-of-scope, assumptions, dependencies, stop conditions, success criteria); `templates/execution-plan.md` | enforced (objective + scope required) |
| §8 Dynamic task breakdown | `cw mission task add/<id> <status>`; a task added after the plan is refused without `--reason` | enforced |
| §9 Mission Board schema | `buildMissionBoard()` → `cw board`, `/api/runs/:id` `board`, the monitor's right panel | derived |
| §10 Interactive board | `POST /api/runs/:id/actions` (approve, reject, modify, request-evidence, pause, resume, cancel, accept-risk, return/add-to-scope, skip task) | enforced |
| §11 Checkpoint policy | `requiredCheckpoints()`; pending or never-opened blocking checkpoints deny repository mutation | enforced |
| §12 Decision contract | `cw mission decision` (reason, evidence, alternatives, rejected, impact, risk, reversibility); `templates/decision-record.md` | enforced (decision + reason required) |
| §13 Evidence contract | `cw mission evidence`; phase gate + mutation policy | enforced |
| §14 Confidence monitor | `cw mission confidence`; `confidenceThresholds()` per class, +75% root cause for defects, +80% for permission/security | enforced at the implementation phase |
| §15 Risk monitor | `cw mission risk`; `peakLevel` never rewritten; `RISK_ESCALATED` event; CRITICAL blocks implementation | enforced |
| §16 Off-track monitor | `cw mission offtrack`; health drops to `NEEDS_ATTENTION`; board offers return/add-to-scope | instructed + derived health |
| §17 Context monitor | `cw mission context --degraded --summary …` | instructed |
| §18 Timeline | `events.jsonl` + the monitor's per-phase activity list; mission events are typed (`MISSION_*`, `CHECKPOINT_*`, `RISK_*`, `DECISION_RECORDED`, …) | enforced |
| §19 Validation strategy | `validationStrategy()` per class, plus only the risk-specific steps the flags justify; `skippedValidation()` names what was dropped | derived |
| §20 Manual test policy | unchanged from V1 (`wf-validation-e2e`, quick-fix guidance): manual verification is a valid completion state | instructed |
| §21 Output template library | `outputTemplateFor()` + the preset's template files; `cw mission template` | derived |
| §22 Deliverables contract | `cw mission deliverable`; `cw run complete` refuses while a required one is not `DONE` | enforced |
| §23 Estimated effort | `RouteResult.effort` (`VERY_SMALL`..`VERY_LARGE`), stated as engineering size | derived |
| §24 Health monitor | `missionHealthReport()`: `HEALTHY` → `NEEDS_ATTENTION` → `AT_RISK` → `BLOCKED` → `CRITICAL` with reasons | derived |
| §25 Gate system | V1 hard gates (`BUSINESS_READY`, `ROOT_CAUSE_READY`) + `implementationReadiness()` + `missionCompletionBlockers()` | enforced |
| §26 Error/failure handling | V1 `run fail` / `phase fail` / `gate fail`, `FAILED` settles every live node | enforced |
| §27 Scope change policy | `cw mission scope --previous --new --reason`; plan scope is rewritten and the change recorded | enforced (reason required) |
| §28 Workflow upgrade/downgrade | `cw run escalate` (V1) and `cw mission classify`, which escalates in place and carries the mission across | enforced (upgrade only) |
| §29 Performance rules | prose in `claude-md.md` and the body skills; `cw mission action` keeps the board honest about what is being read | instructed |
| §30 Initial response contract | the Mission Header block in `skills/work` | instructed |
| §31 Execution update contract | `wf-mission-board`: emit on real change only, never narrate routine work | instructed |
| §32 Final delivery contract | `claude-md.md` "Final response" + `cw run complete` verification | enforced (mechanical half) |
| §33 Anti over-engineering | `claude-md.md` scope discipline; abstraction must show repeated use, benefit, cost, alternative | instructed |
| §34 System protection | V1 mutation policy: no writes behind a gate/checkpoint, read-only command allowlist, no interpreters, audited overrides | enforced |
| §35-§38 Operating sequence | `work` → body skill → `wf-mission-board` / `wf-checkpoint` → `wf-final-report` | instructed |

## Deliberate differences from the spec

1. **Five classes, five existing topologies.** V2 names five workflows; the kit
   already had five graphs that match them. Adding new YAML would have duplicated
   `quick-fix` and `standard-change` under new names, so the classes map onto the
   existing topologies instead. `cw board` shows both (`STANDARD via standard-change`).

2. **Confidence gates the implementation phase, not every write.** The spec says
   coding may not start below threshold. Making the mutation policy enforce a
   *number* would fire before the mission had any chance to assess it, and would
   turn every unassessed dimension into a dead session. Facts (paused, open
   checkpoint, evidence declared unusable) block writes; judgments block the phase.

3. **`RELEASE` checkpoints do not block writes.** A release decision gates the
   release step. Blocking mutation on it would stop the run writing its own release
   note and rollback guide.

4. **`CODE` checkpoints are not "owed" before implementation.** A code review
   checkpoint is answered after code exists; requiring it earlier would deadlock.
   It is still mandatory for large features, refactors, permission and security
   work, and it blocks further writes once pending.

5. **Confidence floors scale with workflow class.** The spec lists one threshold
   table. Applied literally, a label change would owe six defended percentages —
   exactly the ceremony §2.5 forbids. Lightning owes `requirement` and `scope`;
   Deep owes all of them, raised for permission and security work.

6. **Mission state follows the phase.** The spec has the agent emit state
   transitions. The runtime derives them from phase entry (except while a
   checkpoint is pending) so the board cannot silently fall behind, and reports
   drift when a forced state contradicts the topology.

7. **"Proceed Anyway" cannot open a hard gate.** `cw mission accept-risk` waives
   mission blockers with a recorded reason. `BUSINESS_READY` and
   `ROOT_CAUSE_READY` still need their evidence artifact, or the separate audited
   `cw gate override`.

## What is still only instructed

Classification honesty, checkpoint quality, confidence calibration and off-track
self-reporting are model behaviour. The runtime can refuse an unassessed
dimension, an unopened mandatory checkpoint and an unanswered one; it cannot tell
that `92%` was invented, or that a checkpoint had no real decision behind it.
`cw mission route` is cheap — the fastest way to check that a mission was
classified sanely is to read what the router said it would cost.
