/**
 * Per-action (one skill use) record of statuses spent, shared by every passive / script / ability hook of that action.
 * Mirrors BattleActionModel.UsedBuffStack / UsedBuffTurn (+ a scratch map for cross-script flags).
 */
export type ActionSide = "actor" | "target";

export interface ActionRecord {
  /** Potency (stack) spent during the current skill use; owner defaults to "actor". */
  consumedStack(buffId: string, owner?: ActionSide): number;
  /** Count (turn) spent during the current skill use; owner defaults to "actor". */
  consumedTurn(buffId: string, owner?: ActionSide): number;
  /** Generic per-action scratch shared across scripts; cleared at skill start. */
  shared: Map<string, unknown>;
}

export interface MutableActionRecord extends ActionRecord {
  /** Record a reduction (called by StatusContainer consume listeners). */
  add(owner: ActionSide, buffId: string, stack: number, turn: number): void;
  reset(): void;
}

export function createActionRecord(): MutableActionRecord {
  const stack = new Map<string, number>();
  const turn = new Map<string, number>();
  const key = (o: ActionSide, id: string) => `${o}:${id}`;
  return {
    shared: new Map(),
    consumedStack: (id, owner = "actor") => stack.get(key(owner, id)) ?? 0,
    consumedTurn: (id, owner = "actor") => turn.get(key(owner, id)) ?? 0,
    add(owner, id, s, t) {
      const k = key(owner, id);
      if (s > 0) stack.set(k, (stack.get(k) ?? 0) + s);
      if (t > 0) turn.set(k, (turn.get(k) ?? 0) + t);
    },
    reset() {
      stack.clear();
      turn.clear();
      this.shared.clear();
    },
  };
}

/** Inert record for contexts outside a skill use. */
export const EMPTY_ACTION_RECORD: ActionRecord = {
  consumedStack: () => 0,
  consumedTurn: () => 0,
  /** Fresh map each access so nothing leaks between unrelated contexts. */
  get shared() {
    return new Map<string, unknown>();
  },
};
