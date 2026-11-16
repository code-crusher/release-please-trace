// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Commit} from '../commit';

/**
 * Returns the parent SHAs of a commit, or undefined if unknown.
 */
export type CommitParents = (commit: Commit) => string[] | undefined;

/**
 * Re-orders a stream of commits into topological order.
 *
 * GitHub's commit history APIs return commits sorted by commit date. That is
 * not a topological order: when a branch is merged without rebasing, its
 * commits keep their original (older) dates, so they can be listed *after*
 * commits that were merged later - including after a release commit. Callers
 * that stop iterating once they reach a known commit (e.g. the last release)
 * then silently skip the commits of that branch.
 *
 * This implements the same traversal as `git log --topo-order`: a commit is
 * only emitted once all of its children have been emitted, and the parents of
 * a merge commit are queued so that the merged-in branch is walked before the
 * first parent. Commits are added page by page, so the sorter stops when the
 * next commit's parent has not been fetched yet.
 */
export class CommitSorter {
  private readonly commits = new Map<string, Commit>();
  private readonly parents = new Map<string, string[]>();
  private readonly childCount = new Map<string, number>();
  private readonly emitted = new Set<string>();
  private readonly queue: string[] = [];
  // Commits for which no parent information was supplied cannot be ordered
  // relative to anything else; emit them in their original order once the
  // known graph has been walked.
  private readonly unordered: string[] = [];

  /**
   * Add a page of commits. Pages are expected in commit date order (newest
   * first), as returned by the GitHub APIs.
   *
   * @param {Commit[]} commits commits to add
   * @param {CommitParents} getParents returns the parent SHAs of a commit
   */
  add(commits: Commit[], getParents: CommitParents): void {
    const added: Commit[] = [];
    for (const commit of commits) {
      if (this.commits.has(commit.sha)) {
        continue;
      }
      this.commits.set(commit.sha, commit);
      if (!this.childCount.has(commit.sha)) {
        this.childCount.set(commit.sha, 0);
      }
      added.push(commit);
    }
    for (const commit of added) {
      const known = getParents(commit);
      if (!known) {
        this.unordered.push(commit.sha);
        continue;
      }
      const parents = known.filter(parent => parent !== commit.sha);
      this.parents.set(commit.sha, parents);
      for (const parent of parents) {
        this.childCount.set(parent, (this.childCount.get(parent) || 0) + 1);
      }
    }
    // The newest commit with known parents is the tip of the history: nothing
    // else can have it as a parent.
    if (this.queue.length === 0 && this.emitted.size === 0) {
      const tip = commits.find(
        commit =>
          this.parents.has(commit.sha) &&
          (this.childCount.get(commit.sha) || 0) === 0
      );
      if (tip) {
        this.queue.push(tip.sha);
      }
    }
  }

  /**
   * Emit the next commit in topological order.
   *
   * @returns {Commit | undefined} the next commit, or undefined if more
   *   commits need to be added before the next one can be determined
   */
  next(): Commit | undefined {
    while (this.queue.length > 0) {
      const sha = this.queue.pop() as string;
      const commit = this.commits.get(sha);
      if (!commit) {
        // The parent has not been fetched yet.
        this.queue.push(sha);
        return undefined;
      }
      if ((this.childCount.get(sha) || 0) > 0) {
        // A child still has to be emitted before this commit.
        this.queue.push(sha);
        return undefined;
      }
      this.emitted.add(sha);
      // Push the parents in order so the last one is popped first. This walks
      // the merged-in branch before the first parent, like git does.
      for (const parent of this.parents.get(sha) || []) {
        this.childCount.set(parent, (this.childCount.get(parent) || 0) - 1);
        if ((this.childCount.get(parent) || 0) === 0) {
          this.queue.push(parent);
        }
      }
      return commit;
    }
    // Commits with unknown parents cannot be ordered against the graph, so
    // emit them in their original order once the graph is exhausted.
    if (this.unordered.length > 0) {
      const sha = this.unordered.shift() as string;
      this.emitted.add(sha);
      return this.commits.get(sha);
    }
    return undefined;
  }

  /**
   * Emit every remaining commit once the history has been exhausted. This
   * guarantees that commits are not lost when they are not reachable from the
   * tip of the fetched history (e.g. a truncated or shallow history).
   *
   * @returns {Commit[]} the remaining commits, in the order they were added
   */
  flush(): Commit[] {
    const remaining: Commit[] = [];
    for (const commit of this.commits.values()) {
      if (!this.emitted.has(commit.sha)) {
        this.emitted.add(commit.sha);
        remaining.push(commit);
      }
    }
    this.queue.length = 0;
    return remaining;
  }
}
