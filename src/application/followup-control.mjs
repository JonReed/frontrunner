#!/usr/bin/env node

/**
 * Bounded JSON adapter for recording follow-ups.
 *
 * Same contract as the other controls: one fixed script, one bounded request
 * on stdin, no request field that can select a path, an executable or a flag.
 * The request names an application number and what happened to it; the tracker
 * module decides where that lands and what it means for the schedule.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';
import {
  FOLLOWUP_CHANNELS,
  logFollowup,
  snoozeFollowup,
} from '../tracker/followup-log.mjs';

const CONTROL_KEYS = new Set(['version', 'action', 'appNum', 'channel', 'note', 'date']);
const ACTIONS = new Set(['log', 'snooze']);

function controlError(message, code = 'INVALID_FOLLOWUP_CONTROL_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateFollowupControlRequest(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw controlError('followup-control request must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported followup-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported followup-control version: ${String(value.version ?? '')}`);
  }
  if (!ACTIONS.has(value.action)) {
    throw controlError(`unsupported followup-control action: ${String(value.action ?? '')}`);
  }
  if (!Number.isSafeInteger(value.appNum) || value.appNum < 1 || value.appNum > 999_999) {
    throw controlError('appNum must be a positive application number');
  }

  if (value.action === 'snooze') {
    for (const key of ['channel', 'note']) {
      if (value[key] !== undefined) throw controlError(`snooze does not accept ${key}`);
    }
    if (typeof value.date !== 'string') throw controlError('snooze needs a date');
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'snooze',
      appNum: value.appNum,
      date: value.date,
    });
  }

  if (value.channel !== undefined && !FOLLOWUP_CHANNELS.includes(value.channel)) {
    throw controlError('unsupported follow-up channel');
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    throw controlError('note must be text');
  }
  if (value.date !== undefined && typeof value.date !== 'string') {
    throw controlError('date must be text');
  }
  return Object.freeze({
    version: APPLICATION_API_VERSION,
    action: 'log',
    appNum: value.appNum,
    channel: value.channel ?? 'Email',
    note: value.note ?? '',
    date: value.date,
  });
}

export async function main({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    const control = validateFollowupControlRequest(await readBoundedRequest(input));
    const result = control.action === 'snooze'
      ? await snoozeFollowup(control.appNum, control.date)
      : await logFollowup(control.appNum, {
          channel: control.channel,
          note: control.note,
          ...(control.date ? { date: control.date } : {}),
        });

    output.write(`${JSON.stringify({ version: APPLICATION_API_VERSION, ...result })}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'FOLLOWUP_CONTROL_PROTOCOL_ERROR',
    })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
