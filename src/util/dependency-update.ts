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

import {Commit} from '../commit';

const DEPENDENCY_UPDATE_REGEX =
  /^deps: update dependency (.*) to (v[^\s]*)(\s\(#\d+\))?$/m;

const DEPENDABOT_DEPENDENCY_UPDATE_REGEX =
  /^(?:chore|build)\(deps\): bump (.*) from [^\s]* to ([^\s]*)(\s\(#\d+\))?$/m;

const RELEASE_NOTES_HEADER_REGEX = /^### Release Notes\s*$/;

const SECTION_SEPARATOR_REGEX = /^---\s*$/;

const DETAILS_OPEN_REGEX = /^\s*<details>\s*$/i;
const DETAILS_CLOSE_REGEX = /^\s*<\/details>\s*$/i;

/**
 * Return the regex match if the commit is a dependency update commit,
 * e.g. a Renovate or Dependabot version bump.
 *
 * @param {Commit} commit The commit to inspect
 * @returns {RegExpMatchArray|null} The match, if the commit updates a dependency
 */
export function matchDependencyUpdate(commit: Commit): RegExpMatchArray | null {
  return (
    commit.message.match(DEPENDENCY_UPDATE_REGEX) ||
    commit.message.match(DEPENDABOT_DEPENDENCY_UPDATE_REGEX)
  );
}

/**
 * Extract the release notes section from a dependency update pull request
 * body. Dependency update bots, e.g. Renovate, embed the release notes of
 * the dependency in a `### Release Notes` section of the pull request body.
 *
 * @param {string} body The pull request body
 * @returns {string|undefined} The extracted release notes, if any
 */
export function extractDependencyReleaseNotes(
  body?: string
): string | undefined {
  if (!body) {
    return undefined;
  }
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const startIndex = lines.findIndex(line =>
    RELEASE_NOTES_HEADER_REGEX.test(line)
  );
  if (startIndex === -1) {
    return undefined;
  }
  const notes: string[] = [];
  let detailsDepth = 0;
  for (const line of lines.slice(startIndex + 1)) {
    // Sections after the release notes are separated by a horizontal rule,
    // e.g. Renovate's configuration section.
    if (detailsDepth === 0 && SECTION_SEPARATOR_REGEX.test(line)) {
      break;
    }
    notes.push(line);
    if (DETAILS_OPEN_REGEX.test(line)) {
      detailsDepth++;
    } else if (DETAILS_CLOSE_REGEX.test(line)) {
      detailsDepth = Math.max(0, detailsDepth - 1);
    }
  }
  return notes.join('\n').trim() || undefined;
}
