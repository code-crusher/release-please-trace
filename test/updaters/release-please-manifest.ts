// Copyright 2021 Google LLC
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
import {ReleasePleaseManifest} from '../../src/updaters/release-please-manifest';
import {Version} from '../../src/version';

describe('ReleasePleaseManifest', () => {
  describe('updateContent', () => {
    it('separates entries with a blank line', () => {
      const oldContent = [
        '{',
        '  "packages/a": "1.0.0",',
        '  "packages/b": "1.0.0",',
        '  "packages/c": "1.0.0"',
        '}',
        '',
      ].join('\n');
      const updater = new ReleasePleaseManifest({
        version: Version.parse('1.1.0'),
        versionsMap: new Map([['packages/b', Version.parse('1.1.0')]]),
      });
      const newContent = updater.updateContent(oldContent);
      expect(newContent).to.eql(
        [
          '{',
          '  "packages/a": "1.0.0",',
          '',
          '  "packages/b": "1.1.0",',
          '',
          '  "packages/c": "1.0.0"',
          '}',
          '',
        ].join('\n')
      );
      // Adjacent entries must not be on adjacent lines, otherwise concurrent
      // pull requests that bump them cannot be merged.
      expect(JSON.parse(newContent)).to.eql({
        'packages/a': '1.0.0',
        'packages/b': '1.1.0',
        'packages/c': '1.0.0',
      });
    });

    it('expands a minified manifest', () => {
      const updater = new ReleasePleaseManifest({
        version: Version.parse('1.1.0'),
        versionsMap: new Map([['packages/a', Version.parse('1.1.0')]]),
      });
      const newContent = updater.updateContent(
        '{"packages/a":"1.0.0","packages/b":"1.0.0"}'
      );
      expect(newContent).to.eql(
        [
          '{',
          '  "packages/a": "1.1.0",',
          '',
          '  "packages/b": "1.0.0"',
          '}',
        ].join('\n')
      );
    });

    it('preserves the original indentation', () => {
      const oldContent = [
        '{',
        '    "packages/a": "1.0.0",',
        '    "packages/b": "1.0.0"',
        '}',
      ].join('\n');
      const updater = new ReleasePleaseManifest({
        version: Version.parse('1.1.0'),
        versionsMap: new Map([['packages/a', Version.parse('1.1.0')]]),
      });
      const newContent = updater.updateContent(oldContent);
      expect(newContent).to.eql(
        [
          '{',
          '    "packages/a": "1.1.0",',
          '',
          '    "packages/b": "1.0.0"',
          '}',
        ].join('\n')
      );
    });

    it('preserves trailing content', () => {
      const oldContent = '{\n  "packages/a": "1.0.0"\n}\n';
      const updater = new ReleasePleaseManifest({
        version: Version.parse('1.1.0'),
        versionsMap: new Map([['packages/b', Version.parse('1.0.0')]]),
      });
      const newContent = updater.updateContent(oldContent);
      expect(newContent).to.eql(
        [
          '{',
          '  "packages/a": "1.0.0",',
          '',
          '  "packages/b": "1.0.0"',
          '}',
          '',
        ].join('\n')
      );
    });

    it('builds a new manifest when no content exists', () => {
      const updater = new ReleasePleaseManifest({
        version: Version.parse('1.0.0'),
        versionsMap: new Map([['.', Version.parse('1.0.0')]]),
      });
      expect(updater.updateContent(undefined as unknown as string)).to.eql(
        ['{', '  ".": "1.0.0"', '}'].join('\n')
      );
    });

    it('handles an empty manifest', () => {
      const updater = new ReleasePleaseManifest({
        version: Version.parse('1.0.0'),
        versionsMap: new Map([['.', Version.parse('1.0.0')]]),
      });
      expect(updater.updateContent('{}\n')).to.eql(
        ['{', '  ".": "1.0.0"', '}', ''].join('\n')
      );
    });
  });
});
