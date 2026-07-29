/**
 * Process-wide outbound-network barrier for the hermetic test suite.
 *
 * Loaded through NODE_OPTIONS by test-all.mjs, so every Node subprocess
 * inherits it. Tests exercise transports through injected functions and fake
 * browser pages; an accidental real fetch/socket/DNS lookup fails immediately.
 */

import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const INSTALLED = Symbol.for('frontrunner.testHermeticNetworkBarrier');
const ERROR_CODE = 'FRONTRUNNER_TEST_NETWORK_DENIED';

function denied(operation) {
  const error = new Error(
    `Hermetic test suite blocked outbound network access (${operation}). `
      + 'Inject a transport or use a local in-memory fixture.',
  );
  error.code = ERROR_CODE;
  return error;
}

function rejectCallback(operation, args) {
  const callback = [...args].reverse().find(value => typeof value === 'function');
  const error = denied(operation);
  if (callback) {
    process.nextTick(callback, error);
    return;
  }
  throw error;
}

function install() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;

  globalThis.fetch = async () => {
    throw denied('fetch');
  };

  for (const module of [http, https]) {
    module.request = () => { throw denied(`${module === https ? 'https' : 'http'}.request`); };
    module.get = () => { throw denied(`${module === https ? 'https' : 'http'}.get`); };
  }

  net.connect = net.createConnection = () => { throw denied('net.connect'); };
  net.Socket.prototype.connect = function blockedSocketConnect() {
    throw denied('net.Socket.connect');
  };
  tls.connect = () => { throw denied('tls.connect'); };
  dgram.createSocket = () => { throw denied('dgram.createSocket'); };

  for (const name of [
    'lookup',
    'lookupService',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ]) {
    if (typeof dns[name] === 'function') {
      dns[name] = (...args) => rejectCallback(`dns.${name}`, args);
    }
    if (typeof dnsPromises[name] === 'function') {
      dnsPromises[name] = async () => { throw denied(`dns.promises.${name}`); };
    }
  }

  for (const name of [
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ]) {
    if (typeof dns.Resolver?.prototype?.[name] === 'function') {
      dns.Resolver.prototype[name] = (...args) => {
        rejectCallback(`dns.Resolver.${name}`, args);
      };
    }
    if (typeof dnsPromises.Resolver?.prototype?.[name] === 'function') {
      dnsPromises.Resolver.prototype[name] = async () => {
        throw denied(`dns.promises.Resolver.${name}`);
      };
    }
  }

  syncBuiltinESMExports();
}

if (process.env.FRONTRUNNER_TEST_HERMETIC === '1') install();
