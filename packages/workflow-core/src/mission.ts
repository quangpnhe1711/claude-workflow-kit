/**
 * Mission Control (AI WORKFLOW V2).
 *
 * The topology layer answers "which phase is this run in". A mission answers the
 * questions a Tech Lead actually asks before letting work continue: what kind of
 * task is this, how deep a workflow does it deserve, what evidence exists, how
 * confident is the conclusion, which risks are live, and what still needs a human
 * decision.
 *
 * Everything in this module is data plus pure derivation. The mission record is
 * stored inside `RunState` (one atomic file, one writer), and the runtime is the
 * only thing that mutates it.
 */

import type { RunState, WorkflowDefinition } from './types.js';
import { findNode } from './state-machine.js';

// ---- taxonomy --------------------------------------------------------------

export const TASK_TYPES = [
  'ui-change',
  'ux-change',
  'text-label',
  'css-layout',
  'bug-fix',
  'validation',
  'crud',
  'api-change',
  'small-feature',
  'medium-feature',
  'large-feature',
  'security',
  'permission',
  'authentication',
  'authorization',
  'database',
  'migration',
  'cache',
  'notification',
  'export',
  'import',
  'integration',
  'performance',
  'refactor',
  'architecture',
  'research',
  'documentation',
  'devops',
  'build',
  'configuration',
  'testing',
  'release',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const COMPLEXITIES = ['TRIVIAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const RISK_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Workflow depth, independent of the topology id that implements it. */
export const WORKFLOW_CLASSES = ['LIGHTNING', 'FAST', 'STANDARD', 'DEEP', 'RESEARCH'] as const;
export type WorkflowClass = (typeof WORKFLOW_CLASSES)[number];

export const MISSION_STATES = [
  'RECEIVED',
  'CLASSIFYING',
  'PLANNING',
  'WAITING_PLAN_APPROVAL',
  'INVESTIGATING',
  'WAITING_INVESTIGATION_APPROVAL',
  'DESIGNING',
  'WAITING_DESIGN_APPROVAL',
  'READY_TO_IMPLEMENT',
  'IMPLEMENTING',
  'WAITING_CODE_APPROVAL',
  'VALIDATING',
  'WAITING_RELEASE_APPROVAL',
  'DELIVERING',
  'COMPLETED',
  'PAUSED',
  'BLOCKED',
  'CANCELLED',
  'FAILED',
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

export const TERMINAL_MISSION_STATES: readonly MissionState[] = [
  'COMPLETED',
  'CANCELLED',
  'FAILED',
];

export const CONFIDENCE_DIMENSIONS = [
  'requirement',
  'scope',
  'businessRule',
  'architecture',
  'rootCause',
  'design',
  'implementation',
  'testing',
  'release',
] as const;
export type ConfidenceDimension = (typeof CONFIDENCE_DIMENSIONS)[number];

export const EVIDENCE_CATEGORIES = [
  'requirement',
  'ui',
  'frontend',
  'backend',
  'database',
  'api',
  'businessRule',
  'permission',
  'security',
  'architecture',
  'cache',
  'notification',
  'export',
  'integration',
  'test',
  'runtime',
  'log',
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

export const EVIDENCE_STATUSES = [
  'NOT_REQUIRED',
  'MISSING',
  'PARTIAL',
  'SUFFICIENT',
  'CONFLICTING',
  'OUTDATED',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/** Evidence states that make an implementation claim unsupported. */
export const BLOCKING_EVIDENCE_STATUSES: readonly EvidenceStatus[] = [
  'MISSING',
  'CONFLICTING',
  'OUTDATED',
];

export const RISK_CATEGORIES = [
  'database',
  'api',
  'permission',
  'authentication',
  'authorization',
  'security',
  'cache',
  'export',
  'import',
  'notification',
  'performance',
  'frontend',
  'backend',
  'integration',
  'migration',
  'data-loss',
  'backward-compatibility',
  'deployment',
  'rollback',
  'testing',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const CHECKPOINT_KINDS = [
  'PLAN',
  'INVESTIGATION',
  'ROOT_CAUSE',
  'ARCHITECTURE',
  'DESIGN',
  'HIGH_RISK',
  'CODE',
  'RELEASE',
] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

/**
 * A pending checkpoint of a blocking kind stops repository mutation. RELEASE is
 * the deliberate exception: it gates the release step, not the editor, and
 * blocking it would leave the run unable to write its own release evidence.
 */
export const BLOCKING_CHECKPOINT_KINDS: readonly CheckpointKind[] = [
  'PLAN',
  'INVESTIGATION',
  'ROOT_CAUSE',
  'ARCHITECTURE',
  'DESIGN',
  'HIGH_RISK',
  'CODE',
];

export const EFFORTS = ['VERY_SMALL', 'SMALL', 'MEDIUM', 'LARGE', 'VERY_LARGE'] as const;
export type EstimatedEffort = (typeof EFFORTS)[number];

export const MISSION_HEALTH = [
  'HEALTHY',
  'NEEDS_ATTENTION',
  'AT_RISK',
  'BLOCKED',
  'CRITICAL',
] as const;
export type MissionHealth = (typeof MISSION_HEALTH)[number];

// ---- stored shapes ---------------------------------------------------------

/**
 * Structural facts about the change that drive workflow depth and mandatory
 * checkpoints. They are declared, not guessed: the router turns them into
 * requirements a run cannot talk its way out of.
 */
export interface MissionFlags {
  databaseChange?: boolean;
  apiContractChange?: boolean;
  permissionOrSecurity?: boolean;
  migration?: boolean;
  backwardCompatibility?: boolean;
  dataLossRisk?: boolean;
  productionImpact?: boolean;
  multiModule?: boolean;
  architectureChange?: boolean;
  analysisOnly?: boolean;
  /** The user asked to review generated code before it is applied. */
  reviewBeforeApply?: boolean;
  deployment?: boolean;
  cacheInvalidation?: boolean;
  breakingChange?: boolean;
  multipleSolutions?: boolean;
}

export const MISSION_FLAG_KEYS = [
  'databaseChange',
  'apiContractChange',
  'permissionOrSecurity',
  'migration',
  'backwardCompatibility',
  'dataLossRisk',
  'productionImpact',
  'multiModule',
  'architectureChange',
  'analysisOnly',
  'reviewBeforeApply',
  'deployment',
  'cacheInvalidation',
  'breakingChange',
  'multipleSolutions',
] as const satisfies readonly (keyof MissionFlags)[];

export interface MissionClassification {
  taskType: TaskType;
  subtypes: TaskType[];
  complexity: Complexity;
  riskLevel: RiskLevel;
  workflowClass: WorkflowClass;
  /** Topology id that implements the class in this installation. */
  topology: string;
  effort: EstimatedEffort;
  reason: string;
  flags: MissionFlags;
  classifiedAt: string;
}

export interface MissionPlan {
  objective: string;
  scope: string[];
  outOfScope: string[];
  assumptions: string[];
  dependencies: string[];
  stopConditions: string[];
  successCriteria: string[];
  requiredSteps: string[];
  skippedSteps: string[];
  validation: string[];
  createdAt: string;
}

export interface EvidenceRecord {
  status: EvidenceStatus;
  note?: string;
  updatedAt: string;
}

export interface RiskRecord {
  id: string;
  category: RiskCategory;
  level: RiskLevel;
  trigger: string;
  evidence?: string;
  probability?: string;
  impact?: string;
  mitigation?: string;
  status: 'OPEN' | 'MITIGATED' | 'ACCEPTED' | 'CLOSED';
  requiredDecision?: string;
  /** Highest level this risk ever reached; escalation is not rewritten away. */
  peakLevel: RiskLevel;
  updatedAt: string;
}

export interface DecisionRecord {
  id: string;
  decision: string;
  reason: string;
  evidence: string[];
  confidence?: number;
  alternatives: string[];
  rejected: string[];
  impact?: string;
  risk?: RiskLevel;
  reversibility?: string;
  approvalRequired: boolean;
  approvedAt?: string;
  at: string;
}

export type MissionTaskStatus = 'PENDING' | 'ACTIVE' | 'DONE' | 'SKIPPED' | 'BLOCKED';

export interface MissionTask {
  id: string;
  epic: string;
  title: string;
  status: MissionTaskStatus;
  /** Relative task weight for progress; defaults to 1. */
  weight: number;
  /** Why a task added mid-mission belongs to this mission. */
  reason?: string;
  evidence?: string;
  updatedAt: string;
}

export type CheckpointStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED' | 'CANCELLED';

export interface Checkpoint {
  id: string;
  kind: CheckpointKind;
  summary: string;
  decisionRequired: string;
  recommendation?: string;
  alternatives: string[];
  evidence: string[];
  risk?: RiskLevel;
  impact?: string;
  confidence?: number;
  status: CheckpointStatus;
  /** Free-text answer recorded with the decision. */
  response?: string;
  respondedAt?: string;
  /** Who resolved it: a Claude session, or the Mission Board. */
  respondedVia?: 'cli' | 'board';
  openedAt: string;
  openedAtNode?: string;
}

export interface Deliverable {
  name: string;
  required: boolean;
  reason?: string;
  status: 'PENDING' | 'DONE' | 'SKIPPED';
  location?: string;
  updatedAt: string;
}

export interface OffTrackRecord {
  status: 'ON_TRACK' | 'OFF_TRACK';
  expectedScope?: string;
  actualScope?: string;
  reason?: string;
  recommendation?: string;
  at: string;
}

export interface ContextRecord {
  /** Self-assessed coverage 0-100 of the context the mission still holds. */
  coverage?: number;
  summary?: string;
  openQuestions: string[];
  degraded: boolean;
  at: string;
}

export interface ScopeChangeRecord {
  previousScope: string;
  newScope: string;
  reason: string;
  addedTasks: string[];
  removedTasks: string[];
  riskChange?: string;
  workflowChange?: string;
  at: string;
}

/** A blocker the user explicitly chose to proceed past. */
export interface RiskAcceptance {
  blockers: string[];
  reason: string;
  at: string;
}

export interface MissionRecord {
  state: MissionState;
  /** State the mission returns to on resume. */
  stateBeforePause?: MissionState;
  pauseReason?: string;
  classification?: MissionClassification;
  plan?: MissionPlan;
  confidence: Partial<Record<ConfidenceDimension, number>>;
  evidence: Partial<Record<EvidenceCategory, EvidenceRecord>>;
  risks: RiskRecord[];
  decisions: DecisionRecord[];
  tasks: MissionTask[];
  checkpoints: Checkpoint[];
  deliverables: Deliverable[];
  offTrack?: OffTrackRecord;
  context?: ContextRecord;
  scopeChanges: ScopeChangeRecord[];
  acceptances: RiskAcceptance[];
  /** Free-text "what is AI doing right now", shown on the Mission Board. */
  currentAction?: string;
  updatedAt: string;
}

export function emptyMission(now: string): MissionRecord {
  return {
    state: 'RECEIVED',
    confidence: {},
    evidence: {},
    risks: [],
    decisions: [],
    tasks: [],
    checkpoints: [],
    deliverables: [],
    scopeChanges: [],
    acceptances: [],
    updatedAt: now,
  };
}

// ---- routing ---------------------------------------------------------------

/** Task types whose presence alone justifies the deepest workflow. */
export const HIGH_RISK_TASK_TYPES: readonly TaskType[] = [
  'security',
  'permission',
  'authentication',
  'authorization',
  'migration',
  'architecture',
];

const DEFECT_TASK_TYPES: readonly TaskType[] = ['bug-fix', 'performance', 'validation'];

const CLASS_ORDER: Record<WorkflowClass, number> = {
  RESEARCH: 0,
  LIGHTNING: 1,
  FAST: 2,
  STANDARD: 3,
  DEEP: 4,
};

/** Topology id that implements a workflow class. */
export function topologyFor(workflowClass: WorkflowClass, taskType: TaskType, subtypes: TaskType[] = []): string {
  switch (workflowClass) {
    case 'RESEARCH':
      return 'solution-analysis';
    case 'LIGHTNING':
    case 'FAST':
      return 'quick-fix';
    case 'STANDARD':
      return 'standard-change';
    case 'DEEP':
      return [taskType, ...subtypes].some((t) => DEFECT_TASK_TYPES.includes(t))
        ? 'bug-fix'
        : 'feature-change';
  }
}

export interface RouteInput {
  taskType: TaskType;
  subtypes?: TaskType[];
  complexity: Complexity;
  riskLevel?: RiskLevel;
  flags?: MissionFlags;
  /** Depth the user asked for explicitly; never downgraded below it. */
  requestedClass?: WorkflowClass;
}

export interface RouteResult {
  workflowClass: WorkflowClass;
  topology: string;
  riskLevel: RiskLevel;
  effort: EstimatedEffort;
  requiredCheckpoints: CheckpointKind[];
  validation: string[];
  skippedValidation: string[];
  confidenceThresholds: Partial<Record<ConfidenceDimension, number>>;
  reason: string;
}

const COMPLEXITY_CLASS: Record<Complexity, WorkflowClass> = {
  TRIVIAL: 'LIGHTNING',
  LOW: 'FAST',
  MEDIUM: 'STANDARD',
  HIGH: 'DEEP',
};

const COMPLEXITY_EFFORT: Record<Complexity, EstimatedEffort> = {
  TRIVIAL: 'VERY_SMALL',
  LOW: 'SMALL',
  MEDIUM: 'MEDIUM',
  HIGH: 'LARGE',
};

/** Structural facts that make a change high-risk regardless of stated size. */
function structurallyDeep(flags: MissionFlags): boolean {
  return Boolean(
    flags.permissionOrSecurity ||
      flags.migration ||
      flags.dataLossRisk ||
      flags.architectureChange ||
      flags.breakingChange,
  );
}

function inferRisk(input: RouteInput): RiskLevel {
  if (input.riskLevel) return input.riskLevel;
  const flags = input.flags ?? {};
  if (flags.dataLossRisk || flags.migration) return 'HIGH';
  if (structurallyDeep(flags)) return 'HIGH';
  if (flags.databaseChange || flags.apiContractChange || flags.multiModule || flags.productionImpact) {
    return 'MEDIUM';
  }
  if (input.complexity === 'HIGH') return 'HIGH';
  if (input.complexity === 'MEDIUM') return 'MEDIUM';
  return 'LOW';
}

/**
 * Pick the shortest workflow that is still safe. Complexity sets the floor;
 * declared risk and structural facts can only raise it, never lower it, and an
 * explicit user request for a deeper path always wins.
 */
export function routeMission(input: RouteInput): RouteResult {
  const subtypes = input.subtypes ?? [];
  const flags = input.flags ?? {};
  const riskLevel = inferRisk(input);
  const types = [input.taskType, ...subtypes];
  const reasons: string[] = [];

  let workflowClass: WorkflowClass = COMPLEXITY_CLASS[input.complexity];
  reasons.push(`complexity ${input.complexity} -> ${workflowClass}`);

  const raise = (target: WorkflowClass, why: string): void => {
    if (CLASS_ORDER[target] > CLASS_ORDER[workflowClass]) {
      workflowClass = target;
      reasons.push(why);
    }
  };

  if (riskLevel === 'MEDIUM') raise('FAST', 'MEDIUM risk cannot use the Lightning path');
  if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') raise('DEEP', `${riskLevel} risk requires Deep`);
  if (types.some((t) => HIGH_RISK_TASK_TYPES.includes(t))) {
    raise('DEEP', `task type ${types.find((t) => HIGH_RISK_TASK_TYPES.includes(t))} requires Deep`);
  }
  if (structurallyDeep(flags)) raise('DEEP', 'permission/security, migration, architecture or breaking change');
  if (flags.databaseChange || flags.apiContractChange || flags.multiModule) {
    raise('STANDARD', 'database, API contract or multi-module impact needs at least Standard');
  }
  if (input.requestedClass && CLASS_ORDER[input.requestedClass] > CLASS_ORDER[workflowClass]) {
    workflowClass = input.requestedClass;
    reasons.push(`user requested ${input.requestedClass}`);
  }

  // Analysis-only overrides depth entirely: nothing is implemented, so no
  // implementation-side safety step applies.
  if (flags.analysisOnly || input.taskType === 'research') {
    workflowClass = 'RESEARCH';
    reasons.length = 0;
    reasons.push('analysis-only request: no product source is mutated');
  }

  const effort: EstimatedEffort =
    workflowClass === 'DEEP' && (flags.migration || flags.multiModule || input.complexity === 'HIGH')
      ? 'VERY_LARGE'
      : COMPLEXITY_EFFORT[input.complexity];

  const validation = validationStrategy(workflowClass, flags);
  return {
    workflowClass,
    topology: topologyFor(workflowClass, input.taskType, subtypes),
    riskLevel,
    effort,
    requiredCheckpoints: requiredCheckpoints({ workflowClass, complexity: input.complexity, riskLevel, taskType: input.taskType, subtypes, flags }),
    validation,
    skippedValidation: skippedValidation(validation),
    confidenceThresholds: confidenceThresholds({ taskType: input.taskType, subtypes, flags, workflowClass }),
    reason: reasons.join('; '),
  };
}

// ---- checkpoints, validation, thresholds -----------------------------------

export interface CheckpointInput {
  workflowClass: WorkflowClass;
  complexity: Complexity;
  riskLevel: RiskLevel;
  taskType: TaskType;
  subtypes?: TaskType[];
  flags?: MissionFlags;
}

/** Checkpoints a mission may not skip. Derived, so it cannot be argued away. */
export function requiredCheckpoints(input: CheckpointInput): CheckpointKind[] {
  const flags = input.flags ?? {};
  const types = [input.taskType, ...(input.subtypes ?? [])];
  const out = new Set<CheckpointKind>();
  const riskAtLeastMedium = ['MEDIUM', 'HIGH', 'CRITICAL'].includes(input.riskLevel);

  if (input.workflowClass === 'DEEP') {
    out.add('PLAN');
    out.add('INVESTIGATION');
    out.add('DESIGN');
    out.add('CODE');
  }
  if (input.complexity === 'HIGH' || flags.multiModule) out.add('PLAN');
  if (riskAtLeastMedium && (flags.databaseChange || flags.apiContractChange || flags.permissionOrSecurity)) {
    out.add('PLAN');
  }
  if (types.includes('bug-fix') && riskAtLeastMedium) out.add('ROOT_CAUSE');
  if (flags.architectureChange || types.includes('architecture') || flags.cacheInvalidation) {
    out.add('ARCHITECTURE');
  }
  if (flags.multipleSolutions || flags.apiContractChange || flags.databaseChange) out.add('DESIGN');
  if (
    flags.dataLossRisk ||
    flags.permissionOrSecurity ||
    flags.migration ||
    flags.backwardCompatibility ||
    flags.productionImpact
  ) {
    out.add('HIGH_RISK');
  }
  if (flags.reviewBeforeApply || flags.permissionOrSecurity || types.includes('large-feature') || types.includes('refactor')) {
    out.add('CODE');
  }
  if (flags.migration || flags.breakingChange || flags.deployment || flags.cacheInvalidation) {
    out.add('RELEASE');
  }
  return CHECKPOINT_KINDS.filter((kind) => out.has(kind));
}

const VALIDATION_STEPS: Record<WorkflowClass, string[]> = {
  LIGHTNING: ['build', 'compile', 'type-check', 'targeted-static-check'],
  FAST: ['build', 'compile', 'targeted-smoke-test', 'existing-targeted-unit-test'],
  STANDARD: ['build', 'compile', 'unit-test', 'integration-test', 'scoped-regression'],
  DEEP: ['build', 'compile', 'unit-test', 'integration-test', 'scoped-regression'],
  RESEARCH: [],
};

const ALL_VALIDATION_STEPS = [
  'build',
  'compile',
  'type-check',
  'targeted-static-check',
  'targeted-smoke-test',
  'existing-targeted-unit-test',
  'unit-test',
  'integration-test',
  'scoped-regression',
  'api-contract-check',
  'ui-behavior-check',
  'permission-test',
  'security-review',
  'performance-check',
  'migration-check',
  'backward-compatibility-check',
  'rollback-check',
];

/**
 * Only the steps that close a real risk. A permission change off the hot path
 * does not earn a performance test, and a label change does not earn a security
 * scan — running them anyway is how a workflow becomes theatre.
 */
export function validationStrategy(workflowClass: WorkflowClass, flags: MissionFlags = {}): string[] {
  const steps = [...VALIDATION_STEPS[workflowClass]];
  const add = (step: string): void => {
    if (!steps.includes(step)) steps.push(step);
  };
  if (flags.apiContractChange) add('api-contract-check');
  if (flags.permissionOrSecurity) {
    add('permission-test');
    add('security-review');
  }
  if (flags.migration) {
    add('migration-check');
    add('rollback-check');
  }
  if (flags.backwardCompatibility) add('backward-compatibility-check');
  if (workflowClass === 'RESEARCH') return [];
  return steps;
}

export function skippedValidation(selected: string[]): string[] {
  return ALL_VALIDATION_STEPS.filter((step) => !selected.includes(step));
}

/** Thresholds a classified mission is held to. Empty until it classifies. */
export function missionThresholds(
  classification: MissionClassification | undefined,
): Partial<Record<ConfidenceDimension, number>> {
  if (!classification) return {};
  return confidenceThresholds({
    taskType: classification.taskType,
    subtypes: classification.subtypes,
    flags: classification.flags,
    workflowClass: classification.workflowClass,
  });
}

/**
 * Confidence floors by workflow depth. A label change does not owe an
 * architecture-understanding score — demanding six numbers for a one-line edit is
 * the ceremony this system exists to avoid — but a Deep run owes all of them.
 */
const CLASS_THRESHOLDS: Record<WorkflowClass, Partial<Record<ConfidenceDimension, number>>> = {
  LIGHTNING: { requirement: 70, scope: 70 },
  FAST: { requirement: 70, scope: 70, implementation: 75 },
  STANDARD: { requirement: 70, scope: 70, businessRule: 70, design: 70, implementation: 75 },
  DEEP: {
    requirement: 70,
    scope: 70,
    businessRule: 70,
    architecture: 60,
    design: 70,
    implementation: 75,
  },
  RESEARCH: { requirement: 70, scope: 70 },
};

/**
 * Minimum confidence before implementation may start. Bug fixes add a root-cause
 * floor; permission and security work raises the understanding floors, because
 * "probably right" about an authorization rule is a vulnerability.
 */
export function confidenceThresholds(input: {
  taskType: TaskType;
  subtypes?: TaskType[];
  flags?: MissionFlags;
  workflowClass?: WorkflowClass;
}): Partial<Record<ConfidenceDimension, number>> {
  const thresholds = { ...CLASS_THRESHOLDS[input.workflowClass ?? 'STANDARD'] };
  const types = [input.taskType, ...(input.subtypes ?? [])];
  if (types.includes('bug-fix')) thresholds.rootCause = 75;
  if (input.flags?.permissionOrSecurity || types.some((t) => HIGH_RISK_TASK_TYPES.includes(t))) {
    thresholds.businessRule = 80;
    thresholds.architecture = 80;
  }
  return thresholds;
}

// ---- gates ----------------------------------------------------------------

export interface MissionReadiness {
  ok: boolean;
  blockers: string[];
  /** Non-blocking observations worth printing next to the decision. */
  warnings: string[];
}

function acceptanceCovers(mission: MissionRecord, blocker: string): boolean {
  return mission.acceptances.some((a) => a.blockers.includes(blocker));
}

export function pendingCheckpoints(mission: MissionRecord): Checkpoint[] {
  return mission.checkpoints.filter((c) => c.status === 'PENDING');
}

export function blockingCheckpoints(mission: MissionRecord): Checkpoint[] {
  return pendingCheckpoints(mission).filter((c) => BLOCKING_CHECKPOINT_KINDS.includes(c.kind));
}

/** Required checkpoints that were never opened. A missing one is not a pass. */
export function unopenedRequiredCheckpoints(mission: MissionRecord): CheckpointKind[] {
  const required = mission.classification
    ? requiredCheckpoints({
        workflowClass: mission.classification.workflowClass,
        complexity: mission.classification.complexity,
        riskLevel: mission.classification.riskLevel,
        taskType: mission.classification.taskType,
        subtypes: mission.classification.subtypes,
        flags: mission.classification.flags,
      })
    : [];
  // RELEASE is decided after implementation, so it is not owed at this point.
  return required.filter(
    (kind) =>
      kind !== 'RELEASE' &&
      kind !== 'CODE' &&
      !mission.checkpoints.some((c) => c.kind === kind && c.status !== 'CANCELLED'),
  );
}

/**
 * May implementation start? Everything that says "no" is listed, not just the
 * first thing: a user deciding whether to proceed anyway needs the whole bill.
 */
export function implementationReadiness(mission: MissionRecord): MissionReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (mission.state === 'PAUSED') blockers.push('mission is PAUSED');
  if (mission.state === 'CANCELLED') blockers.push('mission is CANCELLED');
  if (mission.state === 'BLOCKED') blockers.push('mission is BLOCKED');

  for (const checkpoint of blockingCheckpoints(mission)) {
    blockers.push(`checkpoint ${checkpoint.id} (${checkpoint.kind}) is awaiting the user`);
  }
  for (const kind of unopenedRequiredCheckpoints(mission)) {
    blockers.push(`required ${kind} checkpoint was never opened`);
  }
  for (const risk of mission.risks) {
    if (risk.level === 'CRITICAL' && risk.status === 'OPEN') {
      blockers.push(`CRITICAL risk ${risk.id} (${risk.category}) is unresolved`);
    } else if (risk.level === 'HIGH' && risk.status === 'OPEN') {
      warnings.push(`HIGH risk ${risk.id} (${risk.category}) is still open`);
    }
  }

  for (const [category, record] of Object.entries(mission.evidence) as [EvidenceCategory, EvidenceRecord][]) {
    if (BLOCKING_EVIDENCE_STATUSES.includes(record.status)) {
      blockers.push(`evidence ${category} is ${record.status}`);
    } else if (record.status === 'PARTIAL') {
      warnings.push(`evidence ${category} is only PARTIAL`);
    }
  }

  const thresholds = missionThresholds(mission.classification);
  for (const [dimension, minimum] of Object.entries(thresholds) as [ConfidenceDimension, number][]) {
    const value = mission.confidence[dimension];
    if (value === undefined) {
      blockers.push(`confidence ${dimension} has not been assessed (needs >= ${minimum}%)`);
    } else if (value < minimum) {
      blockers.push(`confidence ${dimension} is ${value}% (needs >= ${minimum}%)`);
    }
  }

  const remaining = blockers.filter((b) => !acceptanceCovers(mission, b));
  const waived = blockers.filter((b) => acceptanceCovers(mission, b));
  for (const item of waived) warnings.push(`accepted risk: ${item}`);
  return { ok: remaining.length === 0, blockers: remaining, warnings };
}

/**
 * Mission reasons that deny *every* repository write, not just a phase entry.
 *
 * Deliberately narrower than `implementationReadiness`: a paused mission, an open
 * human checkpoint and evidence the mission itself declared unusable are facts.
 * A confidence number below its threshold is a judgment the model keeps
 * revising, and denying every write on an unassessed dimension would fire before
 * the mission ever had the chance to assess it — that stays a phase-entry gate.
 */
export function missionMutationBlocks(mission: MissionRecord): string[] {
  const blocks: string[] = [];
  if (mission.state === 'PAUSED') {
    blocks.push(`mission is PAUSED${mission.pauseReason ? `: ${mission.pauseReason}` : ''}`);
  }
  if (mission.state === 'CANCELLED') blocks.push('mission is CANCELLED');
  for (const checkpoint of blockingCheckpoints(mission)) {
    blocks.push(`checkpoint ${checkpoint.id} (${checkpoint.kind}) is awaiting the user`);
  }
  for (const kind of unopenedRequiredCheckpoints(mission)) {
    blocks.push(`required ${kind} checkpoint was never opened`);
  }
  for (const [category, record] of Object.entries(mission.evidence) as [EvidenceCategory, EvidenceRecord][]) {
    if (BLOCKING_EVIDENCE_STATUSES.includes(record.status)) {
      blocks.push(`evidence ${category} is ${record.status}`);
    }
  }
  return blocks.filter((block) => !acceptanceCovers(mission, block));
}

/**
 * Why this mission may not be marked complete. `COMPLETED` is a claim about
 * deliverables and decisions, so an unanswered checkpoint or an undelivered
 * required deliverable is a refusal, not a footnote.
 */
export function missionCompletionBlockers(mission: MissionRecord): string[] {
  const blockers: string[] = [];
  if (mission.state === 'CANCELLED') blockers.push('mission is CANCELLED');
  if (mission.state === 'PAUSED') blockers.push('mission is PAUSED');
  for (const checkpoint of pendingCheckpoints(mission)) {
    blockers.push(`checkpoint ${checkpoint.id} (${checkpoint.kind}) is still awaiting the user`);
  }
  for (const deliverable of mission.deliverables) {
    if (deliverable.required && deliverable.status !== 'DONE') {
      blockers.push(`required deliverable "${deliverable.name}" is ${deliverable.status}`);
    }
  }
  for (const risk of mission.risks) {
    if (risk.level === 'CRITICAL' && risk.status === 'OPEN') {
      blockers.push(`CRITICAL risk ${risk.id} is still open`);
    }
  }
  return blockers;
}

/** Nodes whose entry means "the repository is about to change". */
export function isImplementationNode(def: WorkflowDefinition, nodeId: string): boolean {
  const node = findNode(def, nodeId);
  if (!node) return false;
  if (node.implementation === true) return true;
  return node.implementation === undefined && ['implementation', 'fix'].includes(node.id);
}

// ---- monitors -------------------------------------------------------------

export interface MissionHealthReport {
  health: MissionHealth;
  reasons: string[];
}

/** Health is a summary of the monitors, not an independent opinion. */
export function missionHealthReport(mission: MissionRecord): MissionHealthReport {
  const reasons: string[] = [];
  let health: MissionHealth = 'HEALTHY';
  const worse = (next: MissionHealth, why: string): void => {
    reasons.push(why);
    if (MISSION_HEALTH.indexOf(next) > MISSION_HEALTH.indexOf(health)) health = next;
  };

  if (mission.risks.some((r) => r.level === 'CRITICAL' && r.status === 'OPEN')) {
    worse('CRITICAL', 'an open CRITICAL risk stops implementation');
  }
  if (mission.state === 'BLOCKED') worse('BLOCKED', 'mission state is BLOCKED');
  if (mission.state === 'PAUSED') worse('BLOCKED', `mission is paused${mission.pauseReason ? `: ${mission.pauseReason}` : ''}`);
  for (const checkpoint of pendingCheckpoints(mission)) {
    worse('BLOCKED', `checkpoint ${checkpoint.id} (${checkpoint.kind}) is awaiting the user`);
  }
  if (mission.risks.some((r) => r.level === 'HIGH' && r.status === 'OPEN')) {
    worse('AT_RISK', 'an open HIGH risk is not yet mitigated');
  }
  const conflicting = Object.entries(mission.evidence).filter(
    ([, record]) => record.status === 'CONFLICTING' || record.status === 'OUTDATED',
  );
  for (const [category, record] of conflicting) worse('AT_RISK', `evidence ${category} is ${record.status}`);
  if (mission.offTrack?.status === 'OFF_TRACK') {
    worse('NEEDS_ATTENTION', `off track: ${mission.offTrack.reason ?? 'investigation left the mission scope'}`);
  }
  if (mission.context?.degraded) worse('NEEDS_ATTENTION', 'context is degraded; write a context summary');
  const thresholds = missionThresholds(mission.classification);
  for (const [dimension, minimum] of Object.entries(thresholds) as [ConfidenceDimension, number][]) {
    const value = mission.confidence[dimension];
    if (value !== undefined && value < minimum) {
      worse('NEEDS_ATTENTION', `${dimension} confidence ${value}% is below the ${minimum}% threshold`);
    }
  }
  for (const [category, record] of Object.entries(mission.evidence)) {
    if (record.status === 'MISSING') worse('NEEDS_ATTENTION', `evidence ${category} is MISSING`);
  }
  if (!reasons.length) reasons.push('evidence, confidence, risk and scope are within thresholds');
  return { health, reasons };
}

/** Mission-state progress used when no task breakdown exists yet. */
const STATE_PROGRESS: Record<MissionState, number> = {
  RECEIVED: 0,
  CLASSIFYING: 3,
  PLANNING: 8,
  WAITING_PLAN_APPROVAL: 10,
  INVESTIGATING: 25,
  WAITING_INVESTIGATION_APPROVAL: 35,
  DESIGNING: 45,
  WAITING_DESIGN_APPROVAL: 50,
  READY_TO_IMPLEMENT: 55,
  IMPLEMENTING: 70,
  WAITING_CODE_APPROVAL: 80,
  VALIDATING: 88,
  WAITING_RELEASE_APPROVAL: 94,
  DELIVERING: 97,
  COMPLETED: 100,
  PAUSED: 0,
  BLOCKED: 0,
  CANCELLED: 0,
  FAILED: 0,
};

export interface MissionProgress {
  percent: number;
  completedTasks: number;
  totalTasks: number;
  remainingTasks: string[];
  basis: 'tasks' | 'state';
}

/**
 * Weighted by task weight, not by task count: five one-line subtasks and one
 * migration are not the same amount of work, and a count-based bar says they are.
 */
export function missionProgress(mission: MissionRecord): MissionProgress {
  const counted = mission.tasks.filter((t) => t.status !== 'SKIPPED');
  const total = counted.reduce((sum, t) => sum + (t.weight || 1), 0);
  const done = counted
    .filter((t) => t.status === 'DONE')
    .reduce((sum, t) => sum + (t.weight || 1), 0);
  const remainingTasks = counted.filter((t) => t.status !== 'DONE').map((t) => `${t.epic}: ${t.title}`);
  if (!total) {
    return {
      percent: STATE_PROGRESS[mission.state],
      completedTasks: 0,
      totalTasks: 0,
      remainingTasks: [],
      basis: 'state',
    };
  }
  return {
    percent: Math.round((done / total) * 100),
    completedTasks: counted.filter((t) => t.status === 'DONE').length,
    totalTasks: counted.length,
    remainingTasks,
    basis: 'tasks',
  };
}

// ---- mission state machine ------------------------------------------------

const NEXT_STATES: Record<MissionState, MissionState[]> = {
  RECEIVED: ['CLASSIFYING'],
  CLASSIFYING: ['PLANNING'],
  PLANNING: ['WAITING_PLAN_APPROVAL', 'INVESTIGATING'],
  WAITING_PLAN_APPROVAL: ['PLANNING', 'INVESTIGATING', 'CANCELLED'],
  // Lightning and Fast have no design stage at all (§6.1, §6.2), so investigating
  // straight into implementation is the normal short path, not a skipped step.
  INVESTIGATING: [
    'WAITING_INVESTIGATION_APPROVAL',
    'DESIGNING',
    'READY_TO_IMPLEMENT',
    'IMPLEMENTING',
    'PLANNING',
  ],
  WAITING_INVESTIGATION_APPROVAL: ['INVESTIGATING', 'DESIGNING', 'READY_TO_IMPLEMENT'],
  DESIGNING: ['WAITING_DESIGN_APPROVAL', 'READY_TO_IMPLEMENT', 'INVESTIGATING'],
  WAITING_DESIGN_APPROVAL: ['DESIGNING', 'READY_TO_IMPLEMENT'],
  READY_TO_IMPLEMENT: ['IMPLEMENTING', 'DESIGNING'],
  IMPLEMENTING: ['WAITING_CODE_APPROVAL', 'VALIDATING', 'INVESTIGATING', 'DESIGNING'],
  WAITING_CODE_APPROVAL: ['IMPLEMENTING', 'VALIDATING'],
  VALIDATING: ['IMPLEMENTING', 'WAITING_RELEASE_APPROVAL', 'DELIVERING'],
  WAITING_RELEASE_APPROVAL: ['DELIVERING', 'VALIDATING'],
  DELIVERING: ['COMPLETED', 'VALIDATING'],
  COMPLETED: [],
  // A paused mission only leaves through `resume`, which restores the state it
  // stood in. Anything else would let work continue under a paused board.
  PAUSED: [],
  // A blocker that clears can resume anywhere: the mission was not rewound.
  BLOCKED: [...MISSION_STATES],
  CANCELLED: [],
  FAILED: [],
};

export function missionStateAllowed(from: MissionState, to: MissionState): boolean {
  if (from === to) return true;
  // Pausing, blocking, cancelling and failing are always reachable from a live
  // mission: the user's control over the run does not depend on its phase.
  if (['PAUSED', 'BLOCKED', 'CANCELLED', 'FAILED'].includes(to)) {
    return !TERMINAL_MISSION_STATES.includes(from);
  }
  // Asking the user is also always reachable — a checkpoint can be opened the
  // moment a material decision appears, whatever phase produced it.
  if (to.startsWith('WAITING_')) return !TERMINAL_MISSION_STATES.includes(from) && from !== 'PAUSED';
  return NEXT_STATES[from].includes(to);
}

/** Mission state the topology implies, used to report semantic drift. */
export function missionStateForNode(def: WorkflowDefinition, run: RunState): MissionState | undefined {
  const node = findNode(def, run.currentNode);
  if (!node) return undefined;
  if (node.kind === 'end') return 'DELIVERING';
  if (node.kind === 'start') return 'RECEIVED';
  if (node.kind === 'waiting') {
    if (node.gate === 'ANALYSIS_APPROVED') return 'WAITING_DESIGN_APPROVAL';
    if (node.gate === 'ROOT_CAUSE_READY') return 'WAITING_INVESTIGATION_APPROVAL';
    if (node.gate === 'BUSINESS_READY') return 'WAITING_DESIGN_APPROVAL';
    return 'WAITING_PLAN_APPROVAL';
  }
  if (isImplementationNode(def, node.id)) return 'IMPLEMENTING';
  if (['validation', 'validate', 'e2e', 'review'].includes(node.id)) return 'VALIDATING';
  if (['report', 'assessment'].includes(node.id)) return 'DELIVERING';
  if (['readiness', 'approval', 'design'].includes(node.id)) return 'DESIGNING';
  return 'INVESTIGATING';
}

// ---- output contracts ------------------------------------------------------

// Contracts live in `.claude/prompts/` and are read only when the user asked for
// a document. One contract covers many task types on purpose: the shape of a
// change report does not depend on whether the change was CSS or a cache.
const PROMPT_BY_TYPE: Partial<Record<TaskType, string>> = {
  'bug-fix': 'bug-report.prompt.md',
  research: 'analysis-report.prompt.md',
  architecture: 'decision-record.prompt.md',
  migration: 'migration-plan.prompt.md',
  release: 'release-note.prompt.md',
  testing: 'test-report.prompt.md',
};

/** Output contract for a task type. A change report is the default shape. */
export function outputTemplateFor(taskType: TaskType): string {
  return PROMPT_BY_TYPE[taskType] ?? 'change-report.prompt.md';
}

// ---- board ---------------------------------------------------------------

export interface MissionBoardView {
  runId: string;
  title?: string;
  missionState: MissionState;
  runStatus: string;
  workflowClass?: WorkflowClass;
  topology: string;
  taskType?: TaskType;
  subtypes: TaskType[];
  complexity?: Complexity;
  riskLevel?: RiskLevel;
  currentPhase: string;
  currentAction: string;
  currentFile?: string;
  progress: MissionProgress;
  health: MissionHealthReport;
  readiness: MissionReadiness;
  confidence: Partial<Record<ConfidenceDimension, number>>;
  confidenceThresholds: Partial<Record<ConfidenceDimension, number>>;
  evidence: Partial<Record<EvidenceCategory, EvidenceRecord>>;
  risks: RiskRecord[];
  decisions: DecisionRecord[];
  tasks: MissionTask[];
  checkpoints: Checkpoint[];
  pendingCheckpoints: Checkpoint[];
  deliverables: Deliverable[];
  offTrack?: OffTrackRecord;
  context?: ContextRecord;
  scopeChanges: ScopeChangeRecord[];
  plan?: MissionPlan;
  effort?: EstimatedEffort;
  gates: Record<string, string>;
  availableActions: string[];
  /** The mission state the topology implies, when it disagrees with the record. */
  stateDrift?: MissionState;
  updatedAt: string;
}

/** Actions the Mission Board may offer for the current state. */
export function availableActions(mission: MissionRecord): string[] {
  const actions: string[] = [];
  if (pendingCheckpoints(mission).length) {
    actions.push('approve', 'reject', 'modify', 'request-more-evidence', 'proceed-anyway');
  }
  if (mission.state === 'PAUSED') actions.push('resume');
  else if (!TERMINAL_MISSION_STATES.includes(mission.state)) actions.push('pause');
  if (!TERMINAL_MISSION_STATES.includes(mission.state)) actions.push('cancel');
  if (mission.offTrack?.status === 'OFF_TRACK') actions.push('return-to-scope', 'add-to-scope');
  if (mission.tasks.some((t) => t.status !== 'DONE' && t.status !== 'SKIPPED')) actions.push('skip-task');
  return actions;
}

export function buildMissionBoard(
  run: RunState,
  def: WorkflowDefinition,
  extras: { runStatus: string; currentAction?: string } = { runStatus: run.status },
): MissionBoardView {
  const mission = run.mission ?? emptyMission(run.updatedAt);
  const node = findNode(def, run.currentNode);
  const implied = missionStateForNode(def, run);
  const classification = mission.classification;
  const view: MissionBoardView = {
    runId: run.runId,
    missionState: mission.state,
    runStatus: extras.runStatus,
    topology: run.workflow,
    subtypes: classification?.subtypes ?? [],
    currentPhase: node?.label ?? run.currentNode,
    currentAction: extras.currentAction ?? mission.currentAction ?? actionForRun(run),
    progress: missionProgress(mission),
    health: missionHealthReport(mission),
    readiness: implementationReadiness(mission),
    confidence: mission.confidence,
    confidenceThresholds: missionThresholds(classification),
    evidence: mission.evidence,
    risks: mission.risks,
    decisions: mission.decisions,
    tasks: mission.tasks,
    checkpoints: mission.checkpoints,
    pendingCheckpoints: pendingCheckpoints(mission),
    deliverables: mission.deliverables,
    scopeChanges: mission.scopeChanges,
    gates: { ...run.gates },
    availableActions: availableActions(mission),
    updatedAt: mission.updatedAt,
  };
  if (run.label) view.title = run.label;
  if (classification) {
    view.workflowClass = classification.workflowClass;
    view.taskType = classification.taskType;
    view.complexity = classification.complexity;
    view.riskLevel = classification.riskLevel;
    view.effort = classification.effort;
  }
  if (mission.plan) view.plan = mission.plan;
  if (mission.offTrack) view.offTrack = mission.offTrack;
  if (mission.context) view.context = mission.context;
  if (run.runtime.tool) view.currentFile = run.runtime.tool;
  if (implied && implied !== mission.state && !TERMINAL_MISSION_STATES.includes(mission.state)) {
    view.stateDrift = implied;
  }
  return view;
}

/** Current Action must never be blank while a mission is live. */
function actionForRun(run: RunState): string {
  if (run.status === 'WAITING_USER') return 'Waiting Approval';
  switch (run.runtime.claude) {
    case 'TOOL_RUNNING':
      return run.runtime.tool ? `Running ${run.runtime.tool}` : 'Running Tool';
    case 'SUBAGENT_RUNNING':
      return `Subagent ${run.runtime.agent ?? 'running'}`;
    case 'ACTIVE':
      return 'Analyzing';
    case 'IDLE':
    case 'STOPPED':
      return 'Idle';
    case 'FAILED':
      return 'Blocked';
    default:
      return 'Working';
  }
}

// ---- text rendering -----------------------------------------------------

function pct(value: number | undefined): string {
  return value === undefined ? '—' : `${value}%`;
}

/** Compact Mission Board for a terminal. Organised state, never a raw log. */
export function formatMissionBoard(board: MissionBoardView): string {
  const out: string[] = [];
  const row = (label: string, value: string): void => {
    out.push(`${label.padEnd(12)}${value}`);
  };

  row('mission', `${board.runId}${board.title ? ` — ${board.title}` : ''}`);
  row('state', `${board.missionState} (run ${board.runStatus})`);
  if (board.stateDrift) {
    row('drift', `topology implies ${board.stateDrift}; mission state says ${board.missionState}`);
  }
  if (board.workflowClass) {
    row(
      'workflow',
      `${board.workflowClass} via ${board.topology} — ${board.taskType}${
        board.subtypes.length ? ` (+${board.subtypes.join(', ')})` : ''
      }`,
    );
    row('sizing', `complexity ${board.complexity} risk ${board.riskLevel} effort ${board.effort}`);
  } else {
    row('workflow', `${board.topology} (not classified yet)`);
  }
  row('phase', board.currentPhase);
  row('action', board.currentAction);
  row(
    'progress',
    board.progress.basis === 'tasks'
      ? `${board.progress.percent}% (${board.progress.completedTasks}/${board.progress.totalTasks} tasks, weighted)`
      : `${board.progress.percent}% (from mission state)`,
  );
  row('health', `${board.health.health} — ${board.health.reasons[0]}`);
  for (const reason of board.health.reasons.slice(1)) out.push(`${''.padEnd(12)}${reason}`);

  const gates = Object.entries(board.gates);
  if (gates.length) row('gates', gates.map(([g, s]) => `${g}=${s}`).join(' '));

  const confidence = Object.entries(board.confidence);
  if (confidence.length) {
    row(
      'confidence',
      confidence
        .map(([dimension, value]) => {
          const minimum = board.confidenceThresholds[dimension as ConfidenceDimension];
          const flag = minimum !== undefined && value < minimum ? `<${minimum}!` : '';
          return `${dimension}=${pct(value)}${flag}`;
        })
        .join(' '),
    );
  }
  const evidence = Object.entries(board.evidence);
  if (evidence.length) {
    row('evidence', evidence.map(([category, record]) => `${category}=${record.status}`).join(' '));
  }
  const openRisks = board.risks.filter((r) => r.status === 'OPEN');
  if (openRisks.length) {
    row('risks', openRisks.map((r) => `${r.id} ${r.category} ${r.level}`).join('; '));
  }
  if (board.offTrack?.status === 'OFF_TRACK') {
    row('off-track', board.offTrack.reason ?? 'investigation left the mission scope');
  }
  if (board.context?.degraded) row('context', `DEGRADED${board.context.summary ? ` — ${board.context.summary}` : ''}`);

  for (const checkpoint of board.pendingCheckpoints) {
    out.push('');
    out.push(`CHECKPOINT ${checkpoint.id} [${checkpoint.kind}] — decision required`);
    out.push(`  summary     ${checkpoint.summary}`);
    out.push(`  decision    ${checkpoint.decisionRequired}`);
    if (checkpoint.recommendation) out.push(`  recommended ${checkpoint.recommendation}`);
    if (checkpoint.alternatives.length) out.push(`  alternatives ${checkpoint.alternatives.join(' | ')}`);
    if (checkpoint.evidence.length) out.push(`  evidence    ${checkpoint.evidence.join('; ')}`);
    if (checkpoint.risk) out.push(`  risk        ${checkpoint.risk}`);
    if (checkpoint.impact) out.push(`  impact      ${checkpoint.impact}`);
    if (checkpoint.confidence !== undefined) out.push(`  confidence  ${pct(checkpoint.confidence)}`);
    out.push(`  resolve     cw checkpoint resolve ${checkpoint.id} --action approve|reject|modify --note "..."`);
  }

  if (board.tasks.length) {
    out.push('');
    out.push('TASK BREAKDOWN');
    const epics = [...new Set(board.tasks.map((t) => t.epic))];
    for (const epic of epics) {
      out.push(`  ${epic}`);
      for (const task of board.tasks.filter((t) => t.epic === epic)) {
        out.push(`    [${task.status[0]}] ${task.id} ${task.title}`);
      }
    }
  }

  if (!board.readiness.ok) {
    out.push('');
    out.push('IMPLEMENTATION BLOCKED');
    for (const blocker of board.readiness.blockers) out.push(`  - ${blocker}`);
  }
  if (board.readiness.warnings.length) {
    out.push('');
    out.push('WARNINGS');
    for (const warning of board.readiness.warnings) out.push(`  - ${warning}`);
  }
  if (board.availableActions.length) {
    out.push('');
    out.push(`actions     ${board.availableActions.join(', ')}`);
  }
  return out.join('\n');
}
