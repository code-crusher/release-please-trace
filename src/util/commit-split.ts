// Copyright 2019 Google LLC
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
import {ROOT_PROJECT_PATH} from '../manifest';
import {normalizePath, normalizePaths} from './commit-utils';

export interface CommitSplitOptions {
  // Include empty git commits: each empty commit is included
  // in the list of commits for each path.
  // This allows using the `git commit --allow-empty` workflow
  // of setting a package's version without changing source code.
  // For example the following empty commit would bump the minor
  // version for all packages:
  //
  // "feat: bump all the versions"
  //
  // And this commit would set all package versions to 7.7.7
  //
  // "chore: bump all the versions
  //
  // release-as: 7.7.7"
  includeEmpty?: boolean;
  // rather than split by top level folder, split by these package
  // paths (e.g. ["packages/pkg1", "python/pkg1"]). Commits that
  // only touch files under paths not specified here are ignored.
  // Paths must be unique and non-overlapping.
  //
  // Each package path can be associated with a list of additional
  // paths (e.g. {"packages/pkg1": ["common/shared"]}). Commits that
  // touch files under an additional path are collected for that
  // package as well.
  //
  // NOTE: GitHub API always returns paths using the `/` separator, regardless
  // of what platform the client code is running on
  packagePaths?: Record<string, string[]>;
}

/**
 * Helper class for splitting commits by component path. If `packagePaths`
 * is configured, then only consider the provided paths. If `includeEmpty`
 * is configured, then commits without any touched files apply to all
 * configured component paths.
 */
export class CommitSplit {
  includeEmpty: boolean;
  packagePaths?: Record<string, string[]>;
  constructor(opts?: CommitSplitOptions) {
    opts = opts || {};
    this.includeEmpty = !!opts.includeEmpty;
    if (opts.packagePaths) {
      const normalizedPackagePaths: Record<string, string[]> = {};
      for (const path in opts.packagePaths) {
        const normalizedPath = normalizePath(path);
        // The special "." path, representing the root of the module, should be
        // ignored by commit-split as it is assigned all commits in manifest.ts
        if (normalizedPath === ROOT_PROJECT_PATH) {
          continue;
        }
        normalizedPackagePaths[normalizedPath] = normalizePaths(
          opts.packagePaths[path]
        );
      }
      // sort by longest paths first, so that the first matching package is
      // the most specific one
      const sortedPaths = Object.keys(normalizedPackagePaths).sort(
        (a, b) => b.length - a.length
      );
      this.packagePaths = {};
      for (const path of sortedPaths) {
        this.packagePaths[path] = normalizedPackagePaths[path];
      }
    }
  }

  /**
   * Split commits by component path. If the commit splitter is configured
   * with a set of tracked package paths, then only consider paths for
   * configured components. If `includeEmpty` is configured, then a commit
   * that does not touch any files will be applied to all components'
   * commits.
   *
   * If a package is configured with additional paths, then commits touching
   * those paths are collected for the package in addition to the commits
   * under the package's own path.
   * @param {Commit[]} commits The commits to split
   * @returns {Record<string, Commit[]>} Commits indexed by component path
   */
  split<T extends Commit>(commits: T[]): Record<string, T[]> {
    const splitCommits: Record<string, T[]> = {};
    commits.forEach(commit => {
      if (commit.files === undefined) {
        throw new Error(
          `Commit ${commit.sha} is missing files. Did you set "backfillFiles" to "true"?`
        );
      }
      const dedupe: Set<string> = new Set();
      for (let i = 0; i < commit.files.length; i++) {
        const file: string = commit.files[i];
        // NOTE: GitHub API always returns paths using the `/` separator,
        // regardless of what platform the client code is running on
        const splitPath = file.split('/');
        // indicates that we have a top-level file and not a folder
        // in this edge-case we should not attempt to update the path.
        if (splitPath.length === 1) continue;

        // First match the file against the packages' own paths. Paths are
        // sorted by longest first, so the first match is the most specific
        // package (e.g. with packages ["core", "core/lib"], a file under
        // "core/lib" is only assigned to "core/lib").
        let pkgName;
        if (this.packagePaths) {
          // only track paths under this.packagePaths
          pkgName = this.findPackagePath(file);
        } else {
          // track paths by top level folder
          pkgName = splitPath[0];
        }
        if (pkgName) {
          this.addCommitToPackage(splitCommits, pkgName, commit, dedupe);
        }

        // Then also collect the commit for any packages that have configured
        // one of the touched paths as an additional path, e.g. shared code
        // consumed by multiple packages. Each package gets the commit at
        // most once - `dedupe` guards against a package receiving it via
        // both its own path and an additional path.
        if (this.packagePaths) {
          for (const pkgNameForAdditional in this.packagePaths) {
            const additionalPaths = this.packagePaths[pkgNameForAdditional];
            if (additionalPaths.some(path => file.indexOf(`${path}/`) === 0)) {
              this.addCommitToPackage(
                splitCommits,
                pkgNameForAdditional,
                commit,
                dedupe
              );
            }
          }
        }
      }
      if (commit.files.length === 0 && this.includeEmpty) {
        if (this.packagePaths) {
          for (const pkgName of Object.keys(this.packagePaths)) {
            splitCommits[pkgName] = splitCommits[pkgName] || [];
            splitCommits[pkgName].push(commit);
          }
        } else {
          for (const pkgName in splitCommits) {
            splitCommits[pkgName].push(commit);
          }
        }
      }
    });
    return splitCommits;
  }

  private findPackagePath(file: string): string | undefined {
    if (!this.packagePaths) {
      return undefined;
    }
    for (const pkgName in this.packagePaths) {
      if (file.indexOf(`${pkgName}/`) === 0) {
        return pkgName;
      }
    }
    return undefined;
  }

  private addCommitToPackage<T extends Commit>(
    splitCommits: Record<string, T[]>,
    pkgName: string,
    commit: T,
    dedupe: Set<string>
  ) {
    if (dedupe.has(pkgName)) return;
    dedupe.add(pkgName);
    if (!splitCommits[pkgName]) splitCommits[pkgName] = [];
    splitCommits[pkgName].push(commit);
  }
}
