// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {Octokit} from '@octokit/rest';
import {RequestError} from '@octokit/request-error';
import {
  Scm,
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
import {Repository} from './repository';
import {Commit} from './commit';
import {PullRequest} from './pull-request';
import {ReleasePullRequest} from './release-pull-request';
import {Update} from './update';
import {Release} from './release';
import {
  GitHubFileContents,
  DEFAULT_FILE_MODE,
  FileNotFoundError as MissingFileError,
  RepositoryFileCache,
} from '@google-automations/git-file-utils';
import {
  GitHubAPIError,
  DuplicateReleaseError,
  FileNotFoundError,
} from './errors';
import {logger as defaultLogger} from './util/logger';
import {Logger} from './util/code-suggester/types';
import {ROOT_PROJECT_PATH} from './manifest';
import {signoffCommitMessage} from './util/signoff-commit-message';
import {mergeUpdates} from './updaters/composite';

export const GITEA_API_VERSION = 'v1';
export const GITEA_API_PREFIX = `/api/${GITEA_API_VERSION}`;

/**
 * Default number of items requested per page when paginating through
 * Gitea/Forgejo list endpoints.
 */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Gitea/Forgejo instances cap list responses at 50 items by default
 * (`MAX_RESPONSE_ITEMS`). Requesting more is silently truncated, which
 * would break the "full page means more pages" pagination heuristic, so
 * never ask for more than this.
 */
const MAX_PAGE_SIZE = 50;

/**
 * Tolerated clock skew (in milliseconds) when comparing commit and pull
 * request timestamps. A pull request can only reference a commit created
 * before it was merged, but the timestamps are recorded by different
 * systems and rounded to the second.
 */
const TIMESTAMP_SKEW_MS = 5_000;

/**
 * Gitea/Forgejo mark pull requests as drafts by prefixing the title with
 * a work-in-progress marker rather than exposing a dedicated draft flag.
 */
const DRAFT_PR_PREFIX = 'WIP: ';

export interface GiteaCreateOptions {
  owner: string;
  repo: string;
  defaultBranch?: string;
  /**
   * Base URL of the Gitea/Forgejo instance, e.g. `https://gitea.com` or
   * `https://codeberg.org`. The API paths below are appended to this URL.
   */
  baseUrl: string;
  token?: string;
  octokit?: Octokit;
  logger?: Logger;
  fetch?: any;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface GiteaResponse<T = any> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

interface GiteaRepository {
  default_branch: string;
  full_name?: string;
  html_url?: string;
}

interface GiteaCommit {
  sha: string;
  created?: string;
  commit: {
    message: string;
    author?: {name?: string; email?: string};
  };
  author?: {login?: string; email?: string};
  files?: {filename: string}[];
}

interface GiteaLabel {
  id: number;
  name: string;
}

interface GiteaPullRequest {
  number: number;
  title: string;
  body?: string;
  state: string;
  merged: boolean;
  merged_at?: string;
  merge_commit_sha?: string;
  draft?: boolean;
  base?: {ref?: string; sha?: string};
  head?: {ref?: string; sha?: string; repo?: {full_name?: string}};
  labels?: GiteaLabel[];
}

interface GiteaRelease {
  id: number;
  name?: string;
  tag_name: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url: string;
  target_commitish: string;
  created_at: string;
}

interface GiteaTag {
  name: string;
  id: string;
  commit?: {sha: string};
  message?: string;
}

interface GiteaContentsResponse {
  type: string;
  path: string;
  sha: string;
  mode?: string;
  content?: string;
  encoding?: string;
}

interface GiteaCreateFileOptions {
  branch?: string;
  new_branch?: string;
  message?: string;
  content?: string;
  sha?: string;
  force_push?: boolean;
}

interface GiteaChangeFileOperation {
  operation: 'create' | 'update';
  path: string;
  content?: string;
  sha?: string;
}

interface GiteaChangeFilesOptions extends GiteaCreateFileOptions {
  files: GiteaChangeFileOperation[];
}

interface GiteaCreatePullRequestOption {
  title: string;
  body?: string;
  base: string;
  head: string;
}

interface GiteaCreateReleaseOption {
  tag_name: string;
  target_commitish?: string;
  name?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface GiteaIssueLabelsOption {
  labels: number[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Iterate over the pages of a Gitea/Forgejo list endpoint.
 *
 * Gitea paginates list endpoints with `page`/`limit` query parameters.
 * Endpoints signal the last page inconsistently: some send an
 * `x-hasmore: false` response header, some only send an RFC-5988 `link`
 * header without a `rel="next"` relation, and some send no pagination
 * headers at all.
 */
async function* paginateGitea<T>(
  requestPage: (page: number, limit: number) => Promise<GiteaResponse<T[]>>,
  options: {maxResults?: number; pageSize?: number} = {}
): AsyncGenerator<T, void, void> {
  const maxResults = options.maxResults ?? Number.MAX_SAFE_INTEGER;
  const pageSize = Math.min(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  let page = 1;
  let results = 0;
  while (results < maxResults) {
    const response = await requestPage(page, pageSize);
    const items = response.data || [];
    if (items.length === 0) {
      return;
    }
    for (const item of items) {
      if (results >= maxResults) {
        return;
      }
      results += 1;
      yield item;
    }
    if (hasMorePages(response.headers, items.length, pageSize)) {
      page += 1;
    } else {
      return;
    }
  }
}

function hasMorePages(
  headers: Record<string, string> = {},
  items: number,
  pageSize: number
): boolean {
  const hasMore = headers['x-hasmore'];
  if (hasMore !== undefined) {
    return hasMore.toLowerCase() === 'true';
  }
  const link = headers['link'];
  if (link !== undefined) {
    return link.includes('rel="next"');
  }
  // No pagination headers at all (notably the tags endpoint): assume there
  // are more pages until a partial page is returned.
  return items === pageSize;
}

/**
 * Gitea implements the Scm interface using the Gitea/Forgejo v1 REST API.
 *
 * Gitea's API is GitHub-like but does not support GraphQL, so commits are
 * fetched via the commit list endpoint and associated pull requests are
 * streamed from the pull request list endpoint alongside them.
 */
export class Gitea implements Scm {
  readonly repository: Repository;
  private baseUrl: string;
  private token?: string;
  private octokit: Octokit;
  private fileCache: RepositoryFileCache;
  private fetchFn: any;
  private logger: Logger;
  private labelsById?: Map<number, string>;

  private constructor(options: GiteaCreateOptions & {octokit: Octokit}) {
    this.repository = {
      owner: options.owner,
      repo: options.repo,
      defaultBranch: options.defaultBranch as string,
    };
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.octokit = options.octokit;
    this.fileCache = new RepositoryFileCache(this.octokit, this.repository);
    this.fetchFn = options.fetch;
    this.logger = options.logger ?? defaultLogger;
  }

  static async create(options: GiteaCreateOptions): Promise<Gitea> {
    const baseUrl = options.baseUrl.replace(/\/$/, '');
    let defaultBranch = options.defaultBranch;
    if (!defaultBranch) {
      const repository = await Gitea.request<GiteaRepository>(
        baseUrl,
        'GET',
        `/repos/${options.owner}/${options.repo}`,
        options.token,
        undefined,
        options.fetch
      );
      defaultBranch = repository.data.default_branch;
    }
    const octokit =
      options.octokit ??
      new Octokit({
        baseUrl: `${baseUrl}${GITEA_API_PREFIX}`,
        auth: options.token,
        request: {fetch: options.fetch},
      });
    return new Gitea({...options, defaultBranch, octokit});
  }

  private async request<T>(
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>
  ): Promise<GiteaResponse<T>> {
    return Gitea.request<T>(
      this.baseUrl,
      method,
      path,
      this.token,
      body,
      this.fetchFn,
      headers
    );
  }

  private static async request<T>(
    baseUrl: string,
    method: string,
    path: string,
    token?: string,
    body?: object,
    fetchFn?: any,
    headers?: Record<string, string>
  ): Promise<GiteaResponse<T>> {
    const url = `${baseUrl}${GITEA_API_PREFIX}${path}`;
    const requestHeaders: Record<string, string> = {
      accept: 'application/json',
      ...headers,
    };
    if (token) {
      requestHeaders.authorization = `token ${token}`;
    }
    let response: any;
    try {
      response = await (fetchFn ?? globalThis.fetch)(url, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`Gitea request failed: ${url} ${(e as Error).message}`);
    }
    let data: any = undefined;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
    }
    if (response.status >= 400) {
      const message =
        (typeof data === 'object' && data?.message) ||
        (typeof data === 'string' && data) ||
        `Gitea request failed: ${method} ${path}`;
      const error = new RequestError(
        `${message} (${response.status})`,
        response.status,
        {
          request: {
            method: method as 'GET',
            url,
            headers: requestHeaders,
            body,
          },
          response: {
            status: response.status,
            url,
            headers: response.headers,
            data,
          },
        }
      );
      if (
        response.status === 409 &&
        typeof data?.message === 'string' &&
        /already exist/i.test(data.message)
      ) {
        throw new DuplicateReleaseError(error, '');
      }
      throw new GitHubAPIError(error);
    }
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries?.() ?? []) {
      responseHeaders[key.toLowerCase()] = value;
    }
    return {data, status: response.status, headers: responseHeaders};
  }

  /**
   * Find the numeric identifiers of the named repository labels. Gitea's
   * issue label APIs work with label IDs rather than names, so fetch the
   * label list (at most once) and match by name.
   */
  private async findLabelIds(names: string[]): Promise<number[]> {
    if (names.length === 0) {
      return [];
    }
    if (!this.labelsById) {
      this.labelsById = new Map();
      const owner = this.repository.owner;
      const repo = this.repository.repo;
      const iterator = paginateGitea<GiteaLabel>(
        (page, limit) =>
          this.request<GiteaLabel[]>(
            'GET',
            `/repos/${owner}/${repo}/labels?page=${page}&limit=${limit}`
          ),
        {pageSize: DEFAULT_PAGE_SIZE}
      );
      for await (const label of iterator) {
        this.labelsById.set(label.id, label.name);
      }
    }
    const ids: number[] = [];
    for (const name of names) {
      for (const [id, labelName] of this.labelsById) {
        if (labelName === name) {
          ids.push(id);
        }
      }
    }
    return ids;
  }

  /**
   * Fetch a single page of commits from the target branch.
   */
  private async getCommits(
    sha: string,
    page: number,
    limit: number
  ): Promise<GiteaResponse<GiteaCommit[]>> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const params = new URLSearchParams({
      sha,
      page: `${page}`,
      limit: `${limit}`,
      // include the list of files touched by each commit
      files: 'true',
      // skip the per-commit diff stats and signature verification - they
      // are not needed and slow down the response considerably
      stat: 'false',
      verification: 'false',
    });
    return this.request<GiteaCommit[]>(
      'GET',
      `/repos/${owner}/${repo}/commits?${params.toString()}`
    );
  }

  private async toPullRequest(
    pullRequest: GiteaPullRequest,
    options: {includeFiles: boolean}
  ): Promise<PullRequest> {
    let files: string[] = [];
    if (options.includeFiles) {
      const response = await this.request<{filename: string}[]>(
        'GET',
        `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${pullRequest.number}/files?limit=${DEFAULT_PAGE_SIZE}`
      );
      files = (response.data || []).map(file => file.filename);
    }
    return this.toPullRequestData(pullRequest, files);
  }

  private toPullRequestData(
    pullRequest: GiteaPullRequest,
    files: string[]
  ): PullRequest {
    const labels = (pullRequest.labels || []).map(label => label.name);
    return {
      headBranchName: pullRequest.head?.ref || '',
      baseBranchName: pullRequest.base?.ref || '',
      number: pullRequest.number,
      mergeCommitOid: pullRequest.merge_commit_sha,
      title: stripDraftMarker(pullRequest.title),
      body: pullRequest.body || '',
      labels,
      files,
      sha: pullRequest.merge_commit_sha || pullRequest.base?.sha,
    };
  }

  async getFileContents(path: string): Promise<GitHubFileContents> {
    return await this.getFileContentsOnBranch(
      path,
      this.repository.defaultBranch
    );
  }

  async getFileContentsOnBranch(
    path: string,
    branch: string
  ): Promise<GitHubFileContents> {
    this.logger.debug(`Fetching ${path} from branch ${branch}`);
    try {
      return await this.fileCache.getFileContents(path, branch);
    } catch (e) {
      if (e instanceof MissingFileError) {
        throw new FileNotFoundError(path);
      }
      throw e;
    }
  }

  async getFileJson<T>(path: string, branch: string): Promise<T> {
    const content = await this.getFileContentsOnBranch(path, branch);
    return JSON.parse(content.parsedContent);
  }

  async findFilesByFilename(
    filename: string,
    prefix?: string
  ): Promise<string[]> {
    return this.findFilesByFilenameAndRef(
      filename,
      this.repository.defaultBranch,
      prefix
    );
  }

  async findFilesByFilenameAndRef(
    filename: string,
    ref: string,
    prefix?: string
  ): Promise<string[]> {
    if (prefix) {
      prefix = normalizePrefix(prefix);
    }
    this.logger.debug(
      `finding files by filename: ${filename}, ref: ${ref}, prefix: ${prefix}`
    );
    return await this.fileCache.findFilesByFilename(filename, ref, prefix);
  }

  async findFilesByGlob(glob: string, prefix?: string): Promise<string[]> {
    return this.findFilesByGlobAndRef(
      glob,
      this.repository.defaultBranch,
      prefix
    );
  }

  async findFilesByGlobAndRef(
    glob: string,
    ref: string,
    prefix?: string
  ): Promise<string[]> {
    if (prefix) {
      prefix = normalizePrefix(prefix);
    }
    this.logger.debug(
      `finding files by glob: ${glob}, ref: ${ref}, prefix: ${prefix}`
    );
    return await this.fileCache.findFilesByGlob(glob, ref, prefix);
  }

  async findFilesByExtension(
    extension: string,
    prefix?: string
  ): Promise<string[]> {
    return this.findFilesByExtensionAndRef(
      extension,
      this.repository.defaultBranch,
      prefix
    );
  }

  async findFilesByExtensionAndRef(
    extension: string,
    ref: string,
    prefix?: string
  ): Promise<string[]> {
    if (prefix) {
      prefix = normalizePrefix(prefix);
    }
    this.logger.debug(
      `finding files by extension: ${extension}, ref: ${ref}, prefix: ${prefix}`
    );
    return await this.fileCache.findFilesByExtension(extension, ref, prefix);
  }

  async commitsSince(
    targetBranch: string,
    filter: (commit: Commit) => boolean,
    options?: ScmCommitIteratorOptions
  ): Promise<Commit[]> {
    const commits: Commit[] = [];
    const generator = this.mergeCommitIterator(targetBranch, options);
    for await (const commit of generator) {
      if (filter(commit)) {
        break;
      }
      commits.push(commit);
    }
    return commits;
  }

  async *mergeCommitIterator(
    targetBranch: string,
    options: ScmCommitIteratorOptions = {}
  ): AsyncGenerator<Commit, void, void> {
    const maxResults = options.maxResults ?? Number.MAX_SAFE_INTEGER;
    const batchSize = options.batchSize ?? DEFAULT_PAGE_SIZE;
    const commitIterator = paginateGitea<GiteaCommit>(
      (page, limit) => this.getCommits(targetBranch, page, limit),
      {maxResults, pageSize: batchSize}
    );
    // Merge commits are listed newest first. Rather than looking up the
    // associated pull request for each commit individually (one request per
    // commit), lazily stream merged pull requests alongside the commits and
    // join them on the merge commit SHA - both lists are ordered newest
    // first, so this takes a bounded number of extra requests regardless of
    // how many commits are examined.
    const pullRequestIterator = this.streamMergedPullRequests(
      targetBranch,
      maxResults
    );
    const pullRequestBuffer: GiteaPullRequest[] = [];
    const pullRequestsByMergeSha = new Map<string, GiteaPullRequest>();
    for await (const giteaCommit of commitIterator) {
      const pullRequest = await this.findPullRequestForCommit(
        giteaCommit,
        pullRequestIterator,
        pullRequestBuffer,
        pullRequestsByMergeSha
      );
      yield this.toCommit(giteaCommit, pullRequest);
    }
  }

  /**
   * Stream merged pull requests targeting the given base branch, newest
   * first. Closed-but-unmerged pull requests are skipped so that they do not
   * advance the join cursor used by `findPullRequestForCommit`.
   */
  private async *streamMergedPullRequests(
    targetBranch: string,
    maxResults: number
  ): AsyncGenerator<GiteaPullRequest, void, void> {
    const iterator = paginateGitea<GiteaPullRequest>(
      (page, limit) =>
        this.getPullRequests(targetBranch, 'closed', page, limit),
      {maxResults, pageSize: DEFAULT_PAGE_SIZE}
    );
    for await (const pullRequest of iterator) {
      if (pullRequest.merged) {
        yield pullRequest;
      }
    }
  }

  /**
   * Find the merged pull request whose merge commit SHA matches the given
   * commit, if any.
   *
   * Both commits and merged pull requests are ordered newest first. Pull
   * requests are consumed from the iterator as long as they are at least as
   * new as the commit; once the newest unconsumed pull request is older
   * than the commit, the commit cannot have an associated pull request.
   */
  private async findPullRequestForCommit(
    commit: GiteaCommit,
    pullRequestIterator: AsyncGenerator<GiteaPullRequest, void, void>,
    buffer: GiteaPullRequest[],
    pullRequestsByMergeSha: Map<string, GiteaPullRequest>
  ): Promise<GiteaPullRequest | undefined> {
    const commitTime = Date.parse(commit.created || '') || 0;
    let pullRequest = buffer.length
      ? buffer.shift()
      : (await pullRequestIterator.next()).value;
    while (pullRequest) {
      const mergeSha = pullRequest.merge_commit_sha;
      if (mergeSha) {
        pullRequestsByMergeSha.set(mergeSha, pullRequest);
      }
      if (pullRequestsByMergeSha.has(commit.sha)) {
        return pullRequestsByMergeSha.get(commit.sha);
      }
      const pullRequestTime = Date.parse(pullRequest.merged_at || '') || 0;
      if (pullRequestTime + TIMESTAMP_SKEW_MS < commitTime) {
        // The newest unconsumed pull request is older than the commit:
        // the commit cannot have an associated pull request.
        buffer.unshift(pullRequest);
        return undefined;
      }
      pullRequest = (await pullRequestIterator.next()).value;
    }
    return undefined;
  }

  private toCommit(
    giteaCommit: GiteaCommit,
    pullRequest?: GiteaPullRequest
  ): Commit {
    const files = (giteaCommit.files || []).map(file => file.filename);
    const commit: Commit = {
      sha: giteaCommit.sha,
      message: giteaCommit.commit.message,
      files,
      author: {
        name: giteaCommit.commit.author?.name || 'Unknown',
        email: giteaCommit.commit.author?.email,
        username: giteaCommit.author?.login,
      },
    };
    if (pullRequest?.merged) {
      const converted = this.toPullRequestData(pullRequest, files);
      commit.pullRequest = converted;
    }
    return commit;
  }

  async *pullRequestIterator(
    targetBranch: string,
    status: 'OPEN' | 'CLOSED' | 'MERGED' = 'MERGED',
    maxResults: number = Number.MAX_SAFE_INTEGER,
    includeFiles = true
  ): AsyncGenerator<PullRequest, void, void> {
    const state = status === 'OPEN' ? 'open' : 'closed';
    const iterator = paginateGitea<GiteaPullRequest>(
      (page, limit) => this.getPullRequests(targetBranch, state, page, limit),
      {maxResults, pageSize: DEFAULT_PAGE_SIZE}
    );
    for await (const giteaPullRequest of iterator) {
      if (status === 'MERGED' && !giteaPullRequest.merged) {
        continue;
      }
      if (status === 'CLOSED' && giteaPullRequest.merged) {
        continue;
      }
      if (status === 'OPEN' && giteaPullRequest.state !== 'open') {
        continue;
      }
      yield await this.toPullRequest(giteaPullRequest, {includeFiles});
    }
  }

  private async getPullRequests(
    base: string,
    state: 'open' | 'closed',
    page: number,
    limit: number
  ): Promise<GiteaResponse<GiteaPullRequest[]>> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const params = new URLSearchParams({
      state,
      page: `${page}`,
      limit: `${limit}`,
    });
    // Gitea and Forgejo disagree on the name of the base-branch filter:
    // Gitea exposes it as `base_branch` while Forgejo uses `base`. Send
    // both; the one the instance does not know is ignored.
    params.append('base', base);
    params.append('base_branch', base);
    if (state === 'closed') {
      // newest merges first, to match the ordering of the commit list
      params.append('sort', 'recentclose');
    }
    return this.request<GiteaPullRequest[]>(
      'GET',
      `/repos/${owner}/${repo}/pulls?${params.toString()}`
    );
  }

  async *releaseIterator(
    options: ScmReleaseIteratorOptions = {}
  ): AsyncGenerator<ScmRelease, void, void> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const iterator = paginateGitea<GiteaRelease>(
      (page, limit) =>
        this.request<GiteaRelease[]>(
          'GET',
          `/repos/${owner}/${repo}/releases?page=${page}&limit=${limit}`
        ),
      {maxResults: options.maxResults, pageSize: DEFAULT_PAGE_SIZE}
    );
    for await (const release of iterator) {
      yield this.toScmRelease(release);
    }
  }

  private toScmRelease(release: GiteaRelease): ScmRelease {
    return {
      id: release.id,
      name: release.name,
      tagName: release.tag_name,
      sha: release.target_commitish,
      notes: release.body,
      url: release.html_url,
      draft: release.draft,
    };
  }

  async *tagIterator(
    options: ScmTagIteratorOptions = {}
  ): AsyncGenerator<ScmTag, void, void> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const iterator = paginateGitea<GiteaTag>(
      (page, limit) =>
        this.request<GiteaTag[]>(
          'GET',
          `/repos/${owner}/${repo}/tags?page=${page}&limit=${limit}`
        ),
      {maxResults: options.maxResults, pageSize: DEFAULT_PAGE_SIZE}
    );
    for await (const tag of iterator) {
      const sha = tag.commit?.sha || tag.id;
      if (sha) {
        yield {name: tag.name, sha};
      }
    }
  }

  /**
   * Commit the given file contents to a new (or existing, force-pushed)
   * branch forked from the base branch.
   *
   * Gitea's `contents` API supports creating/updating multiple files in a
   * single commit, which we use to push the whole changeset atomically.
   */
  private async pushChangeSet(
    changes: ScmChangeSet,
    targetBranch: string,
    headBranchName: string,
    message: string
  ): Promise<void> {
    if (changes.size === 0) {
      return;
    }
    const owner = this.repository.owner;
    const repo = this.repository.repo;

    // Gitea requires the blob SHA of each file being updated so it can
    // detect conflicting pushes.
    const files: GiteaChangeFileOperation[] = [];
    for (const [path, change] of changes.entries()) {
      const sha = await this.getFileSha(path, targetBranch).catch(
        () => undefined
      );
      files.push({
        operation: sha ? 'update' : 'create',
        path,
        content: change.content
          ? Buffer.from(change.content, 'utf8').toString('base64')
          : undefined,
        sha,
      });
    }

    const body: GiteaChangeFilesOptions = {
      files,
      branch: targetBranch,
      new_branch: headBranchName,
      message,
      force_push: true,
    };
    await this.request('POST', `/repos/${owner}/${repo}/contents`, body);
  }

  /**
   * Fetch the blob SHA of a file on a branch. Used to satisfy Gitea's
   * optimistic concurrency checks when updating files.
   */
  private async getFileSha(
    path: string,
    branch: string
  ): Promise<string | undefined> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    try {
      const response = await this.request<GiteaContentsResponse>(
        'GET',
        `/repos/${owner}/${repo}/contents/${encodePath(
          path
        )}?ref=${encodeURIComponent(branch)}`
      );
      if (response.data.type === 'file') {
        return response.data.sha;
      }
    } catch (e) {
      if ((e as {status: number}).status === 404) {
        return undefined;
      }
      throw e;
    }
    return undefined;
  }

  async createPullRequest(
    pullRequest: PullRequest,
    targetBranch: string,
    message: string,
    updates: Update[],
    options?: ScmCreatePullRequestOptions
  ): Promise<PullRequest> {
    const changes = await this.buildChangeSet(updates, targetBranch);
    if (changes.size === 0) {
      this.logger.warn(
        'no code changes detected, skipping pull request creation'
      );
      return {
        headBranchName: pullRequest.headBranchName,
        baseBranchName: targetBranch,
        number: 0,
        title: pullRequest.title,
        body: pullRequest.body,
        labels: pullRequest.labels,
        files: [],
      };
    }
    await this.pushChangeSet(
      changes,
      targetBranch,
      pullRequest.headBranchName,
      message
    );
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const title = options?.draft
      ? `${DRAFT_PR_PREFIX}${pullRequest.title}`
      : pullRequest.title;
    const response = await this.request<GiteaPullRequest>(
      'POST',
      `/repos/${owner}/${repo}/pulls`,
      {
        title,
        body: pullRequest.body,
        base: targetBranch,
        head: pullRequest.headBranchName,
      } as GiteaCreatePullRequestOption
    );
    const number = response.data.number;
    if (pullRequest.labels.length > 0) {
      await this.addIssueLabels(pullRequest.labels, number);
    }
    return await this.getPullRequest(number);
  }

  async updatePullRequest(
    number: number,
    releasePullRequest: ReleasePullRequest,
    targetBranch: string,
    options?: ScmUpdatePullRequestOptions
  ): Promise<PullRequest> {
    const changes = await this.buildChangeSet(
      releasePullRequest.updates,
      targetBranch
    );
    const headBranchName = releasePullRequest.headRefName;
    if (changes.size > 0) {
      let message = releasePullRequest.title.toString();
      if (options?.signoffUser) {
        message = signoffCommitMessage(message, options.signoffUser);
      }
      await this.pushChangeSet(changes, targetBranch, headBranchName, message);
    }
    const title = releasePullRequest.title.toString();
    const body = (
      options?.pullRequestOverflowHandler
        ? await options.pullRequestOverflowHandler.handleOverflow(
            releasePullRequest
          )
        : releasePullRequest.body
    )
      .toString()
      .slice(0, 65536);
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const response = await this.request<GiteaPullRequest>(
      'PATCH',
      `/repos/${owner}/${repo}/pulls/${number}`,
      {title, body}
    );
    return this.toPullRequestFromDetail(response.data);
  }

  private toPullRequestFromDetail(pullRequest: GiteaPullRequest): PullRequest {
    return {
      headBranchName: pullRequest.head?.ref || '',
      baseBranchName: pullRequest.base?.ref || '',
      number: pullRequest.number,
      mergeCommitOid: pullRequest.merge_commit_sha,
      title: stripDraftMarker(pullRequest.title),
      body: pullRequest.body || '',
      labels: (pullRequest.labels || []).map(label => label.name),
      files: [],
      sha: pullRequest.merge_commit_sha || pullRequest.base?.sha,
    };
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const response = await this.request<GiteaPullRequest>(
      'GET',
      `/repos/${owner}/${repo}/pulls/${number}`
    );
    return this.toPullRequestFromDetail(response.data);
  }

  async createRelease(
    release: Release,
    options: ScmReleaseOptions = {}
  ): Promise<ScmRelease> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    if (options.forceTag) {
      try {
        await this.request('POST', `/repos/${owner}/${repo}/tags`, {
          tag_name: release.tag.toString(),
          target: release.sha,
          message: release.notes,
        });
      } catch (e) {
        // ignore if the tag already exists (409 Conflict)
        if ((e as {status: number}).status !== 409) {
          throw e;
        }
        this.logger.debug(
          `Tag ${release.tag.toString()} already exists, skipping tag creation`
        );
      }
    }
    const response = await this.request<GiteaRelease>(
      'POST',
      `/repos/${owner}/${repo}/releases`,
      {
        tag_name: release.tag.toString(),
        target_commitish: release.sha,
        name: release.name,
        body: release.notes,
        draft: !!options.draft,
        prerelease: !!options.prerelease,
      } as GiteaCreateReleaseOption
    );
    const release_ = response.data;
    return this.toScmRelease(release_);
  }

  async commentOnIssue(comment: string, number: number): Promise<string> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const response = await this.request<{html_url?: string; url?: string}>(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      {body: comment}
    );
    return (
      response.data.html_url ||
      `${this.baseUrl}/${owner}/${repo}/pulls/${number}#issuecomment`
    );
  }

  async removeIssueLabels(labels: string[], number: number): Promise<void> {
    const ids = await this.findLabelIds(labels);
    for (const id of ids) {
      await this.request(
        'DELETE',
        `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/labels/${id}`
      );
    }
  }

  async addIssueLabels(labels: string[], number: number): Promise<void> {
    const ids = await this.findLabelIds(labels);
    if (ids.length === 0) {
      return;
    }
    await this.request(
      'POST',
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/labels`,
      {labels: ids} as GiteaIssueLabelsOption
    );
  }

  /**
   * Gitea/Forgejo do not have an API to generate release notes - fall back
   * to building them from the local commit history.
   */
  async generateReleaseNotes(
    tagName: string,
    targetCommitish: string,
    previousTag?: string
  ): Promise<string> {
    this.logger.debug(
      `Generating release notes for ${tagName} (since ${previousTag}) is not supported by Gitea, generating from commit history`
    );
    const commits = await this.findCommitsBetween(previousTag, targetCommitish);
    return commits
      .map(commit => {
        const lines = commit.message.split('\n');
        const subject = lines[0];
        return `* ${subject} ${commit.sha.slice(0, 8)}`;
      })
      .join('\n');
  }

  /**
   * Fetch the commits between two refs (exclusive of the base).
   */
  private async findCommitsBetween(
    fromRef: string | undefined,
    toRef: string
  ): Promise<Commit[]> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    const commits: Commit[] = [];
    const iterator = paginateGitea<GiteaCommit>(
      (page, limit) =>
        this.request<GiteaCommit[]>(
          'GET',
          `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
            toRef
          )}&page=${page}&limit=${limit}&files=false`
        ),
      {maxResults: 250}
    );
    for await (const giteaCommit of iterator) {
      if (fromRef && giteaCommit.sha === fromRef) {
        break;
      }
      commits.push({
        sha: giteaCommit.sha,
        message: giteaCommit.commit.message,
      });
    }
    return commits;
  }

  /**
   * Create a single file on a new branch based on an existing branch. This
   * will force-push to that branch.
   */
  async createFileOnNewBranch(
    filename: string,
    contents: string,
    newBranchName: string,
    baseBranchName: string
  ): Promise<string> {
    const owner = this.repository.owner;
    const repo = this.repository.repo;
    await this.request('POST', `/repos/${owner}/${repo}/branches`, {
      new_branch_name: newBranchName,
      old_ref_name: baseBranchName,
    });
    await this.request(
      'POST',
      `/repos/${owner}/${repo}/contents/${encodePath(filename)}`,
      {
        content: Buffer.from(contents, 'utf8').toString('base64'),
        message: 'Saving release notes',
        branch: newBranchName,
        force_push: true,
      } as GiteaCreateFileOptions
    );
    return `${this.baseUrl}/${owner}/${repo}/blob/${newBranchName}/${filename}`;
  }

  async buildChangeSet(
    updates: Update[],
    defaultBranch: string
  ): Promise<ScmChangeSet> {
    const mergedUpdates = mergeUpdates(updates);
    const changes = new Map();
    for (const update of mergedUpdates) {
      let content: GitHubFileContents | undefined;
      try {
        content = await this.getFileContentsOnBranch(
          update.path,
          defaultBranch
        );
      } catch (err) {
        if (!(err instanceof FileNotFoundError)) throw err;
        // if the file is missing and create = false, just continue
        // to the next update, otherwise create the file.
        if (!update.createIfMissing) {
          this.logger.warn(`file ${update.path} did not exist`);
          continue;
        }
      }
      const contentText = content
        ? Buffer.from(content.content, 'base64').toString('utf8')
        : undefined;
      const updatedContent = update.updater.updateContent(
        contentText,
        this.logger
      );
      if (updatedContent) {
        changes.set(update.path, {
          content: updatedContent,
          originalContent: content?.parsedContent || null,
          mode: content?.mode || DEFAULT_FILE_MODE,
        });
      }
    }
    return changes;
  }
}

/**
 * Normalize a provided prefix by removing leading and trailing slashes.
 */
function normalizePrefix(prefix: string) {
  const normalized = prefix.replace(/^[/\\]/, '').replace(/[/\\]$/, '');
  if (normalized === ROOT_PROJECT_PATH) {
    return '';
  }
  return normalized;
}

/**
 * URL-encode each path segment of a file path.
 */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Remove the work-in-progress prefix that Gitea uses to mark draft pull
 * requests so that release-please can parse the title.
 */
function stripDraftMarker(title: string): string {
  return title.replace(/^WIP:\s*|^\[WIP\]\s*/i, '');
}
