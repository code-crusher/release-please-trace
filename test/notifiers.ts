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

import {expect} from 'chai';
import {afterEach, beforeEach, describe, it} from 'mocha';
import * as nock from 'nock';
import * as sinon from 'sinon';
import assert = require('assert');
import {GitHub} from '../src/github';
import {ScmRelease} from '../src/scm';
import {PullRequest} from '../src/pull-request';
import {TagName} from '../src/util/tag-name';
import {PullRequestBody} from '../src/util/pull-request-body';
import {PullRequestTitle} from '../src/util/pull-request-title';
import {Version} from '../src/version';
import {Notification, Notifier, NotifyingScm} from '../src/notifiers';
import {WebhookNotifier} from '../src/notifiers/webhook';
import {
  buildNotifier,
  getNotifierTypes,
  registerNotifier,
  unregisterNotifier,
} from '../src/factories/notifier-factory';
import {ConfigurationError} from '../src/errors';

nock.disableNetConnect();

const sandbox = sinon.createSandbox();
// nock cannot intercept the global (undici-based) fetch, so tests inject
// node-fetch, which nock can intercept.
const fetch = require('node-fetch');

class RecordingNotifier implements Notifier {
  sent: Notification[] = [];
  send(notification: Notification): Promise<void> {
    this.sent.push(notification);
    return Promise.resolve();
  }
}

describe('NotifyingScm', () => {
  let github: GitHub;
  let notifier: RecordingNotifier;
  let scm: NotifyingScm;

  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake-owner',
      repo: 'fake-repo',
      defaultBranch: 'main',
      token: 'fake-token',
    });
    notifier = new RecordingNotifier();
    scm = new NotifyingScm(github, [notifier]);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('createRelease', () => {
    it('notifies with the created release', async () => {
      const expected: ScmRelease = {
        id: 123456,
        tagName: 'v1.2.3',
        sha: 'abc123',
        url: 'https://github.com/fake-owner/fake-repo/releases/v1.2.3',
      };
      sandbox.stub(github, 'createRelease').resolves(expected);

      const created = await scm.createRelease({
        tag: new TagName(Version.parse('1.2.3')),
        sha: 'abc123',
        notes: 'some notes',
      });

      expect(created).to.eql(expected);
      expect(notifier.sent).to.eql([
        {action: 'create release', data: expected},
      ]);
    });
  });

  describe('createPullRequest', () => {
    it('notifies with the created pull request', async () => {
      const expected: PullRequest = {
        headBranchName: 'release-please/branches/main',
        baseBranchName: 'main',
        number: 1234,
        title: 'chore: release main',
        body: 'some body',
        labels: ['autorelease: pending'],
        files: [],
      };
      sandbox.stub(github, 'createPullRequest').resolves(expected);

      const created = await scm.createPullRequest(
        {
          headBranchName: 'release-please/branches/main',
          baseBranchName: 'main',
          number: -1,
          title: 'chore: release main',
          body: 'some body',
          labels: [],
          files: [],
        },
        'main',
        'chore: release main',
        [],
        {}
      );

      expect(created).to.eql(expected);
      expect(notifier.sent).to.eql([
        {action: 'create pull request', data: expected},
      ]);
    });
  });

  describe('updatePullRequest', () => {
    it('notifies with the updated pull request', async () => {
      const expected: PullRequest = {
        headBranchName: 'release-please/branches/main',
        baseBranchName: 'main',
        number: 1234,
        title: 'chore: release main',
        body: 'some body',
        labels: ['autorelease: pending'],
        files: [],
      };
      sandbox.stub(github, 'updatePullRequest').resolves(expected);

      await scm.updatePullRequest(
        1234,
        {
          title: PullRequestTitle.ofTargetBranch('main'),
          body: new PullRequestBody([]),
          labels: [],
          headRefName: 'release-please/branches/main',
          draft: false,
          updates: [],
        },
        'main'
      );

      expect(notifier.sent).to.eql([
        {action: 'update pull request', data: expected},
      ]);
    });
  });

  describe('commentOnIssue', () => {
    it('notifies with the comment and url', async () => {
      const url = 'https://github.com/fake-owner/fake-repo/issues/1234#issue';
      sandbox.stub(github, 'commentOnIssue').resolves(url);

      await scm.commentOnIssue('some comment', 1234);

      expect(notifier.sent).to.eql([
        {
          action: 'comment on issue',
          data: {number: 1234, comment: 'some comment', url},
        },
      ]);
    });
  });

  describe('addIssueLabels', () => {
    it('notifies with the labels', async () => {
      sandbox.stub(github, 'addIssueLabels').resolves();

      await scm.addIssueLabels(['autorelease: tagged'], 1234);

      expect(notifier.sent).to.eql([
        {
          action: 'add issue labels',
          data: {number: 1234, labels: ['autorelease: tagged']},
        },
      ]);
    });
  });

  describe('removeIssueLabels', () => {
    it('notifies with the labels', async () => {
      sandbox.stub(github, 'removeIssueLabels').resolves();

      await scm.removeIssueLabels(['autorelease: pending'], 1234);

      expect(notifier.sent).to.eql([
        {
          action: 'remove issue labels',
          data: {number: 1234, labels: ['autorelease: pending']},
        },
      ]);
    });
  });

  describe('createFileOnNewBranch', () => {
    it('notifies with the file and url', async () => {
      const url = 'https://github.com/fake-owner/fake-repo/blob/main/foo.txt';
      sandbox.stub(github, 'createFileOnNewBranch').resolves(url);

      await scm.createFileOnNewBranch(
        'foo.txt',
        'contents',
        'new-branch',
        'main'
      );

      expect(notifier.sent).to.eql([
        {
          action: 'create file on new branch',
          data: {
            filename: 'foo.txt',
            newBranchName: 'new-branch',
            baseBranchName: 'main',
            url,
          },
        },
      ]);
    });
  });

  describe('read-only operations', () => {
    it('does not notify', async () => {
      const contents = {
        content: Buffer.from('hello').toString('base64'),
        parsedContent: 'hello',
        sha: 'abc123',
        mode: '100644',
      };
      sandbox.stub(github, 'getFileContentsOnBranch').resolves(contents);
      sandbox.stub(github, 'getPullRequest').resolves({
        headBranchName: 'head',
        baseBranchName: 'main',
        number: 1234,
        title: 'a title',
        body: 'a body',
        labels: [],
        files: [],
      });

      await scm.getFileContents('foo.txt');
      await scm.getPullRequest(1234);

      expect(notifier.sent).to.be.empty;
    });
  });

  describe('when a notifier fails', () => {
    it('logs a warning and does not fail the action', async () => {
      const expected: ScmRelease = {
        id: 123456,
        tagName: 'v1.2.3',
        sha: 'abc123',
        url: 'https://github.com/fake-owner/fake-repo/releases/v1.2.3',
      };
      const releaseStub = sandbox
        .stub(github, 'createRelease')
        .resolves(expected);
      const failingNotifier: Notifier = {
        send: () => Promise.reject(new Error('boom')),
      };
      const logger = {
        error: sandbox.stub(),
        warn: sandbox.stub(),
        info: sandbox.stub(),
        debug: sandbox.stub(),
        trace: sandbox.stub(),
      };
      const notifyingScm = new NotifyingScm(
        github,
        [failingNotifier, notifier],
        logger
      );

      const created = await notifyingScm.createRelease({
        tag: new TagName(Version.parse('1.2.3')),
        sha: 'abc123',
        notes: 'some notes',
      });

      // the action still succeeded and the second notifier still ran
      expect(created).to.eql(expected);
      sinon.assert.calledOnce(releaseStub);
      expect(notifier.sent).to.eql([
        {action: 'create release', data: expected},
      ]);
      expect(logger.warn.calledWithMatch('notifier failed')).to.be.true;
    });
  });
});

describe('WebhookNotifier', () => {
  it('posts the notification as JSON', async () => {
    const scope = nock('https://example.com')
      .post('/webhook', {
        action: 'create release',
        data: {tagName: 'v1.2.3'},
      })
      .reply(200);
    const notifier = new WebhookNotifier({
      url: 'https://example.com/webhook',
      fetch,
    });

    await notifier.send({
      action: 'create release',
      data: {tagName: 'v1.2.3'},
    });

    expect(scope.isDone()).to.be.true;
  });

  it('throws on a non-2xx response', async () => {
    nock('https://example.com')
      .post('/webhook')
      .reply(500, 'Internal Server Error');
    const notifier = new WebhookNotifier({
      url: 'https://example.com/webhook',
      fetch,
    });

    await assert.rejects(
      notifier.send({action: 'create release', data: {}}),
      /webhook notification failed/
    );
  });

  it('gives up on a slow endpoint', async () => {
    nock('https://example.com').post('/webhook').delay(1000).reply(200);
    const notifier = new WebhookNotifier({
      url: 'https://example.com/webhook',
      timeoutMs: 10,
      fetch,
    });

    await assert.rejects(
      notifier.send({action: 'create release', data: {}}),
      // node-fetch surfaces the abort as an error; we only care that the
      // promise rejects rather than hanging
      /Error/
    );
  });
});

describe('NotifierFactory', () => {
  describe('buildNotifier', () => {
    it('builds a webhook notifier', () => {
      const notifier = buildNotifier({
        type: 'webhook',
        url: 'https://example.com/webhook',
      });
      expect(notifier).instanceof(WebhookNotifier);
    });

    it('throws on an unknown notifier type', () => {
      expect(() => buildNotifier({type: 'does-not-exist'})).to.throw(
        ConfigurationError,
        'Unknown notifier type: does-not-exist'
      );
    });

    it('throws when the webhook notifier is missing a url', () => {
      expect(() => buildNotifier({type: 'webhook'})).to.throw(
        ConfigurationError,
        'Missing required url for webhook notifier'
      );
    });

    it('can register and unregister notifiers', () => {
      class CustomNotifier implements Notifier {
        send(): Promise<void> {
          return Promise.resolve();
        }
      }
      registerNotifier('custom', () => new CustomNotifier());
      expect(getNotifierTypes()).to.contain('custom');
      const notifier = buildNotifier({type: 'custom'});
      expect(notifier).instanceof(CustomNotifier);
      unregisterNotifier('custom');
      expect(getNotifierTypes()).to.not.contain('custom');
    });
  });
});
