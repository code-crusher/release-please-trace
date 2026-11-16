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

import detectIndent = require('detect-indent');
import {jsonStringify} from '../util/json-stringify';
import {UpdateOptions} from './default';
import {DefaultUpdater} from './default';

const DEFAULT_INDENT = '  ';

export interface ReleasePleaseManifestOptions extends UpdateOptions {
  // Insert a blank line between entries. This keeps neighboring versions on
  // non-adjacent lines so that concurrent pull requests that bump adjacent
  // packages can be merged without conflicts.
  separateEntries?: boolean;
}

export class ReleasePleaseManifest extends DefaultUpdater {
  separateEntries: boolean;
  constructor(options: ReleasePleaseManifestOptions) {
    super(options);
    this.separateEntries = options.separateEntries ?? false;
  }

  updateContent(content: string): string {
    const parsed: Record<string, string> = content ? JSON.parse(content) : {};
    for (const [path, version] of this.versionsMap!) {
      parsed[path] = version.toString();
    }
    if (!this.separateEntries) {
      return content
        ? jsonStringify(parsed, content)
        : JSON.stringify(parsed, null, 2);
    }
    return stringifyManifest(parsed, content);
  }
}

/**
 * Serialize the manifest, separating each entry with a blank line.
 *
 * The manifest holds one package per line, so concurrent pull requests that
 * bump adjacent packages modify adjacent lines, which git cannot merge.
 * Separating the entries with blank lines keeps neighboring versions on
 * non-adjacent lines so those pull requests can be merged.
 *
 * @param {Record<string, string>} parsed The manifest contents
 * @param {string} content The original content, used to preserve formatting
 * @returns {string} The serialized manifest
 */
function stringifyManifest(
  parsed: Record<string, string>,
  content?: string
): string {
  const prefix = content ? content.slice(0, content.indexOf('{')) : '';
  const suffix = content ? content.slice(content.lastIndexOf('}') + 1) : '';
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    return `${prefix}{}${suffix}`;
  }

  // Keep the indentation style of the original manifest. Minified manifests
  // are expanded so that the entries can be separated by blank lines.
  const indent = content
    ? detectIndent(content.trim()).indent || DEFAULT_INDENT
    : DEFAULT_INDENT;
  const lines = entries.map(
    ([path, version]) =>
      `${indent}${JSON.stringify(path)}: ${JSON.stringify(version)}`
  );
  return `${prefix}{\n${lines.join(',\n\n')}\n}${suffix}`;
}
