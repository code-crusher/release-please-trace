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

import {Scm} from './scm';
import {Repository} from './repository';
import {Commit} from './commit';
import {PullRequest} from './pull-request';
import {ReleasePullRequest} from './release-pull-request';
import {Update} from './update';
import {Release} from './release';
import {GitHubFileContents} from '@google-automations/git-file-utils';
import {
  ScmChangeSet,
  ScmCommitIteratorOptions,
  ScmCreatePullRequestOptions,
  ScmRelease,
  ScmReleaseIteratorOptions,
  ScmReleaseOptions,
  ScmTag,
  ScmTagIteratorOptions,
  ScmUpdatePullRequestOptions,
} from './scm';
import {logger as defaultLogger, Logger} from './util/logger';

/**
 * The names of the actions that are reported to notifiers. One notification
 * is sent after each mutating action performed through the Scm.
 */
export type NotifierAction =
  | 'create release'
  | 'create pull request'
  | 'update pull request'
  | 'comment on issue'
  | 'add issue labels'
  | 'remove issue labels'
  | 'create file on new branch';

/**
 * A notification about an action performed on the Scm. The payload is
 * intentionally JSON friendly so that it can be forwarded as-is, e.g.
 * `{"action": "create release", "data": {...}}`.
 */
export interface Notification {
  readonly action: NotifierAction;
  readonly data: unknown;
}

/**
 * Receives notifications about actions performed on the Scm, e.g. to
 * integrate with external systems like Jira.
 */
export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/**
 * Wraps an Scm and notifies the configured notifiers after every mutating
 * action is performed on the wrapped Scm. Read-only operations are forwarded
 * without notifying.
 *
 * Notifications are best-effort: a failing notifier logs a warning, but does
 * not fail the release.
 */
export class NotifyingScm implements Scm {
  readonly repository: Repository;
  private readonly scm: Scm;
  private readonly notifiers: Notifier[];
  private readonly logger: Logger;

  constructor(
    scm: Scm,
    notifiers: Notifier[] = [],
    logger: Logger = defaultLogger
  ) {
    this.scm = scm;
    this.repository = scm.repository;
    this.notifiers = notifiers;
    this.logger = logger;
  }

  private async notify(action: NotifierAction, data: unknown): Promise<void> {
    for (const notifier of this.notifiers) {
      try {
        await notifier.send({action, data});
      } catch (err) {
        this.logger.warn(`notifier failed for action '${action}': ${err}`);
      }
    }
  }

  getFileContents(path: string): Promise<GitHubFileContents> {
    return this.scm.getFileContents(path);
  }

  getFileContentsOnBranch(
    path: string,
    branch: string
  ): Promise<GitHubFileContents> {
    return this.scm.getFileContentsOnBranch(path, branch);
  }

  getFileJson<T>(path: string, branch: string): Promise<T> {
    return this.scm.getFileJson<T>(path, branch);
  }

  findFilesByFilename(filename: string, prefix?: string): Promise<string[]> {
    return this.scm.findFilesByFilename(filename, prefix);
  }

  findFilesByFilenameAndRef(
    filename: string,
    ref: string,
    prefix?: string
  ): Promise<string[]> {
    return this.scm.findFilesByFilenameAndRef(filename, ref, prefix);
  }

  findFilesByGlob(glob: string, prefix?: string): Promise<string[]> {
    return this.scm.findFilesByGlob(glob, prefix);
  }

  findFilesByGlobAndRef(
    glob: string,
    ref: string,
    prefix?: string
  ): Promise<string[]> {
    return this.scm.findFilesByGlobAndRef(glob, ref, prefix);
  }

  findFilesByExtension(extension: string, prefix?: string): Promise<string[]> {
    return this.scm.findFilesByExtension(extension, prefix);
  }

  findFilesByExtensionAndRef(
    extension: string,
    ref: string,
    prefix?: string
  ): Promise<string[]> {
    return this.scm.findFilesByExtensionAndRef(extension, ref, prefix);
  }

  async commitsSince(
    targetBranch: string,
    filter: (commit: Commit) => boolean,
    options?: ScmCommitIteratorOptions
  ): Promise<Commit[]> {
    return this.scm.commitsSince(targetBranch, filter, options);
  }

  mergeCommitIterator(
    targetBranch: string,
    options?: ScmCommitIteratorOptions
  ): AsyncGenerator<Commit, void, void> {
    return this.scm.mergeCommitIterator(targetBranch, options);
  }

  pullRequestIterator(
    targetBranch: string,
    status?: 'OPEN' | 'CLOSED' | 'MERGED',
    maxResults?: number,
    includeFiles?: boolean
  ): AsyncGenerator<PullRequest, void, void> {
    return this.scm.pullRequestIterator(
      targetBranch,
      status,
      maxResults,
      includeFiles
    );
  }

  releaseIterator(
    options?: ScmReleaseIteratorOptions
  ): AsyncGenerator<ScmRelease, void, void> {
    return this.scm.releaseIterator(options);
  }

  tagIterator(
    options?: ScmTagIteratorOptions
  ): AsyncGenerator<ScmTag, void, void> {
    return this.scm.tagIterator(options);
  }

  async createPullRequest(
    pullRequest: PullRequest,
    targetBranch: string,
    message: string,
    updates: Update[],
    options?: ScmCreatePullRequestOptions
  ): Promise<PullRequest> {
    const created = await this.scm.createPullRequest(
      pullRequest,
      targetBranch,
      message,
      updates,
      options
    );
    await this.notify('create pull request', created);
    return created;
  }

  async updatePullRequest(
    number: number,
    pullRequest: ReleasePullRequest,
    targetBranch: string,
    options?: ScmUpdatePullRequestOptions
  ): Promise<PullRequest> {
    const updated = await this.scm.updatePullRequest(
      number,
      pullRequest,
      targetBranch,
      options
    );
    await this.notify('update pull request', updated);
    return updated;
  }

  getPullRequest(number: number): Promise<PullRequest> {
    return this.scm.getPullRequest(number);
  }

  async createRelease(
    release: Release,
    options?: ScmReleaseOptions
  ): Promise<ScmRelease> {
    const created = await this.scm.createRelease(release, options);
    await this.notify('create release', created);
    return created;
  }

  async commentOnIssue(comment: string, number: number): Promise<string> {
    const url = await this.scm.commentOnIssue(comment, number);
    await this.notify('comment on issue', {number, comment, url});
    return url;
  }

  async removeIssueLabels(labels: string[], number: number): Promise<void> {
    await this.scm.removeIssueLabels(labels, number);
    await this.notify('remove issue labels', {number, labels});
  }

  async addIssueLabels(labels: string[], number: number): Promise<void> {
    await this.scm.addIssueLabels(labels, number);
    await this.notify('add issue labels', {number, labels});
  }

  generateReleaseNotes(
    tagName: string,
    targetCommitish: string,
    previousTag?: string
  ): Promise<string> {
    return this.scm.generateReleaseNotes(tagName, targetCommitish, previousTag);
  }

  async createFileOnNewBranch(
    filename: string,
    contents: string,
    newBranchName: string,
    baseBranchName: string
  ): Promise<string> {
    const url = await this.scm.createFileOnNewBranch(
      filename,
      contents,
      newBranchName,
      baseBranchName
    );
    await this.notify('create file on new branch', {
      filename,
      newBranchName,
      baseBranchName,
      url,
    });
    return url;
  }

  buildChangeSet(
    updates: Update[],
    defaultBranch: string
  ): Promise<ScmChangeSet> {
    return this.scm.buildChangeSet(updates, defaultBranch);
  }
}
