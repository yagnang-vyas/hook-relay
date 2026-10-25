/** Minimal in-process counters, exposed through the authenticated admin API. */
export class Metrics {
  private readonly counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = Metrics.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  get(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(Metrics.key(name, labels)) ?? 0;
  }

  snapshot(): { name: string; labels: Record<string, string>; value: number }[] {
    return [...this.counters.entries()]
      .map(([key, value]) => {
        const parsed = JSON.parse(key) as [string, Record<string, string>];
        return { name: parsed[0], labels: parsed[1], value };
      })
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)),
      );
  }

  private static key(name: string, labels: Record<string, string>): string {
    const sorted = Object.fromEntries(
      Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)),
    );
    return JSON.stringify([name, sorted]);
  }
}
