/**
 * A backstop against runaway switching, should limit detection ever misfire turn after turn. Only
 * moves that actually happened count, so real limits can move an agent whenever one hits.
 */
export class SwitchGuard {
  private readonly moves = new Map<string, number[]>();

  constructor(
    readonly limit = 4,
    readonly windowMs = 10 * 60_000,
  ) {}

  allows(agentId: string, now: number): boolean {
    return this.recent(agentId, now).length < this.limit;
  }

  note(agentId: string, now: number): void {
    this.moves.set(agentId, [...this.recent(agentId, now), now]);
  }

  forget(agentId: string): void {
    this.moves.delete(agentId);
  }

  private recent(agentId: string, now: number): number[] {
    return (this.moves.get(agentId) ?? []).filter((at) => now - at < this.windowMs);
  }
}
