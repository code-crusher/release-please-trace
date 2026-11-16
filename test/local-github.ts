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
import {describe, it, before} from 'mocha';
import {execFile as execFileCb} from 'child_process';
import {promisify} from 'util';
import {mkdtemp, writeFile} from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {LocalGitHub} from '../src/local-github';
import {GitHubApi} from '../src/github-api';

const execFile = promisify(execFileCb);

describe('LocalGitHub', function () {
  this.timeout(60000);
  let localGitHub: LocalGitHub;

  before(async () => {
    localGitHub = await LocalGitHub.create({
      owner: 'googleapis',
      repo: 'release-please',
      defaultBranch: 'main',
      cloneDepth: 100,
    });
  });

  describe('getFileContentsOnBranch', () => {
    it('reads file content correctly', async () => {
      const contents = await localGitHub.getFileContentsOnBranch(
        'package.json',
        'main'
      );
      expect(contents).to.not.be.undefined;
      expect(contents.parsedContent).to.include('"name": "release-please"');
      expect(contents.sha).to.not.be.undefined;
    });

    it('reads file content correctly from a branch', async () => {
      const contents = await localGitHub.getFileContentsOnBranch(
        'package.json',
        '12.x'
      );
      expect(contents).to.not.be.undefined;
      expect(contents.parsedContent).to.include('"name": "release-please"');
      expect(contents.sha).to.not.be.undefined;
    });

    it('reads file content correctly from a tag', async () => {
      const contents = await localGitHub.getFileContentsOnBranch(
        'package.json',
        'v17.4.0'
      );
      expect(contents).to.not.be.undefined;
      expect(contents.parsedContent).to.include('"name": "release-please"');
      expect(contents.sha).to.not.be.undefined;
    });

    it('throws FileNotFoundError when file does not exist', async () => {
      try {
        await localGitHub.getFileContentsOnBranch(
          'non-existent-file.txt',
          'main'
        );
        throw new Error('Expected FileNotFoundError to be thrown');
      } catch (err) {
        const error = err as Error;
        expect(error.name).to.equal('FileNotFoundError');
      }
    });

    it('throws FileNotFoundError when file does not exist on a branch', async () => {
      try {
        await localGitHub.getFileContentsOnBranch(
          'non-existent-file.txt',
          '12.x'
        );
        throw new Error('Expected FileNotFoundError to be thrown');
      } catch (err) {
        const error = err as Error;
        expect(error.name).to.equal('FileNotFoundError');
      }
    });
  });

  describe('findFilesByFilenameAndRef', () => {
    it('finds files by filename', async () => {
      const files = await localGitHub.findFilesByFilenameAndRef(
        'package.json',
        'main'
      );
      expect(files).to.include('package.json');
    });

    it('finds files by filename on a branch', async () => {
      const files = await localGitHub.findFilesByFilenameAndRef(
        'package.json',
        '12.x'
      );
      expect(files).to.include('package.json');
    });
  });

  describe('findFilesByGlobAndRef', () => {
    it('finds files by glob', async () => {
      const files = await localGitHub.findFilesByGlobAndRef('*.json', 'main');
      expect(files).to.include('package.json');
    });

    it('finds files by glob on a branch', async () => {
      const files = await localGitHub.findFilesByGlobAndRef('*.json', '12.x');
      expect(files).to.include('package.json');
    });
  });

  describe('findFilesByExtensionAndRef', () => {
    it('finds files by extension', async () => {
      const files = await localGitHub.findFilesByExtensionAndRef(
        'json',
        'main'
      );
      expect(files).to.include('package.json');
    });

    it('finds files by extension on a branch', async () => {
      const files = await localGitHub.findFilesByExtensionAndRef(
        'json',
        '12.x'
      );
      expect(files).to.include('package.json');
    });
  });

  describe('mergeCommitIterator', () => {
    it('iterates over commits', async () => {
      const generator = localGitHub.mergeCommitIterator('main', {
        maxResults: 5,
      });
      const commits = [];
      for await (const commit of generator) {
        commits.push(commit);
      }
      expect(commits.length).to.be.greaterThan(0);
      expect(commits.length).to.be.lessThanOrEqual(5);
      expect(commits[0].sha).to.not.be.undefined;
      expect(commits[0].message).to.not.be.undefined;
    });

    it('iterates over commits in topological order', async () => {
      // Build a repository where a branch merged after a release keeps its
      // older commit dates, the scenario from #1533.
      const repoDir = await mkdtemp(path.join(os.tmpdir(), 'rp-topo-'));
      const git = async (args: string[], date?: string) => {
        await execFile('git', args, {
          cwd: repoDir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
            ...(date ? {GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date} : {}),
          },
        });
      };
      const writeAndCommit = async (
        filename: string,
        message: string,
        date: string
      ) => {
        await writeFile(path.join(repoDir, filename), message);
        await git(['add', filename]);
        await git(['commit', '-m', message], date);
      };

      await git(['init', '-b', 'main']);
      await writeAndCommit(
        'base',
        'chore: initial commit',
        '2026-01-01T00:00:00Z'
      );
      await git(['checkout', '-b', 'feature-foo']);
      await writeAndCommit(
        'foo1',
        'feat: foo commit 1',
        '2026-01-01T00:00:00Z'
      );
      await writeAndCommit(
        'foo2',
        'feat: foo commit 2',
        '2026-01-01T00:00:00Z'
      );
      await git(['checkout', 'main']);
      await git(['checkout', '-b', 'feature-bar']);
      await writeAndCommit('bar1', 'feat: bar commit', '2026-01-01T00:00:00Z');
      await git(['checkout', 'main']);
      await git(
        ['merge', '--no-ff', 'feature-bar', '-m', 'Merge feature-bar'],
        '2026-01-02T00:00:00Z'
      );
      await writeAndCommit(
        'release',
        'chore: release 1.0.0',
        '2026-01-03T00:00:00Z'
      );
      await git(
        ['merge', '--no-ff', 'feature-foo', '-m', 'Merge feature-foo'],
        '2026-01-04T00:00:00Z'
      );

      const local = new LocalGitHub(
        {owner: 'fake', repo: 'fake', defaultBranch: 'main'},
        // Not used by the commit iterator.
        {} as unknown as GitHubApi,
        repoDir
      );
      const generator = local.mergeCommitIterator('main', {
        backfillFiles: false,
      });
      const messages: string[] = [];
      for await (const commit of generator) {
        messages.push(commit.message);
      }
      expect(messages).to.eql([
        'Merge feature-foo',
        'feat: foo commit 2',
        'feat: foo commit 1',
        'chore: release 1.0.0',
        'Merge feature-bar',
        'feat: bar commit',
        'chore: initial commit',
      ]);
    });
  });

  describe('tagIterator', () => {
    it('iterates over tags', async () => {
      const generator = localGitHub.tagIterator({maxResults: 5});
      const tags = [];
      for await (const tag of generator) {
        tags.push(tag);
      }
      expect(tags.length).to.be.greaterThan(0);
      expect(tags.length).to.be.lessThanOrEqual(5);
      expect(tags[0].name).to.not.be.undefined;
      expect(tags[0].sha).to.not.be.undefined;
    });
  });
});
