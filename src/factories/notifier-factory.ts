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

import {ConfigurationError} from '../errors';
import {Notifier} from '../notifiers';
import {WebhookNotifier} from '../notifiers/webhook';
import {Logger} from '../util/logger';

export type NotifierType = string;

/**
 * Configuration for the `webhook` notifier. Notifications are sent as JSON
 * to the given URL, e.g. `{"action": "create release", "data": {...}}`.
 */
export interface WebhookNotifierConfig {
  type: 'webhook';
  url: string;
}
export type NotifierConfig = WebhookNotifierConfig;

export interface NotifierFactoryOptions {
  type: NotifierType;
  repository?: string;
  logger?: Logger;

  // webhook options
  url?: string;
}

export type NotifierBuilder = (options: NotifierFactoryOptions) => Notifier;

const notifierFactories: Record<string, NotifierBuilder> = {
  webhook: options => {
    if (!options.url) {
      throw new ConfigurationError(
        'Missing required url for webhook notifier',
        'core',
        options.repository ?? 'notifier'
      );
    }
    return new WebhookNotifier({
      url: options.url,
      logger: options.logger,
    });
  },
};

export function buildNotifier(options: NotifierFactoryOptions): Notifier {
  const builder = notifierFactories[options.type];
  if (builder) {
    return builder(options);
  }
  throw new ConfigurationError(
    `Unknown notifier type: ${options.type}`,
    'core',
    options.repository ?? 'notifier'
  );
}

export function registerNotifier(
  name: string,
  notifierBuilder: NotifierBuilder
) {
  notifierFactories[name] = notifierBuilder;
}

export function unregisterNotifier(name: string) {
  delete notifierFactories[name];
}

export function getNotifierTypes(): readonly NotifierType[] {
  return Object.keys(notifierFactories).sort();
}
