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

import {Scm} from '../scm';
import {GitHub} from '../github';
import {Gitea} from '../gitea';
import {ConfigurationError} from '../errors';

export const GITEA_DEFAULT_URL = 'https://gitea.com';

export type ScmType = string;

export interface ScmFactoryOptions {
  type?: ScmType;
  owner: string;
  repo: string;
  token?: string;
  apiUrl?: string;
  graphqlUrl?: string;
  defaultBranch?: string;
  fetch?: any;
}

/**
 * Build an Scm client for the given repository and host type.
 *
 * `github` (the default) talks to a GitHub (Enterprise) instance via the
 * GitHub REST and GraphQL APIs. `gitea` talks to a Gitea or Forgejo
 * instance via the Gitea v1 REST API, using `apiUrl` as the instance's
 * base URL (e.g. `https://gitea.com`).
 */
export async function buildScm(options: ScmFactoryOptions): Promise<Scm> {
  const type = options.type ?? 'github';
  switch (type) {
    case 'github':
      return await GitHub.create({
        owner: options.owner,
        repo: options.repo,
        token: options.token,
        apiUrl: options.apiUrl,
        graphqlUrl: options.graphqlUrl,
        defaultBranch: options.defaultBranch,
        fetch: options.fetch,
      });
    case 'gitea':
      return await Gitea.create({
        owner: options.owner,
        repo: options.repo,
        token: options.token,
        baseUrl: options.apiUrl ?? GITEA_DEFAULT_URL,
        defaultBranch: options.defaultBranch,
        fetch: options.fetch,
      });
    default:
      throw new ConfigurationError(
        `Unknown Scm type: ${type}`,
        'core',
        `${options.owner}/${options.repo}`
      );
  }
}

export function getScmTypes(): readonly ScmType[] {
  return ['github', 'gitea'];
}
