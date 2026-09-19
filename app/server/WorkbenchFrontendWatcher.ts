/*
 * Exports:
 * - WorkbenchFrontendWatcherOptions: native subscriptions, rebuild work and diagnostic boundaries.
 * - default WorkbenchFrontendWatcher: own event-driven frontend rebuilds and subscription retirement.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import parcelWatcher from "@parcel/watcher";

export interface WorkbenchFrontendWatcherOptions {
  root: string;
  outputs: readonly string[];
  rebuild(): Promise<void>;
  onError(error: Error): void;
  subscribe?: typeof parcelWatcher.subscribe;
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export default class WorkbenchFrontendWatcher {
  private readonly root: string;
  private readonly ignored: string[];
  private readonly subscriptions = new Map<string, parcelWatcher.AsyncSubscription>();
  private dependencies = new Set<string>();
  private closed = false;
  private pending = false;
  private running: Promise<void> | null = null;

  constructor(private readonly options: WorkbenchFrontendWatcherOptions) {
    this.root = path.resolve(options.root);
    this.ignored = [
      path.join(this.root, ".git"),
      path.join(this.root, ".workbench"),
      ...options.outputs.map(output => path.resolve(output)),
    ];
  }

  async start() {
    await this.subscribe(this.root);
    if (this.closed) return;
    this.pending = true;
    await this.run();
  }

  async updateDependencies(inputs: readonly string[], resolutionDirectories: readonly string[], successful: boolean) {
    const dependencies = new Set([
      ...inputs.map(input => path.resolve(this.root, input)),
      ...resolutionDirectories.map(directory => path.resolve(this.root, directory)),
      ...(!successful ? this.dependencies : []),
    ]);
    const directories = new Set<string>();
    for (const dependency of dependencies) {
      if (contains(this.root, dependency)) continue;
      let directory = path.dirname(dependency);
      while (true) {
        try {
          if ((await stat(directory)).isDirectory()) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error("Cannot observe an external frontend dependency.");
        directory = parent;
      }
      directories.add(directory);
    }
    const roots = [...directories].filter(directory => ![...directories].some(other => other !== directory && contains(other, directory)));
    for (const directory of roots) {
      if (this.closed) return;
      if (!this.subscriptions.has(directory)) await this.subscribe(directory);
    }
    if (this.closed) return;
    this.dependencies = dependencies;
    for (const [directory, subscription] of this.subscriptions) {
      if (directory === this.root || roots.includes(directory)) continue;
      this.subscriptions.delete(directory);
      await subscription.unsubscribe();
    }
  }

  async close() {
    this.closed = true;
    this.pending = false;
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(subscriptions.map(subscription => subscription.unsubscribe()));
  }

  private async subscribe(directory: string) {
    const subscription = await (this.options.subscribe ?? parcelWatcher.subscribe)(
      directory,
      (error, events) => {
        if (this.closed) return;
        if (error) {
          this.options.onError(error);
          return;
        }
        if (!events.some(event => this.relevant(event))) return;
        this.pending = true;
        if (!this.running) void this.run().catch(error => {
          this.options.onError(error instanceof Error ? error : new Error(String(error)));
        });
      },
      { ignore: this.ignored },
    );
    if (this.closed) await subscription.unsubscribe();
    else this.subscriptions.set(directory, subscription);
  }

  private relevant(event: parcelWatcher.Event) {
    const absolute = path.resolve(event.path);
    if (this.ignored.some(ignored => contains(ignored, absolute))) return false;
    const relative = path.relative(this.root, absolute).replaceAll("\\", "/");
    if (["app/client", "shared", "node_modules", "app/node_modules"].some(root => relative === root || relative.startsWith(`${root}/`))) return true;
    if (["package.json", "tsconfig.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "app/package.json", "app/tsconfig.json"].includes(relative)) return true;
    return [...this.dependencies].some(dependency => (
      contains(dependency, absolute) || (event.type !== "update" && contains(absolute, dependency))
    ));
  }

  private run() {
    if (this.running) return this.running;
    const running = this.drain().finally(() => {
      this.running = null;
      if (this.pending && !this.closed) void this.run().catch(error => {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
      });
    });
    this.running = running;
    return running;
  }

  private async drain() {
    while (this.pending && !this.closed) {
      this.pending = false;
      await this.options.rebuild();
    }
  }
}
