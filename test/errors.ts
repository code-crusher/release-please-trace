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
import {RequestError} from '@octokit/request-error';

import {
  GitHubAPIError,
  describeRateLimit,
  parseRateLimitHeaders,
} from '../src/errors';

function makeRequestError(
  status: number,
  message: string,
  headers: Record<string, string> = {}
): RequestError {
  return new RequestError(message, status, {
    response: {
      headers,
      status,
      url: 'https://api.github.com/rate_limit',
      data: {message},
    },
    request: {
      headers: {},
      method: 'GET',
      url: 'https://api.github.com/rate_limit',
    },
  });
}

describe('errors', () => {
  describe('GitHubAPIError', () => {
    it('preserves the message for non-rate-limit errors', () => {
      const error = new GitHubAPIError(makeRequestError(500, 'Server Error'));
      expect(error.message).to.eql('Server Error');
      expect(error.status).to.eql(500);
    });

    it('clearly reports a 429 rate limit error', () => {
      const error = new GitHubAPIError(
        makeRequestError(429, 'API rate limit exceeded', {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1800000000',
        })
      );
      expect(error.message).to.include('GitHub rate limit exceeded');
      expect(error.message).to.include('0 remaining of 5000');
    });

    it('clearly reports a 429 rate limit error without headers', () => {
      const error = new GitHubAPIError(
        makeRequestError(429, 'API rate limit exceeded')
      );
      expect(error.message).to.eql('GitHub rate limit exceeded.');
    });

    it('reports a 403 as rate limiting only when headers confirm it', () => {
      const exhausted = new GitHubAPIError(
        makeRequestError(403, 'API rate limit exceeded', {
          'x-ratelimit-remaining': '0',
        })
      );
      expect(exhausted.message).to.include(
        'GitHub rate limit may have been exceeded'
      );
    });

    it('leaves a plain 403 permission error untouched', () => {
      const error = new GitHubAPIError(
        makeRequestError(403, 'Resource not accessible by integration')
      );
      expect(error.message).to.eql('Resource not accessible by integration');
    });
  });

  describe('describeRateLimit', () => {
    it('returns undefined when no rate limit headers are present', () => {
      expect(describeRateLimit(undefined)).to.be.undefined;
      expect(describeRateLimit({})).to.be.undefined;
    });

    it('describes the remaining, limit, and reset time', () => {
      const description = describeRateLimit({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': '1800000000',
      });
      expect(description).to.eql(
        '42 remaining of 5000 (resets at Fri, 15 Jan 2027 08:00:00 GMT)'
      );
    });

    it('handles partial header information', () => {
      expect(describeRateLimit({'x-ratelimit-remaining': '0'})).to.eql(
        '0 remaining'
      );
      expect(describeRateLimit({'x-ratelimit-limit': '60'})).to.eql('of 60');
    });
  });

  describe('parseRateLimitHeaders', () => {
    it('extracts the x-ratelimit headers', () => {
      expect(
        parseRateLimitHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '10',
          'x-ratelimit-reset': '1800000000',
        })
      ).to.eql({
        limit: '5000',
        remaining: '10',
        reset: '1800000000',
      });
    });

    it('returns empty values when no headers are present', () => {
      expect(parseRateLimitHeaders(undefined)).to.eql({
        limit: undefined,
        remaining: undefined,
        reset: undefined,
      });
    });
  });
});
