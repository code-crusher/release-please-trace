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

import {Notification, Notifier} from '../notifiers';
import {Logger} from '../util/logger';
import {logger as defaultLogger} from '../util/logger';

/**
 * Default time to wait for a webhook response before giving up.
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10000;

/**
 * Sends notifications as JSON to a webhook URL, e.g. to forward release
 * events to external systems like Jira.
 */
export class WebhookNotifier implements Notifier {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: {
    url: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    logger?: Logger;
  }) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? fetch;
    this.logger = options.logger ?? defaultLogger;
  }

  async send(notification: Notification): Promise<void> {
    const response = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(notification),
      // notifications are best-effort: don't hang the release on a
      // slow endpoint
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `webhook notification failed: ${response.status} ${response.statusText}`
      );
    }
    this.logger.debug(
      `sent webhook notification for action '${notification.action}' to ${this.url}`
    );
  }
}
