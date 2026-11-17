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

import {RequestError} from '@octokit/request-error';
import {
  RequestError as RequestErrorBody,
  ResponseHeaders,
} from '@octokit/types';

interface SingleError {
  resource: string;
  code: string;
  field: string;
}

export class ConfigurationError extends Error {
  releaserName: string;
  repository: string;
  constructor(message: string, releaserName: string, repository: string) {
    super(`${releaserName} (${repository}): ${message}`);
    this.releaserName = releaserName;
    this.repository = repository;
    this.name = ConfigurationError.name;
  }
}

export class MissingRequiredFileError extends ConfigurationError {
  file: string;
  constructor(file: string, releaserName: string, repository: string) {
    super(`Missing required file: ${file}`, releaserName, repository);
    this.file = file;
    this.name = MissingRequiredFileError.name;
  }
}

export class GitHubAPIError extends Error {
  body: RequestErrorBody | undefined;
  status: number;
  cause?: Error;
  constructor(requestError: RequestError, message?: string) {
    super(
      message ??
        (GitHubAPIError.isRateLimitError(requestError)
          ? GitHubAPIError.rateLimitMessage(requestError)
          : requestError.message)
    );
    this.status = requestError.status;
    this.body = GitHubAPIError.parseErrorBody(requestError);
    this.name = GitHubAPIError.name;
    this.cause = requestError;
    this.stack = requestError.stack;
  }

  /**
   * Returns `true` when the request was rejected because of GitHub's primary
   * rate limit. GitHub returns HTTP 429 for an exceeded rate limit and HTTP
   * 403 (with the remaining limit reported as 0) once the limit is exhausted.
   * A 403 is only treated as a rate limit when the response headers confirm it,
   * since 403 is also used for permission errors.
   */
  static isRateLimitError(requestError: RequestError): boolean {
    if (requestError.status === 429) {
      return true;
    }
    if (requestError.status === 403) {
      const headers = parseRateLimitHeaders(requestError.response?.headers);
      return (
        headers.remaining === '0' || /rate limit/i.test(requestError.message)
      );
    }
    return false;
  }

  /**
   * Builds a clear message for requests rejected because of GitHub's primary
   * rate limit. These are otherwise easy to confuse with secondary rate
   * limiting or a generic server error.
   */
  static rateLimitMessage(requestError: RequestError): string {
    const description = describeRateLimit(requestError.response?.headers);
    const base =
      requestError.status === 429
        ? 'GitHub rate limit exceeded'
        : 'GitHub rate limit may have been exceeded';
    return description ? `${base}: ${description}` : `${base}.`;
  }

  static parseErrorBody(
    requestError: RequestError
  ): RequestErrorBody | undefined {
    const body = requestError.response as {data: RequestErrorBody};
    return body?.data || undefined;
  }

  static parseErrors(requestError: RequestError): SingleError[] {
    return GitHubAPIError.parseErrorBody(requestError)?.errors || [];
  }
}

/**
 * The `x-ratelimit-*` response headers returned by the GitHub REST API. These
 * are used to determine whether a failed request was caused by hitting the
 * primary rate limit, and to warn when the limit is running low.
 */
export interface RateLimitHeaders {
  limit?: string;
  remaining?: string;
  reset?: string;
}

/**
 * Normalizes the rate limit headers returned by GitHub (keyed as
 * `x-ratelimit-*`) onto a single object.
 */
export function parseRateLimitHeaders(
  headers: ResponseHeaders | undefined
): RateLimitHeaders {
  return {
    limit: headers?.['x-ratelimit-limit'],
    remaining: headers?.['x-ratelimit-remaining'],
    reset: headers?.['x-ratelimit-reset'],
  };
}

/**
 * Builds a human-friendly description of the current rate limit state, suitable
 * for use in error messages and warnings. Returns `undefined` when no rate
 * limit information was present in the response headers.
 */
export function describeRateLimit(
  headers: ResponseHeaders | undefined
): string | undefined {
  const {limit, remaining, reset} = parseRateLimitHeaders(headers);
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (remaining !== undefined) {
    parts.push(`${remaining} remaining`);
  }
  if (limit !== undefined) {
    parts.push(`of ${limit}`);
  }
  if (reset !== undefined) {
    const resetSeconds = Number(reset);
    if (!Number.isNaN(resetSeconds)) {
      parts.push(`(resets at ${new Date(resetSeconds * 1000).toUTCString()})`);
    }
  }
  return parts.join(' ');
}

export class AuthError extends GitHubAPIError {
  constructor(requestError: RequestError) {
    super(requestError, 'unauthorized');
    this.status = 401;
    this.name = AuthError.name;
  }
}

export class DuplicateReleaseError extends GitHubAPIError {
  tag: string;
  constructor(requestError: RequestError, tag: string) {
    super(requestError);
    this.tag = tag;
    this.name = DuplicateReleaseError.name;
  }
}

export class FileNotFoundError extends Error {
  path: string;
  constructor(path: string) {
    super(`Failed to find file: ${path}`);
    this.path = path;
    this.name = FileNotFoundError.name;
  }
}
