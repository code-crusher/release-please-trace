// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as nock from 'nock';
import {expect} from 'chai';
import {afterEach, beforeEach, describe, it} from 'mocha';
nock.disableNetConnect();

import {readFileSync} from 'fs';
import {resolve} from 'path';
import * as sinon from 'sinon';

import {Gitea, GITEA_API_PREFIX} from '../src/gitea';
import {Commit} from '../src/commit';
import {PullRequest} from '../src/pull-request';
import {TagName} from '../src/util/tag-name';
import {Version} from '../src/version';
import {RawContent} from '../src/updaters/raw-content';
import {Update} from '../src/update';
import {PullRequestTitle} from '../src/util/pull-request-title';
import {PullRequestBody} from '../src/util/pull-request-body';
import assert = require('assert');
import {
  DuplicateReleaseError,
  FileNotFoundError,
  GitHubAPIError,
} from '../src/errors';
const fetch = require('node-fetch');

const fixturesPath = './test/fixtures';
const sandbox = sinon.createSandbox();

const BASE_URL = 'https://gitea.example.com';
const API_ROOT = `${BASE_URL}${GITEA_API_PREFIX}`;

const COMMITS_PATH =
  '/repos/fake/fake/commits?sha=main&page=1&limit=50&files=true&stat=false&verification=false';
const CLOSED_PULLS_PATH =
  '/repos/fake/fake/pulls?state=closed&page=1&limit=50&base=main&base_branch=main&sort=recentclose';
const OPEN_PULLS_PATH =
  '/repos/fake/fake/pulls?state=open&page=1&limit=50&base=main&base_branch=main';

function commitFixture(
  sha: string,
  message: string,
  created: string,
  files: string[]
) {
  return {
    sha,
    created,
    commit: {
      message,
      author: {name: 'Jane Doe', email: 'jane@example.com'},
    },
    author: {login: 'jdoe'},
    files: files.map(filename => ({filename})),
  };
}

function closedPullRequestFixture(
  number: number,
  mergeSha?: string,
  mergedAt?: string
) {
  return {
    number,
    title: `feat: feature ${number}`,
    body: 'feature body',
    state: 'closed',
    merged: !!mergedAt,
    merged_at: mergedAt ?? null,
    merge_commit_sha: mergeSha ?? null,
    base: {ref: 'main', sha: mergeSha ?? 'base-sha'},
    head: {ref: `feature-${number}`},
    labels: [{id: 1, name: 'release-please'}],
  };
}

function releaseFixture(id: number, tag: string, sha: string) {
  return {
    id,
    name: tag,
    tag_name: tag,
    body: `notes for ${tag}`,
    html_url: `${BASE_URL}/fake/fake/releases/${tag}`,
    target_commitish: sha,
    created_at: `2026-01-0${id}T00:00:00Z`,
  };
}

describe('Gitea', () => {
  let gitea: Gitea;
  let req: nock.Scope;

  beforeEach(async () => {
    gitea = await Gitea.create({
      owner: 'fake',
      repo: 'fake',
      baseUrl: BASE_URL,
      defaultBranch: 'main',
      fetch,
    });
    req = nock(API_ROOT);
  });

  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  describe('create', () => {
    it('allows configuring the default branch explicitly', async () => {
      const instance = await Gitea.create({
        owner: 'some-owner',
        repo: 'some-repo',
        baseUrl: BASE_URL,
        defaultBranch: 'some-branch',
        fetch,
      });
      expect(instance.repository.defaultBranch).to.eql('some-branch');
    });

    it('fetches the default branch when not provided', async () => {
      nock(BASE_URL)
        .get(`${GITEA_API_PREFIX}/repos/some-owner/some-repo`)
        .reply(200, {default_branch: 'some-branch-from-api'});
      const instance = await Gitea.create({
        owner: 'some-owner',
        repo: 'some-repo',
        baseUrl: BASE_URL,
        fetch,
      });
      expect(instance.repository.defaultBranch).to.eql('some-branch-from-api');
    });

    it('sends the token as a Gitea authorization header', async () => {
      nock(BASE_URL)
        .get(`${GITEA_API_PREFIX}/repos/fake/fake`)
        .matchHeader('authorization', 'token sekret')
        .reply(200, {default_branch: 'main'});
      const instance = await Gitea.create({
        owner: 'fake',
        repo: 'fake',
        baseUrl: BASE_URL,
        token: 'sekret',
        fetch,
      });
      expect(instance.repository.defaultBranch).to.eql('main');
    });

    it('wraps API errors as GitHubAPIError', async () => {
      nock(BASE_URL).get(`${GITEA_API_PREFIX}/repos/fake/missing`).reply(404, {
        message: 'The target you were looking for could not be found.',
      });
      await assert.rejects(
        Gitea.create({
          owner: 'fake',
          repo: 'missing',
          baseUrl: BASE_URL,
          fetch,
        }),
        GitHubAPIError
      );
    });
  });

  describe('getFileContents', () => {
    let dataApiTrees: {};
    beforeEach(() => {
      dataApiTrees = JSON.parse(
        readFileSync(
          resolve(
            fixturesPath,
            'github-data-api',
            'data-api-trees-successful-response.json'
          ),
          'utf8'
        )
      );
      req
        .get('/repos/fake/fake/git/trees/main?recursive=true')
        .reply(200, dataApiTrees);
    });

    it('returns file contents via the git data API', async () => {
      const blob = JSON.parse(
        readFileSync(
          resolve(
            fixturesPath,
            'github-data-api',
            'data-api-blobs-successful-response.json'
          ),
          'utf8'
        )
      );
      req
        .get(
          '/repos/fake/fake/git/blobs/2f3d2c47bf49f81aca0df9ffc49524a213a2dc33'
        )
        .reply(200, blob);
      const fileContents = await gitea.getFileContents('package-lock.json');
      expect(fileContents).to.have.property('content');
      expect(fileContents).to.have.property('parsedContent');
      expect(fileContents)
        .to.have.property('sha')
        .equal('2f3d2c47bf49f81aca0df9ffc49524a213a2dc33');
      req.done();
    });

    it('throws FileNotFoundError for missing files', async () => {
      await assert.rejects(async () => {
        await gitea.getFileContents('non-existent-file');
      }, FileNotFoundError);
    });
  });

  describe('commitsSince', () => {
    it('associates merged pull requests without per-commit lookups', async () => {
      req
        .get(COMMITS_PATH)
        .reply(
          200,
          [
            commitFixture('sha3', 'feat: three', '2026-01-03T00:00:00Z', [
              'c.md',
            ]),
            commitFixture('sha2', 'chore: two', '2026-01-02T00:00:00Z', [
              'b.md',
            ]),
            commitFixture('sha1', 'feat: one', '2026-01-01T00:00:00Z', [
              'a.md',
            ]),
          ],
          {'x-hasmore': 'false'}
        );
      req
        .get(CLOSED_PULLS_PATH)
        .reply(
          200,
          [
            closedPullRequestFixture(3, 'sha3', '2026-01-03T00:00:01Z'),
            closedPullRequestFixture(1, 'sha1', '2026-01-01T00:00:01Z'),
          ],
          {'x-hasmore': 'false'}
        );
      const commits = await gitea.commitsSince('main', () => false, {
        maxResults: 3,
      });
      expect(commits).to.have.lengthOf(3);
      // No `commits/{sha}/pull` lookups: both pull requests come from the
      // single pulls list request above.
      expect(commits[0].pullRequest?.number).to.eql(3);
      expect(commits[0].pullRequest?.files).to.eql(['c.md']);
      expect(commits[0].files).to.eql(['c.md']);
      expect(commits[1].pullRequest).to.be.undefined;
      expect(commits[2].pullRequest?.number).to.eql(1);
      req.done();
    });

    it('paginates commits and pull requests', async () => {
      req
        .get(
          '/repos/fake/fake/commits?sha=main&page=1&limit=2&files=true&stat=false&verification=false'
        )
        .reply(
          200,
          [
            commitFixture('sha4', 'feat: four', '2026-01-04T00:00:00Z', [
              'd.md',
            ]),
            commitFixture('sha3', 'feat: three', '2026-01-03T00:00:00Z', [
              'c.md',
            ]),
          ],
          {'x-hasmore': 'true'}
        );
      req
        .get(
          '/repos/fake/fake/commits?sha=main&page=2&limit=2&files=true&stat=false&verification=false'
        )
        .reply(
          200,
          [
            commitFixture('sha2', 'feat: two', '2026-01-02T00:00:00Z', [
              'b.md',
            ]),
          ],
          {'x-hasmore': 'false'}
        );
      req
        .get(CLOSED_PULLS_PATH)
        .reply(
          200,
          [
            closedPullRequestFixture(4, 'sha4', '2026-01-04T00:00:01Z'),
            closedPullRequestFixture(2, 'sha2', '2026-01-02T00:00:01Z'),
          ],
          {'x-hasmore': 'false'}
        );
      const commits = await gitea.commitsSince('main', () => false, {
        maxResults: 3,
        batchSize: 2,
      });
      expect(commits).to.have.lengthOf(3);
      expect(commits.map((c: Commit) => c.sha)).to.eql([
        'sha4',
        'sha3',
        'sha2',
      ]);
      expect(commits[0].pullRequest?.number).to.eql(4);
      expect(commits[1].pullRequest).to.be.undefined;
      expect(commits[2].pullRequest?.number).to.eql(2);
      req.done();
    });

    it('limits results to maxResults', async () => {
      req
        .get(COMMITS_PATH)
        .reply(200, [
          commitFixture('sha3', 'feat: three', '2026-01-03T00:00:00Z', [
            'c.md',
          ]),
          commitFixture('sha2', 'chore: two', '2026-01-02T00:00:00Z', ['b.md']),
          commitFixture('sha1', 'feat: one', '2026-01-01T00:00:00Z', ['a.md']),
        ]);
      req.get(CLOSED_PULLS_PATH).reply(200, [], {'x-hasmore': 'false'});
      const commits = await gitea.commitsSince('main', () => false, {
        maxResults: 2,
      });
      expect(commits).to.have.lengthOf(2);
      req.done();
    });

    it('skips closed-but-unmerged pull requests when joining', async () => {
      req
        .get(COMMITS_PATH)
        .reply(
          200,
          [
            commitFixture('sha2', 'feat: two', '2026-01-02T00:00:00Z', [
              'b.md',
            ]),
            commitFixture('sha1', 'feat: one', '2026-01-01T00:00:00Z', [
              'a.md',
            ]),
          ],
          {'x-hasmore': 'false'}
        );
      // PR 2 closed without merging, but still carries a merge commit sha
      // that would collide with commit sha2 if merged-ness were not checked.
      req.get(CLOSED_PULLS_PATH).reply(
        200,
        [
          {
            ...closedPullRequestFixture(2, 'sha2'),
            merged: false,
            merged_at: null,
          },
          closedPullRequestFixture(1, 'sha1', '2026-01-01T00:00:01Z'),
        ],
        {'x-hasmore': 'false'}
      );
      const commits = await gitea.commitsSince('main', () => false, {
        maxResults: 2,
      });
      expect(commits).to.have.lengthOf(2);
      expect(commits[0].pullRequest).to.be.undefined;
      expect(commits[1].pullRequest?.number).to.eql(1);
      req.done();
    });
  });

  describe('pullRequestIterator', () => {
    it('yields merged pull requests with files', async () => {
      req.get(CLOSED_PULLS_PATH).reply(
        200,
        [
          {
            ...closedPullRequestFixture(2, 'sha2'),
            merged: false,
            merged_at: null,
          },
          closedPullRequestFixture(1, 'sha1', '2026-01-01T00:00:01Z'),
        ],
        {'x-hasmore': 'false'}
      );
      req
        .get('/repos/fake/fake/pulls/1/files?limit=50')
        .reply(200, [{filename: 'a.md'}, {filename: 'b.md'}]);
      const pullRequests: PullRequest[] = [];
      for await (const pullRequest of gitea.pullRequestIterator(
        'main',
        'MERGED',
        10,
        true
      )) {
        pullRequests.push(pullRequest);
      }
      expect(pullRequests).to.have.lengthOf(1);
      expect(pullRequests[0].number).to.eql(1);
      expect(pullRequests[0].files).to.eql(['a.md', 'b.md']);
      expect(pullRequests[0].mergeCommitOid).to.eql('sha1');
      req.done();
    });

    it('yields open pull requests', async () => {
      req.get(OPEN_PULLS_PATH).reply(
        200,
        [
          {
            number: 7,
            title: 'feat: open feature',
            body: 'open body',
            state: 'open',
            merged: false,
            base: {ref: 'main', sha: 'sha7'},
            head: {ref: 'feature-7'},
            labels: [],
          },
        ],
        {'x-hasmore': 'false'}
      );
      req
        .get('/repos/fake/fake/pulls/7/files?limit=50')
        .reply(200, [{filename: 'x.md'}]);
      const pullRequests: PullRequest[] = [];
      for await (const pullRequest of gitea.pullRequestIterator(
        'main',
        'OPEN',
        10,
        true
      )) {
        pullRequests.push(pullRequest);
      }
      expect(pullRequests).to.have.lengthOf(1);
      expect(pullRequests[0].number).to.eql(7);
      expect(pullRequests[0].headBranchName).to.eql('feature-7');
      req.done();
    });

    it('strips the WIP prefix from draft pull request titles', async () => {
      req.get(OPEN_PULLS_PATH).reply(
        200,
        [
          {
            number: 8,
            title: 'WIP: feat: work in progress',
            body: 'wip body',
            state: 'open',
            merged: false,
            base: {ref: 'main', sha: 'sha8'},
            head: {ref: 'feature-8'},
            labels: [],
          },
        ],
        {'x-hasmore': 'false'}
      );
      req.get('/repos/fake/fake/pulls/8/files?limit=50').reply(200, []);
      const pullRequests: PullRequest[] = [];
      for await (const pullRequest of gitea.pullRequestIterator(
        'main',
        'OPEN',
        10,
        true
      )) {
        pullRequests.push(pullRequest);
      }
      expect(pullRequests[0].title).to.eql('feat: work in progress');
      req.done();
    });

    it('yields closed-unmerged pull requests for CLOSED status', async () => {
      req.get(CLOSED_PULLS_PATH).reply(
        200,
        [
          {
            number: 9,
            title: 'feat: closed without merging',
            body: 'closed body',
            state: 'closed',
            merged: false,
            merged_at: null,
            base: {ref: 'main', sha: 'sha9'},
            head: {ref: 'feature-9'},
            labels: [],
          },
          closedPullRequestFixture(1, 'sha1', '2026-01-01T00:00:01Z'),
        ],
        {'x-hasmore': 'false'}
      );
      req
        .get('/repos/fake/fake/pulls/9/files?limit=50')
        .reply(200, [{filename: 'y.md'}]);
      const pullRequests: PullRequest[] = [];
      for await (const pullRequest of gitea.pullRequestIterator(
        'main',
        'CLOSED',
        10,
        true
      )) {
        pullRequests.push(pullRequest);
      }
      expect(pullRequests).to.have.lengthOf(1);
      expect(pullRequests[0].number).to.eql(9);
      req.done();
    });
  });

  describe('releaseIterator', () => {
    it('yields releases, paginating via the link header', async () => {
      req
        .get('/repos/fake/fake/releases?page=1&limit=50')
        .reply(200, [releaseFixture(2, 'v2.0.0', 'sha2')], {
          link: `<${API_ROOT}/repos/fake/fake/releases?page=2>; rel="next"`,
        });
      req
        .get('/repos/fake/fake/releases?page=2&limit=50')
        .reply(200, [releaseFixture(1, 'v1.0.0', 'sha1')]);
      const releases = [];
      for await (const release of gitea.releaseIterator()) {
        releases.push(release);
      }
      expect(releases).to.have.lengthOf(2);
      expect(releases[0].tagName).to.eql('v2.0.0');
      expect(releases[1].tagName).to.eql('v1.0.0');
      expect(releases[1].notes).to.eql('notes for v1.0.0');
      expect(releases[1].url).to.eql(`${BASE_URL}/fake/fake/releases/v1.0.0`);
      req.done();
    });

    it('honors maxResults', async () => {
      req
        .get('/repos/fake/fake/releases?page=1&limit=50')
        .reply(200, [
          releaseFixture(2, 'v2.0.0', 'sha2'),
          releaseFixture(1, 'v1.0.0', 'sha1'),
        ]);
      const releases = [];
      for await (const release of gitea.releaseIterator({maxResults: 1})) {
        releases.push(release);
      }
      expect(releases).to.have.lengthOf(1);
      req.done();
    });
  });

  describe('tagIterator', () => {
    it('yields tags', async () => {
      req
        .get('/repos/fake/fake/tags?page=1&limit=50')
        .reply(200, [{name: 'v1.0.0', id: 'sha1'}]);
      const tags = [];
      for await (const tag of gitea.tagIterator()) {
        tags.push(tag);
      }
      expect(tags).to.have.lengthOf(1);
      expect(tags[0]).to.eql({name: 'v1.0.0', sha: 'sha1'});
      req.done();
    });

    it('assumes full pages mean more pages when no pagination headers', async () => {
      // The tags endpoint sends no pagination headers at all: a full page
      // must be treated as "there may be more pages" so tags are not
      // silently truncated.
      const fullPage = [];
      for (let i = 0; i < 50; i++) {
        fullPage.push({name: `v1.0.${i}`, id: `sha-${i}`});
      }
      req.get('/repos/fake/fake/tags?page=1&limit=50').reply(200, fullPage);
      req.get('/repos/fake/fake/tags?page=2&limit=50').reply(200, []);
      const tags = [];
      for await (const tag of gitea.tagIterator()) {
        tags.push(tag);
      }
      expect(tags).to.have.lengthOf(50);
      req.done();
    });
  });

  describe('createRelease', () => {
    it('creates a release', async () => {
      req
        .post('/repos/fake/fake/releases', body => {
          expect(body.tag_name).to.eql('v1.2.3');
          expect(body.target_commitish).to.eql('abc123');
          expect(body.name).to.be.undefined;
          expect(body.body).to.eql('Some release notes');
          expect(body.draft).to.be.false;
          expect(body.prerelease).to.be.false;
          return true;
        })
        .reply(200, {
          id: 123456,
          name: 'v1.2.3',
          tag_name: 'v1.2.3',
          body: 'Some release notes response.',
          draft: false,
          prerelease: false,
          html_url: `${BASE_URL}/fake/fake/releases/v1.2.3`,
          target_commitish: 'abc123',
          created_at: '2026-01-01T00:00:00Z',
        });
      const release = await gitea.createRelease({
        tag: new TagName(Version.parse('1.2.3')),
        sha: 'abc123',
        notes: 'Some release notes',
      });
      req.done();
      expect(release.id).to.eql(123456);
      expect(release.tagName).to.eql('v1.2.3');
      expect(release.sha).to.eql('abc123');
      expect(release.draft).to.be.false;
      expect(release.notes).to.eql('Some release notes response.');
    });

    it('raises DuplicateReleaseError on 409 already exists', async () => {
      req.post('/repos/fake/fake/releases').reply(409, {
        message: 'release tag already exist [tag_name: v1.2.3]',
      });
      const promise = gitea.createRelease({
        tag: new TagName(Version.parse('1.2.3')),
        sha: 'abc123',
        notes: 'Some release notes',
      });
      await assert.rejects(promise, DuplicateReleaseError);
    });

    it('raises GitHubAPIError on other errors', async () => {
      req.post('/repos/fake/fake/releases').reply(422, {
        message: 'repo is empty',
      });
      const promise = gitea.createRelease({
        tag: new TagName(Version.parse('1.2.3')),
        sha: 'abc123',
        notes: 'Some release notes',
      });
      await assert.rejects(promise, GitHubAPIError);
    });
  });

  describe('commentOnIssue', () => {
    it('returns the comment URL', async () => {
      req
        .post('/repos/fake/fake/issues/44/comments', body => {
          expect(body.body).to.eql('some comment');
          return true;
        })
        .reply(201, {html_url: `${BASE_URL}/fake/fake/pulls/44#comment-1`});
      const url = await gitea.commentOnIssue('some comment', 44);
      expect(url).to.eql(`${BASE_URL}/fake/fake/pulls/44#comment-1`);
      req.done();
    });
  });

  describe('addIssueLabels', () => {
    it('maps label names to Gitea label ids', async () => {
      req.get('/repos/fake/fake/labels?page=1&limit=50').reply(
        200,
        [
          {id: 1, name: 'release-please'},
          {id: 2, name: 'autorelease: pending'},
        ],
        {'x-hasmore': 'false'}
      );
      req
        .post('/repos/fake/fake/issues/44/labels', body => {
          expect(body.labels).to.eql([1, 2]);
          return true;
        })
        .reply(200, {});
      await gitea.addIssueLabels(
        ['release-please', 'autorelease: pending'],
        44
      );
      req.done();
    });
  });

  describe('removeIssueLabels', () => {
    it('deletes each label by id', async () => {
      req
        .get('/repos/fake/fake/labels?page=1&limit=50')
        .reply(200, [{id: 1, name: 'release-please'}], {'x-hasmore': 'false'});
      req.delete('/repos/fake/fake/issues/44/labels/1').reply(204);
      await gitea.removeIssueLabels(['release-please'], 44);
      req.done();
    });
  });

  describe('generateReleaseNotes', () => {
    it('builds notes from commit history between tags', async () => {
      req
        .get('/repos/fake/fake/commits?sha=main&page=1&limit=50&files=false')
        .reply(200, [
          {
            sha: 'sha2',
            commit: {message: 'feat: two\n\nbody'},
          },
          {
            sha: 'sha1',
            commit: {message: 'feat: one'},
          },
        ]);
      const notes = await gitea.generateReleaseNotes('v2.0.0', 'main', 'sha1');
      expect(notes).to.eql('* feat: two sha2');
      req.done();
    });
  });

  describe('findFilesByFilename', () => {
    it('returns files matching the requested pattern', async () => {
      const fileSearchResponse = JSON.parse(
        readFileSync(resolve(fixturesPath, 'pom-file-search.json'), 'utf8')
      );
      req
        .get('/repos/fake/fake/git/trees/main?recursive=true')
        .reply(200, fileSearchResponse);
      const pomFiles = await gitea.findFilesByFilename('pom.xml');
      expect(pomFiles).to.deep.equal([
        'appengine/pom.xml',
        'bom/pom.xml',
        'credentials/pom.xml',
        'oauth2_http/pom.xml',
        'pom.xml',
      ]);
      req.done();
    });
  });

  describe('createPullRequest', () => {
    const updates: Update[] = [
      {
        path: 'CHANGELOG.md',
        createIfMissing: false,
        updater: new RawContent('# new changelog\n'),
      },
    ];

    function mockChangeSetFlow() {
      // buildChangeSet -> getFileContentsOnBranch (git data API)
      req.get('/repos/fake/fake/git/trees/main?recursive=true').reply(200, {
        sha: 'tree-sha',
        tree: [
          {
            path: 'CHANGELOG.md',
            mode: '100644',
            type: 'blob',
            sha: 'old-blob-sha',
          },
        ],
      });
      req.get('/repos/fake/fake/git/blobs/old-blob-sha').reply(200, {
        content: Buffer.from('# old changelog\n').toString('base64'),
        encoding: 'base64',
      });
      // pushChangeSet -> getFileSha for the existing file
      req.get('/repos/fake/fake/contents/CHANGELOG.md?ref=main').reply(200, {
        type: 'file',
        path: 'CHANGELOG.md',
        sha: 'blob-sha',
      });
      // pushChangeSet -> multi-file commit
      req
        .post('/repos/fake/fake/contents', body => {
          expect(body.branch).to.eql('main');
          expect(body.new_branch).to.eql('release-branch');
          expect(body.force_push).to.be.true;
          expect(body.message).to.eql('chore: release 1.2.3');
          expect(body.files).to.have.lengthOf(1);
          expect(body.files[0].operation).to.eql('update');
          expect(body.files[0].path).to.eql('CHANGELOG.md');
          expect(body.files[0].sha).to.eql('blob-sha');
          expect(body.files[0].content).to.eql(
            Buffer.from('# new changelog\n').toString('base64')
          );
          return true;
        })
        .reply(201, {});
    }

    it('commits the changeset and opens a pull request', async () => {
      mockChangeSetFlow();
      req
        .post('/repos/fake/fake/pulls', body => {
          expect(body.title).to.eql('chore: release 1.2.3');
          expect(body.body).to.eql('release notes');
          expect(body.base).to.eql('main');
          expect(body.head).to.eql('release-branch');
          return true;
        })
        .reply(201, {number: 42});
      // labels on the new pull request
      req
        .get('/repos/fake/fake/labels?page=1&limit=50')
        .reply(200, [{id: 1, name: 'release-please'}], {'x-hasmore': 'false'});
      req
        .post('/repos/fake/fake/issues/42/labels', body => {
          expect(body.labels).to.eql([1]);
          return true;
        })
        .reply(200, {});
      // getPullRequest for the created pull request
      req.get('/repos/fake/fake/pulls/42').reply(200, {
        number: 42,
        title: 'chore: release 1.2.3',
        body: 'release notes',
        state: 'open',
        merged: false,
        base: {ref: 'main', sha: 'abc123'},
        head: {ref: 'release-branch'},
        labels: [{id: 1, name: 'release-please'}],
      });
      const pullRequest = await gitea.createPullRequest(
        {
          headBranchName: 'release-branch',
          baseBranchName: 'main',
          number: 0,
          title: 'chore: release 1.2.3',
          body: 'release notes',
          labels: ['release-please'],
          files: [],
        },
        'main',
        'chore: release 1.2.3',
        updates
      );
      expect(pullRequest.number).to.eql(42);
      expect(pullRequest.headBranchName).to.eql('release-branch');
      expect(pullRequest.labels).to.eql(['release-please']);
      req.done();
    });

    it('marks draft pull requests with a WIP title', async () => {
      mockChangeSetFlow();
      req
        .post('/repos/fake/fake/pulls', body => {
          expect(body.title).to.eql('WIP: chore: release 1.2.3');
          return true;
        })
        .reply(201, {number: 43});
      // no labels on the new pull request
      req.get('/repos/fake/fake/pulls/43').reply(200, {
        number: 43,
        title: 'WIP: chore: release 1.2.3',
        body: 'release notes',
        state: 'open',
        merged: false,
        base: {ref: 'main', sha: 'abc123'},
        head: {ref: 'release-branch'},
        labels: [],
      });
      const pullRequest = await gitea.createPullRequest(
        {
          headBranchName: 'release-branch',
          baseBranchName: 'main',
          number: 0,
          title: 'chore: release 1.2.3',
          body: 'release notes',
          labels: [],
          files: [],
        },
        'main',
        'chore: release 1.2.3',
        updates,
        {draft: true}
      );
      expect(pullRequest.number).to.eql(43);
      expect(pullRequest.title).to.eql('chore: release 1.2.3');
      req.done();
    });

    it('skips creating a pull request when there are no changes', async () => {
      const pullRequest = await gitea.createPullRequest(
        {
          headBranchName: 'release-branch',
          baseBranchName: 'main',
          number: 0,
          title: 'chore: release 1.2.3',
          body: 'release notes',
          labels: [],
          files: [],
        },
        'main',
        'chore: release 1.2.3',
        []
      );
      expect(pullRequest.number).to.eql(0);
      // no requests are made
      req.done();
    });
  });

  describe('updatePullRequest', () => {
    const updates: Update[] = [
      {
        path: 'CHANGELOG.md',
        createIfMissing: false,
        updater: new RawContent('# newer changelog\n'),
      },
    ];

    function buildReleasePullRequest() {
      return {
        title: PullRequestTitle.ofVersion(Version.parse('1.2.3')),
        body: new PullRequestBody([]),
        labels: [],
        headRefName: 'release-branch',
        draft: false,
        updates,
      };
    }

    it('force-pushes the changeset and updates the pull request', async () => {
      req.get('/repos/fake/fake/git/trees/main?recursive=true').reply(200, {
        sha: 'tree-sha',
        tree: [
          {
            path: 'CHANGELOG.md',
            mode: '100644',
            type: 'blob',
            sha: 'old-blob-sha',
          },
        ],
      });
      req.get('/repos/fake/fake/git/blobs/old-blob-sha').reply(200, {
        content: Buffer.from('# old changelog\n').toString('base64'),
        encoding: 'base64',
      });
      req.get('/repos/fake/fake/contents/CHANGELOG.md?ref=main').reply(200, {
        type: 'file',
        path: 'CHANGELOG.md',
        sha: 'blob-sha',
      });
      req
        .post('/repos/fake/fake/contents', body => {
          expect(body.new_branch).to.eql('release-branch');
          expect(body.message).to.eql('chore: release 1.2.3');
          return true;
        })
        .reply(201, {});
      req
        .patch('/repos/fake/fake/pulls/42', body => {
          expect(body.title).to.eql('chore: release 1.2.3');
          return true;
        })
        .reply(200, {
          number: 42,
          title: 'chore: release 1.2.3',
          body: 'updated body',
          state: 'open',
          merged: false,
          base: {ref: 'main', sha: 'abc123'},
          head: {ref: 'release-branch'},
          labels: [],
        });
      const pullRequest = await gitea.updatePullRequest(
        42,
        buildReleasePullRequest(),
        'main'
      );
      expect(pullRequest.number).to.eql(42);
      expect(pullRequest.body).to.eql('updated body');
      req.done();
    });

    it('only updates metadata when there are no changes', async () => {
      req.patch('/repos/fake/fake/pulls/42').reply(200, {
        number: 42,
        title: 'chore: release 1.2.3',
        body: 'updated body',
        state: 'open',
        merged: false,
        base: {ref: 'main', sha: 'abc123'},
        head: {ref: 'release-branch'},
        labels: [],
      });
      const releasePullRequest = buildReleasePullRequest();
      const pullRequest = await gitea.updatePullRequest(
        42,
        {...releasePullRequest, updates: []},
        'main'
      );
      expect(pullRequest.number).to.eql(42);
      req.done();
    });
  });

  describe('getPullRequest', () => {
    it('fetches a single pull request', async () => {
      req.get('/repos/fake/fake/pulls/42').reply(200, {
        number: 42,
        title: 'WIP: chore: release 1.2.3',
        body: 'release notes',
        state: 'open',
        merged: false,
        base: {ref: 'main', sha: 'abc123'},
        head: {ref: 'release-branch'},
        labels: [{id: 1, name: 'release-please'}],
      });
      const pullRequest = await gitea.getPullRequest(42);
      expect(pullRequest.number).to.eql(42);
      expect(pullRequest.title).to.eql('chore: release 1.2.3');
      expect(pullRequest.mergeCommitOid).to.be.undefined;
      req.done();
    });
  });

  describe('createFileOnNewBranch', () => {
    it('creates a branch and commits the file', async () => {
      req
        .post('/repos/fake/fake/branches', body => {
          expect(body.new_branch_name).to.eql('release-notes-branch');
          expect(body.old_ref_name).to.eql('main');
          return true;
        })
        .reply(201, {});
      req
        .post('/repos/fake/fake/contents/notes.md', body => {
          expect(body.branch).to.eql('release-notes-branch');
          expect(body.message).to.eql('Saving release notes');
          expect(body.force_push).to.be.true;
          expect(body.content).to.eql(
            Buffer.from('# notes\n').toString('base64')
          );
          return true;
        })
        .reply(201, {});
      const url = await gitea.createFileOnNewBranch(
        'notes.md',
        '# notes\n',
        'release-notes-branch',
        'main'
      );
      expect(url).to.eql(
        `${BASE_URL}/fake/fake/blob/release-notes-branch/notes.md`
      );
      req.done();
    });
  });
});
