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

import {describe, it} from 'mocha';
import {expect} from 'chai';
import {CommitSorter} from '../../src/util/commit-order';
import {Commit} from '../../src/commit';

interface TestCommit extends Commit {
  parents: string[];
}

function commit(sha: string, ...parents: string[]): TestCommit {
  return {sha, message: `commit ${sha}`, parents};
}

/**
 * Feed the commits to a sorter in pages, draining it between pages the same
 * way the commit iterator does.
 */
function sortInPages(
  pages: TestCommit[][],
  getParents: (commit: Commit) => string[] | undefined = c =>
    (c as TestCommit).parents
): string[] {
  const sorter = new CommitSorter();
  const shas: string[] = [];
  const drain = () => {
    for (;;) {
      const next = sorter.next();
      if (!next) {
        return;
      }
      shas.push(next.sha);
    }
  };
  for (const page of pages) {
    sorter.add(page, getParents);
    drain();
  }
  for (const remaining of sorter.flush()) {
    shas.push(remaining.sha);
  }
  return shas;
}

describe('CommitSorter', () => {
  it('preserves input order when parent information is unavailable', () => {
    const commits = [commit('c'), commit('b'), commit('a')];
    expect(sortInPages([commits], () => undefined)).to.eql(['c', 'b', 'a']);
  });

  it('sorts a linear history', () => {
    const commits = [commit('c', 'b'), commit('b', 'a'), commit('a')];
    expect(sortInPages([commits])).to.eql(['c', 'b', 'a']);
  });

  it('walks a merged branch before the first parent', () => {
    //   d (merge) <- parents are c (release) and b (feature)
    //   c <- b
    //   b
    const commits = [commit('d', 'c', 'b'), commit('c', 'b'), commit('b')];
    expect(sortInPages([commits])).to.eql(['d', 'c', 'b']);
  });

  it('orders commits from a branch merged after a release topologically', () => {
    // Reproduction of #1533. The date-ordered API returns the commits of the
    // feature branch (which kept their original, older dates) after the
    // release commit, even though the merge brought them in afterwards.
    const dateOrdered = [
      commit('merge-foo', 'release', 'foo2'),
      commit('release', 'merge-bar'),
      commit('merge-bar', 'base', 'bar1'),
      commit('foo2', 'foo1'),
      commit('base'),
      commit('bar1', 'base'),
      commit('foo1', 'base'),
    ];
    expect(sortInPages([dateOrdered])).to.eql([
      'merge-foo',
      'foo2',
      'foo1',
      'release',
      'merge-bar',
      'bar1',
      'base',
    ]);
  });

  it('waits for parents that arrive on a later page', () => {
    const pages = [[commit('d', 'c', 'b')], [commit('c', 'b')], [commit('b')]];
    expect(sortInPages(pages)).to.eql(['d', 'c', 'b']);
  });

  it('holds back a commit until all of its children are emitted', () => {
    // b has two children: c (first parent of d) and e (second parent of d).
    const commits = [
      commit('d', 'c', 'e'),
      commit('c', 'b'),
      commit('e', 'b'),
      commit('b'),
    ];
    // As with `git log --topo-order`, the branch merged in (the non-first
    // parent) is walked before the first parent.
    const sorted = sortInPages([commits]);
    expect(sorted).to.eql(['d', 'e', 'c', 'b']);
  });

  it('flushes commits whose parents were never provided', () => {
    const commits = [commit('b', 'missing'), commit('a')];
    const sorted = sortInPages([commits]);
    expect(sorted).to.include('b');
    expect(sorted).to.include('a');
  });
});
