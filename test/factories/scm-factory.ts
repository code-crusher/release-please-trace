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
import {describe, it} from 'mocha';
import {expect} from 'chai';
import assert = require('assert');
import {GitHub, Gitea} from '../../src';
nock.disableNetConnect();

const fetch = require('node-fetch');
import {
  buildScm,
  getScmTypes,
  GITEA_DEFAULT_URL,
} from '../../src/factories/scm-factory';

describe('ScmFactory', () => {
  describe('buildScm', () => {
    it('should build a GitHub client by default', async () => {
      nock('https://api.github.com')
        .get('/repos/fake-owner/fake-repo')
        .reply(200, {default_branch: 'main'});
      const scm = await buildScm({
        owner: 'fake-owner',
        repo: 'fake-repo',
        fetch,
      });
      expect(scm).to.be.instanceOf(GitHub);
    });

    it('should build a GitHub client for type=github', async () => {
      nock('https://api.github.com')
        .get('/repos/fake-owner/fake-repo')
        .reply(200, {default_branch: 'main'});
      const scm = await buildScm({
        type: 'github',
        owner: 'fake-owner',
        repo: 'fake-repo',
        fetch,
      });
      expect(scm).to.be.instanceOf(GitHub);
    });

    it('should build a Gitea client for type=gitea', async () => {
      nock(GITEA_DEFAULT_URL)
        .get('/api/v1/repos/fake-owner/fake-repo')
        .reply(200, {default_branch: 'main'});
      const scm = await buildScm({
        type: 'gitea',
        owner: 'fake-owner',
        repo: 'fake-repo',
        fetch,
      });
      expect(scm).to.be.instanceOf(Gitea);
      expect(scm.repository.defaultBranch).to.eql('main');
    });

    it('should honor a custom Gitea API URL', async () => {
      nock('https://gitea.example.com')
        .get('/api/v1/repos/fake-owner/fake-repo')
        .reply(200, {default_branch: 'main'});
      const scm = await buildScm({
        type: 'gitea',
        owner: 'fake-owner',
        repo: 'fake-repo',
        apiUrl: 'https://gitea.example.com',
        fetch,
      });
      expect(scm).to.be.instanceOf(Gitea);
      expect(scm.repository.defaultBranch).to.eql('main');
    });

    it('should throw for unknown type', async () => {
      await assert.rejects(
        buildScm({
          type: 'non-existent',
          owner: 'fake-owner',
          repo: 'fake-repo',
          fetch,
        }),
        /Unknown Scm type/
      );
    });
  });

  describe('getScmTypes', () => {
    it('should return default types', () => {
      const types = getScmTypes();
      expect(types).to.contain('github');
      expect(types).to.contain('gitea');
    });
  });
});
