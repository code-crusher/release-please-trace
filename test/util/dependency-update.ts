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
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {
  extractDependencyReleaseNotes,
  matchDependencyUpdate,
} from '../../src/util/dependency-update';

describe('dependency-update', () => {
  describe('matchDependencyUpdate', () => {
    it('matches renovate dependency updates', () => {
      const match = matchDependencyUpdate({
        sha: 'abc123',
        message:
          'deps: update dependency com.google.cloud:google-cloud-bigtable to v1.20.0 (#1095)',
      });
      expect(match).to.not.be.null;
      expect(match![1]).to.eql('com.google.cloud:google-cloud-bigtable');
    });
    it('matches dependabot dependency updates', () => {
      const match = matchDependencyUpdate({
        sha: 'abc123',
        message: 'chore(deps): bump foo from 1.2.3 to 1.2.4',
      });
      expect(match).to.not.be.null;
      expect(match![1]).to.eql('foo');
    });
    it('matches build(deps) dependency updates', () => {
      const match = matchDependencyUpdate({
        sha: 'abc123',
        message: 'build(deps): bump bar from v1.2.3 to v1.2.4 (#1234)',
      });
      expect(match).to.not.be.null;
      expect(match![1]).to.eql('bar');
    });
    it('does not match other commits', () => {
      expect(
        matchDependencyUpdate({sha: 'abc123', message: 'feat: a new feature'})
      ).to.be.null;
    });
  });

  describe('extractDependencyReleaseNotes', () => {
    const pullRequestBody = [
      'This PR contains the following updates:',
      '',
      '| Package | Change |',
      '|---|---|',
      '| [foo](https://example.com/foo) | `1.2.3` -> `1.2.4` |',
      '',
      '---',
      '',
      '### Release Notes',
      '',
      '<details>',
      '<summary>example/foo</summary>',
      '',
      '### [`v1.2.4`](https://example.com/foo/changelog)',
      '',
      '##### Bug Fixes',
      '',
      '-   fix a bug',
      '',
      '</details>',
      '',
      '---',
      '',
      '### Renovate configuration',
      '',
      ':date: **Schedule**: At any time (no schedule defined).',
    ].join('\n');

    it('extracts the release notes section', () => {
      expect(extractDependencyReleaseNotes(pullRequestBody)).to.eql(
        [
          '<details>',
          '<summary>example/foo</summary>',
          '',
          '### [`v1.2.4`](https://example.com/foo/changelog)',
          '',
          '##### Bug Fixes',
          '',
          '-   fix a bug',
          '',
          '</details>',
        ].join('\n')
      );
    });
    it('extracts the release notes when there is no trailing separator', () => {
      expect(
        extractDependencyReleaseNotes(
          ['### Release Notes', '', 'some release notes'].join('\n')
        )
      ).to.eql('some release notes');
    });
    it('preserves horizontal rules inside details blocks', () => {
      expect(
        extractDependencyReleaseNotes(
          [
            '### Release Notes',
            '',
            '<details>',
            '<summary>example/foo</summary>',
            '',
            'first release',
            '',
            '---',
            '',
            'second release',
            '',
            '</details>',
            '',
            '---',
            '',
            '### Renovate configuration',
          ].join('\n')
        )
      ).to.eql(
        [
          '<details>',
          '<summary>example/foo</summary>',
          '',
          'first release',
          '',
          '---',
          '',
          'second release',
          '',
          '</details>',
        ].join('\n')
      );
    });
    it('handles windows line endings', () => {
      expect(
        extractDependencyReleaseNotes(
          ['### Release Notes', '', 'some release notes'].join('\r\n')
        )
      ).to.eql('some release notes');
    });
    it('returns undefined when there is no release notes section', () => {
      expect(extractDependencyReleaseNotes('just a pull request body')).to.be
        .undefined;
    });
    it('returns undefined when there is no pull request body', () => {
      expect(extractDependencyReleaseNotes(undefined)).to.be.undefined;
    });
    it('returns undefined when the release notes section is empty', () => {
      expect(extractDependencyReleaseNotes('### Release Notes\n\n---\n\nother'))
        .to.be.undefined;
    });
    it('extracts the release notes from a renovate pull request', () => {
      const body = readFileSync(
        resolve(
          './test/fixtures/pull-request-bodies/renovate-dependency-update.txt'
        ),
        'utf8'
      );
      const notes = extractDependencyReleaseNotes(body);
      expect(notes).to.be.a('string');
      expect(notes).to.include('<summary>googleapis/java-bigtable</summary>');
      expect(notes).to.not.include('Renovate configuration');
      expect(notes!.startsWith('<details>')).to.be.true;
      expect(notes!.endsWith('</details>')).to.be.true;
    });
  });
});
