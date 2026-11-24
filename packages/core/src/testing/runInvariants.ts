import type { RunEvent } from "../run/index";

// The run invariants of the M1 spec ("Run events and `transition`"), checked on a log alone.
// Nothing here reads a `RunState`: this is the second opinion on what `transition` accepted.

type Status =
  | "Open"
  | "Succeeded"
  | "Failed"
  | "FailedRetryable"
  | "Approved"
  | "Denied"
  | "Cancelled";
type Kind = "Main" | "Finally" | "Gate" | "Undo";
type Entry = {
  readonly kind: Kind;
  readonly step: string;
  readonly item: number | undefined;
  attempt: number;
  status: Status;
};

const failed = (status: Status): boolean =>
  status === "Failed" || status === "FailedRetryable" || status === "Denied";

/** The invariants a log breaks, each named with the `seq` of the event that broke it. */
export const brokenRunInvariants = (log: ReadonlyArray<RunEvent>): ReadonlyArray<string> => {
  const broken: Array<string> = [];
  const first = log[0];
  /** Every piece of work the log has started, in the order each first started. */
  const entries: Array<Entry> = [];
  const keys = new Map<string, string>();
  let ended = false;
  let mainEnd: Extract<RunEvent, { readonly _tag: "MainPhaseEnded" }>["main"] | undefined;
  let finallyBegun = false;
  let handling = false;
  let cancelInEffect = false;

  const find = (kind: Kind, step: string, item: number | undefined): Entry | undefined =>
    entries.find((entry) => entry.kind === kind && entry.step === step && entry.item === item);
  const forwardOf = (step: string, item: number | undefined): Entry | undefined =>
    entries.find((entry) => entry.kind !== "Undo" && entry.step === step && entry.item === item);
  const anyOpen = (): boolean => entries.some((entry) => entry.status === "Open");
  const gateWaiting = (): boolean =>
    entries.some((entry) => entry.kind === "Gate" && entry.status === "Open");
  const lastMainStep = (): string | undefined =>
    entries.findLast((entry) => entry.kind === "Main" || entry.kind === "Gate")?.step;
  const stepFailed = (step: string | undefined): boolean =>
    entries.some((entry) => entry.step === step && entry.kind !== "Undo" && failed(entry.status));
  const position = (step: string): number => entries.findIndex((entry) => entry.step === step);

  for (const [index, event] of log.entries()) {
    const check = (holds: boolean, rule: string): void => {
      if (!holds) {
        broken.push(`${rule} (seq ${event.seq}, ${event._tag})`);
      }
    };

    /** An attempt opens once: attempt 1, or the attempt after a failure that may be retried. */
    const start = (
      kind: Kind,
      step: string,
      item: number | undefined,
      attempt: number,
      key: string,
    ): void => {
      const entry = find(kind, step, item);
      if (entry === undefined) {
        check(attempt === 1, "new work starts at attempt 1");
        entries.push({ kind, step, item, attempt, status: "Open" });
      } else {
        check(
          entry.status === "FailedRetryable" && attempt === entry.attempt + 1,
          "an attempt follows only a failure that may be retried, and is numbered one more",
        );
        entry.attempt = attempt;
        entry.status = "Open";
      }
      const work = `${kind === "Undo" ? "Undo" : "Forward"} ${step} ${item}`;
      check((keys.get(key) ?? work) === work, "an idempotency key belongs to one piece of work");
      keys.set(key, work);
    };

    /** A completion matches exactly one open attempt, so an attempt ends at most once. */
    const end = (
      kinds: ReadonlyArray<Kind>,
      step: string,
      item: number | undefined,
      attempt: number,
      status: Status,
    ): void => {
      const entry = entries.find(
        (candidate) =>
          kinds.includes(candidate.kind) &&
          candidate.step === step &&
          candidate.item === item &&
          candidate.attempt === attempt &&
          candidate.status === "Open",
      );
      check(entry !== undefined, "a completion matches exactly one open attempt");
      if (entry !== undefined) {
        entry.status = status;
      }
    };

    /** Main-phase work starting: a step, a for-each item, a retry or a gate. */
    const mainStarts = (step: string): void => {
      check(mainEnd === undefined, "no main-phase work starts after MainPhaseEnded");
      const previous = lastMainStep();
      const startsHandler = previous !== undefined && previous !== step && stepFailed(previous);
      check(
        !cancelInEffect || handling || startsHandler,
        "after a cancel requested on the normal track, only a failure handler starts",
      );
      handling ||= startsHandler;
    };

    check(event.seq === index, "seq starts at 0 and increases by one");
    check(!ended, "a final state accepts nothing");
    check((event._tag === "RunStarted") === (index === 0), "RunStarted is the first event, once");
    check(
      event.runId === first?.runId &&
        event.recipe.id === first.recipe.id &&
        event.recipe.version === first.recipe.version,
      "the run and its recipe version never change",
    );

    switch (event._tag) {
      case "RunStarted": {
        break;
      }
      case "StepStarted": {
        check(!gateWaiting(), "no step starts while a gate waits");
        if (event.phase === "Main") {
          mainStarts(event.step);
          start("Main", event.step, event.item, event.attempt, event.idempotencyKey);
        } else {
          check(mainEnd !== undefined, "no finally step starts before MainPhaseEnded");
          check(
            !entries.some((entry) => entry.kind === "Undo" && entry.status === "Open"),
            "the finally phase starts once no undo is in flight",
          );
          finallyBegun = true;
          start("Finally", event.step, event.item, event.attempt, event.idempotencyKey);
        }
        break;
      }
      case "StepSucceeded": {
        end(["Main", "Finally"], event.step, event.item, event.attempt, "Succeeded");
        break;
      }
      case "StepFailed": {
        const status = event.retryable ? "FailedRetryable" : "Failed";
        end(["Main", "Finally"], event.step, event.item, event.attempt, status);
        break;
      }
      case "GateOpened": {
        check(!gateWaiting(), "no step starts while a gate waits");
        check(!anyOpen(), "a gate opens when nothing is in flight");
        mainStarts(event.step);
        check(forwardOf(event.step, undefined) === undefined, "a gate opens once");
        entries.push({
          kind: "Gate",
          step: event.step,
          item: undefined,
          attempt: event.attempt,
          status: "Open",
        });
        break;
      }
      case "ApprovalGranted":
      case "ApprovalDenied": {
        check(event.by.trim() !== "", "an approval or a denial records who");
        const status = event._tag === "ApprovalGranted" ? "Approved" : "Denied";
        end(["Gate"], event.step, undefined, event.attempt, status);
        break;
      }
      case "CancellationRequested": {
        cancelInEffect ||= mainEnd === undefined && !handling;
        break;
      }
      case "MainPhaseEnded": {
        check(mainEnd === undefined, "the main phase ends once");
        if (event.main.result === "Cancelled") {
          check(
            cancelInEffect && !handling,
            "the main phase ends Cancelled only after a cancel requested on the normal track",
          );
          // A gate that was waiting is closed by the cancel.
          for (const entry of entries) {
            if (entry.kind === "Gate" && entry.status === "Open") {
              entry.status = "Cancelled";
            }
          }
        }
        check(!anyOpen(), "the main phase ends when no main-phase attempt is open");
        mainEnd = event.main;
        break;
      }
      case "UndoStarted": {
        check(
          mainEnd !== undefined &&
            (mainEnd.result === "Cancelled" ||
              (mainEnd.result === "Failed" && mainEnd.undo === "Run")),
          "no undo runs unless the main phase ended Failed with undo, or Cancelled",
        );
        check(!finallyBegun, "undos run only before the finally phase");
        check(!anyOpen(), "undos run one at a time");
        const undone = find("Main", event.step, event.item);
        check(undone?.status === "Succeeded", "only work that succeeded is undone");
        const undos = entries.filter((entry) => entry.kind === "Undo");
        const latest = undos.at(-1);
        const existing = find("Undo", event.step, event.item);
        if (existing === undefined && latest !== undefined) {
          check(
            event.step === latest.step
              ? (event.item ?? 0) < (latest.item ?? 0)
              : position(event.step) < position(latest.step),
            "undos run in reverse order",
          );
        } else if (existing !== undefined) {
          check(existing === latest, "work is undone at most once, and retried only in place");
        }
        const forward = [...keys].find(
          ([, work]) => work === `Forward ${event.step} ${event.item}`,
        );
        check(forward?.[0] !== event.idempotencyKey, "an undo's key differs from its step's");
        start("Undo", event.step, event.item, event.attempt, event.idempotencyKey);
        break;
      }
      case "UndoSucceeded": {
        end(["Undo"], event.step, event.item, event.attempt, "Succeeded");
        break;
      }
      case "UndoFailed": {
        const status = event.retryable ? "FailedRetryable" : "Failed";
        end(["Undo"], event.step, event.item, event.attempt, status);
        break;
      }
      case "RunSucceeded":
      case "RunFailed":
      case "RunCancelled":
      case "RunFlaggedForAttention": {
        check(mainEnd !== undefined, "a run ends only after its main phase did");
        check(!anyOpen(), "a run ends when nothing is in flight");
        const cleanupFailed = entries.some(
          (entry) => (entry.kind === "Undo" || entry.kind === "Finally") && failed(entry.status),
        );
        const expected = cleanupFailed ? "RunFlaggedForAttention" : `Run${mainEnd?.result}`;
        check(
          event._tag === expected,
          "the final event is RunFlaggedForAttention exactly when a cleanup failed, and otherwise matches the main result",
        );
        ended = true;
        break;
      }
    }
  }
  return broken;
};

/** The tag of the state a log leads to, read off the log alone. */
export const stateTagOf = (log: ReadonlyArray<RunEvent>): string => {
  const last = log.at(-1);
  if (last === undefined) {
    return "NotStarted";
  }
  switch (last._tag) {
    case "RunSucceeded": {
      return "Succeeded";
    }
    case "RunFailed": {
      return "Failed";
    }
    case "RunCancelled": {
      return "Cancelled";
    }
    case "RunFlaggedForAttention": {
      return "NeedsAttention";
    }
    default: {
      break;
    }
  }
  const mainEnd = log.find((event) => event._tag === "MainPhaseEnded");
  if (mainEnd === undefined) {
    const opened = log.filter((event) => event._tag === "GateOpened").length;
    const closed = log.filter(
      (event) => event._tag === "ApprovalGranted" || event._tag === "ApprovalDenied",
    ).length;
    return opened > closed ? "WaitingForApproval" : "Running";
  }
  const undoes =
    mainEnd.main.result === "Cancelled" ||
    (mainEnd.main.result === "Failed" && mainEnd.main.undo === "Run");
  const finallyBegun = log.some(
    (event) => event._tag === "StepStarted" && event.phase === "Finally",
  );
  return undoes && !finallyBegun ? "Compensating" : "Finalizing";
};
