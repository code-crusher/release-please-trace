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
import {
  CommitPartial,
  HeaderPartial,
  TemplateContext,
  commitPartial,
  headerPartial,
  mainTemplate,
  rubyYoshi,
} from '../../src/changelog-notes/templates';

const baseContext: TemplateContext = {
  host: 'https://github.com',
  owner: 'googleapis',
  repository: 'java-asset',
  version: '1.2.3',
  previousTag: 'v1.2.2',
  currentTag: 'v1.2.3',
  linkCompare: true,
  linkReferences: true,
  date: '1983-10-10',
  headerPartial,
  commitPartial,
};

describe('changelog templates', () => {
  describe('headerPartial', () => {
    it('links the version to the compare page', () => {
      expect(headerPartial(baseContext)).to.eql(
        '## [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) (1983-10-10)'
      );
    });
    it('does not link the version without a previous release', () => {
      expect(
        headerPartial({
          ...baseContext,
          linkCompare: false,
          previousTag: undefined,
        })
      ).to.eql('## 1.2.3 (1983-10-10)');
    });
    it('includes the release title and omits a missing date', () => {
      expect(
        headerPartial({...baseContext, title: 'stable', date: undefined})
      ).to.eql(
        '## [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) "stable"'
      );
    });
  });

  describe('commitPartial', () => {
    it('renders a plain commit with a link to the commit', () => {
      expect(
        commitPartial(baseContext, {
          subject: 'some feature',
          hash: 'sha1',
          shortHash: 'sha1',
          references: [],
        })
      ).to.eql(
        '* some feature ([sha1](https://github.com/googleapis/java-asset/commit/sha1))'
      );
    });
    it('renders the scope in bold', () => {
      expect(
        commitPartial(baseContext, {
          scope: 'deps',
          subject: 'bump it',
          hash: 'sha1',
          shortHash: 'sha1',
          references: [],
        })
      ).to.eql(
        '* **deps:** bump it ([sha1](https://github.com/googleapis/java-asset/commit/sha1))'
      );
    });
    it('falls back to the commit header when there is no subject', () => {
      expect(
        commitPartial(baseContext, {
          header: 'fix: some bugfix',
          hash: 'sha1',
          shortHash: 'sha1',
          references: [],
        })
      ).to.eql(
        '* fix: some bugfix ([sha1](https://github.com/googleapis/java-asset/commit/sha1))'
      );
    });
    it('omits the commit link without a hash', () => {
      expect(
        commitPartial(baseContext, {subject: 'some feature', references: []})
      ).to.eql('* some feature');
    });
    it('renders references with "refs" rather than "closes"', () => {
      expect(
        commitPartial(baseContext, {
          subject: 'some bugfix',
          hash: 'sha2',
          shortHash: 'sha2',
          references: [{prefix: '#', issue: '1234'}],
        })
      ).to.eql(
        '* some bugfix ([sha2](https://github.com/googleapis/java-asset/commit/sha2)), refs [#1234](https://github.com/googleapis/java-asset/issues/1234)'
      );
    });
    it('qualifies references of another repository', () => {
      expect(
        commitPartial(baseContext, {
          subject: 'some bugfix',
          references: [
            {owner: 'other', repository: 'repo', prefix: '#', issue: '7'},
          ],
        })
      ).to.eql(
        '* some bugfix, refs [other/repo#7](https://github.com/other/repo/issues/7)'
      );
    });
    it('renders references without links when references are not linked', () => {
      expect(
        commitPartial(
          {...baseContext, linkReferences: false},
          {
            subject: 'some bugfix',
            hash: 'sha2',
            shortHash: 'sha2',
            references: [
              {prefix: '#', issue: '1'},
              {prefix: '#', issue: '2'},
            ],
          }
        )
      ).to.eql('* some bugfix sha2, refs #1 #2');
    });
  });

  describe('mainTemplate', () => {
    it('renders note groups before commit groups', () => {
      const context: TemplateContext = {
        ...baseContext,
        noteGroups: [
          {
            title: 'BREAKING CHANGES',
            notes: [
              {title: 'BREAKING CHANGES', text: 'it broke', commit: {}},
              {
                title: 'BREAKING CHANGES',
                text: 'api broke',
                commit: {scope: 'api'},
              },
            ],
          },
        ],
        commitGroups: [
          {
            title: 'Features',
            commits: [
              {subject: 'some feature', hash: 'sha1', shortHash: 'sha1'},
            ],
          },
        ],
      };
      expect(mainTemplate(context)).to.eql(
        '## [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) (1983-10-10)\n' +
          '\n' +
          '\n### ⚠ BREAKING CHANGES\n' +
          '\n' +
          '* it broke\n' +
          '* **api:** api broke\n' +
          '\n' +
          '### Features\n' +
          '\n' +
          '* some feature ([sha1](https://github.com/googleapis/java-asset/commit/sha1))\n' +
          '\n'
      );
    });
    it('renders ungrouped commits without a heading', () => {
      const context: TemplateContext = {
        ...baseContext,
        commitGroups: [
          {
            title: '',
            commits: [
              {subject: 'some feature', hash: 'sha1', shortHash: 'sha1'},
            ],
          },
        ],
      };
      expect(mainTemplate(context)).to.eql(
        '## [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) (1983-10-10)\n' +
          '\n' +
          '\n' +
          '* some feature ([sha1](https://github.com/googleapis/java-asset/commit/sha1))\n' +
          '\n'
      );
    });
    it('renders only the header without commits', () => {
      expect(mainTemplate({...baseContext, commitGroups: []})).to.eql(
        '## [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) (1983-10-10)\n\n'
      );
    });
  });

  describe('rubyYoshi templates', () => {
    const context: TemplateContext = {
      ...baseContext,
      headerPartial: rubyYoshi.headerPartial as HeaderPartial,
      commitPartial: rubyYoshi.commitPartial as CommitPartial,
    };
    it('renders the version as an h3 with a slash before the date', () => {
      expect(rubyYoshi.headerPartial(context)).to.eql(
        '### [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) / 1983-10-10'
      );
    });
    it('renders a commit without a link, but with its body', () => {
      expect(
        rubyYoshi.commitPartial(context, {
          subject: 'some feature',
          body: 'more detail',
          hash: 'sha1',
          shortHash: 'sha1',
        })
      ).to.eql('* some feature\nmore detail');
    });
    it('renders sections as h4 headings', () => {
      expect(
        rubyYoshi.mainTemplate({
          ...context,
          noteGroups: [
            {
              title: 'BREAKING CHANGES',
              notes: [
                {title: 'BREAKING CHANGES', text: 'it broke', commit: {}},
              ],
            },
          ],
          commitGroups: [
            {title: 'Features', commits: [{subject: 'some feature'}]},
          ],
        })
      ).to.eql(
        '### [1.2.3](https://github.com/googleapis/java-asset/compare/v1.2.2...v1.2.3) / 1983-10-10\n' +
          '\n' +
          '#### ⚠ BREAKING CHANGES\n' +
          '\n' +
          '* it broke\n' +
          '\n' +
          '#### Features\n' +
          '\n' +
          '* some feature\n'
      );
    });
  });
});
