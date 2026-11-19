import { type FSWatcher, watch } from "node:fs";
import type { RuleSet } from "../core/rules/evaluate.ts";
import { hasErrnoCode } from "../util/errno.ts";
import {
  type LoadedRules,
  loadRuleFiles,
  ORG_RULES_FILE,
  OWNER_RULES_DIR,
  type RulesLoad,
  type RulesPaths,
} from "./rules.ts";
import { YamlValidationError } from "./yaml.ts";

/**
 * Hot reload (spec: Rules, "Loading, testing and reload"). heel watches the
 * rules files and swaps the whole set in at once. An invalid owner file keeps
 * that owner's last good rules while everyone else's edits apply; an invalid
 * org file keeps the whole last good set, since org rules bound every owner.
 * With no valid set since boot, every call is denied.
 */

export type ReloadOutcome =
  | { ok: true; loaded: LoadedRules }
  | {
      ok: false;
      error: YamlValidationError;
      /** A previously loaded set is still in force; false means calls are denied. */
      keptLastGood: boolean;
      /**
       * Owners whose last good rules were kept while every other file's
       * edits applied. Empty when nothing new applied.
       */
      heldOwners: readonly string[];
    };

/** Holds the rule set in force. The pipeline reads `set` once per call. */
export class RulesHolder {
  readonly paths: RulesPaths;
  readonly #load: (paths: RulesPaths) => RulesLoad;
  #loaded: LoadedRules | null = null;
  #lastError: YamlValidationError | null = null;

  constructor(paths: RulesPaths, load: (paths: RulesPaths) => RulesLoad = loadRuleFiles) {
    this.paths = paths;
    this.#load = load;
  }

  /** The set in force, or null when none has loaded since boot, which denies every call. */
  get set(): RuleSet | null {
    return this.#loaded?.set ?? null;
  }

  get loaded(): LoadedRules | null {
    return this.#loaded;
  }

  /** Why the latest load failed; null once a load succeeds. */
  get lastError(): YamlValidationError | null {
    return this.#lastError;
  }

  /**
   * Loads every file, then swaps the new set in with one assignment, so no
   * call ever sees part of an edit. Only invalid rules are an outcome here;
   * anything else is a fault in heel and throws, leaving the set unchanged.
   */
  reload(): ReloadOutcome {
    const { errors, failed, ...loaded } = this.#load(this.paths);
    if (errors.length === 0) {
      this.#loaded = loaded;
      this.#lastError = null;
      return { ok: true, loaded };
    }
    const error = new YamlValidationError(errors);
    this.#lastError = error;
    const last = this.#loaded;
    // Before any good set, or with the org file or rules/ unreadable, nothing
    // in this load can be trusted on its own: keep everything as it was.
    if (last === null || failed.org || failed.ownersDir) {
      return { ok: false, error, keptLastGood: last !== null, heldOwners: [] };
    }
    const held = [...failed.owners].sort();
    const owners = new Map(loaded.set.owners);
    const files = [...loaded.files];
    for (const user of held) {
      const previous = last.set.owners.get(user);
      if (previous === undefined) continue;
      owners.set(user, previous);
      const summary = last.files.find((file) => file.user === user);
      if (summary !== undefined) files.push(summary);
    }
    this.#loaded = { set: { org: loaded.set.org, owners }, files, warnings: loaded.warnings };
    return { ok: false, error, keptLastGood: true, heldOwners: held };
  }
}

export interface WatchRulesOptions {
  /** Called after each reload a file change triggers. */
  onReload(outcome: ReloadOutcome): void;
  /**
   * A watcher or reload fault that isn't a rules problem. The last good set
   * keeps deciding; the caller must surface this, since edits may now go
   * unnoticed until the next change or restart.
   */
  onError(error: unknown): void;
  /** Editors write a file in several steps; one reload follows the last of them. */
  debounceMs?: number;
}

export interface RulesWatcher {
  close(): void;
}

/**
 * Watches `$HEEL_HOME` (for `org-rules.yaml` and the `rules/` directory
 * itself) and `rules/` (for the owner files). Watching directories rather
 * than files survives editors that save by writing a temporary file and
 * renaming it over the original. A watcher that can't start throws, so the
 * caller knows hot reload is off.
 */
export function watchRules(holder: RulesHolder, options: WatchRulesOptions): RulesWatcher {
  const debounceMs = options.debounceMs ?? 100;
  let timer: NodeJS.Timeout | null = null;
  let owners: FSWatcher | null = null;
  let closed = false;

  const reload = () => {
    timer = null;
    if (closed) return;
    try {
      options.onReload(holder.reload());
    } catch (error) {
      options.onError(error);
    }
  };

  const schedule = () => {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  };

  /** (Re)attaches to `rules/`, which may be created, deleted or replaced while heel runs. */
  const watchOwners = () => {
    owners?.close();
    owners = null;
    try {
      const watcher = watch(holder.paths.ownersDir, schedule);
      watcher.on("error", (error) => {
        watcher.close();
        if (owners === watcher) owners = null;
        options.onError(error);
      });
      owners = watcher;
    } catch (error) {
      // No rules/ yet: the home watcher re-attaches when it appears.
      if (!hasErrnoCode(error, "ENOENT")) options.onError(error);
    }
  };

  const home = watch(holder.paths.home, (_event, filename) => {
    // Without a filename the change could be anything; reload to be safe.
    if (filename === null || filename === OWNER_RULES_DIR) {
      watchOwners();
      schedule();
    } else if (filename === ORG_RULES_FILE) {
      schedule();
    }
  });
  home.on("error", (error) => options.onError(error));
  watchOwners();

  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      owners?.close();
      owners = null;
      home.close();
    },
  };
}
