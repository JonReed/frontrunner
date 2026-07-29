/**
 * One outbound-network policy for every scanner and provider.
 *
 * Job URLs and provider responses are attacker-controlled. A URL being public
 * text does not make its destination safe: redirects and DNS can still point
 * at localhost, a LAN service, or cloud metadata.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const ALLOWED_REMOTE_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeHostname(rawHostname) {
  let host = String(rawHostname ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function ipv4Number(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inIpv4Range(address, base, prefix) {
  const value = ipv4Number(address);
  const start = ipv4Number(base);
  if (value === null || start === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (start & mask);
}

function mappedIpv4(address) {
  const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted && ipv4Number(dotted[1]) !== null) return dotted[1];
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isRestrictedAddress(rawAddress) {
  const address = normalizeHostname(rawAddress);
  const mapped = mappedIpv4(address);
  if (mapped) return isRestrictedAddress(mapped);

  if (isIP(address) === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inIpv4Range(address, base, prefix));
  }

  if (isIP(address) === 6) {
    return address === '::'
      || address === '::1'
      || /^::/i.test(address)
      || /^f[cd][0-9a-f]{2}:/i.test(address)
      || /^fe[89ab][0-9a-f]:/i.test(address)
      || /^fe[c-f][0-9a-f]:/i.test(address)
      || /^ff[0-9a-f]{2}:/i.test(address)
      || /^2001:0*:/i.test(address)
      || /^2001:db8:/i.test(address)
      || /^2002:/i.test(address);
  }
  return false;
}

export function inspectRemoteUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { code: 'invalid_url', reason: 'invalid URL' };
  }
  if (!ALLOWED_REMOTE_PROTOCOLS.has(url.protocol)) {
    return { code: 'unsupported_protocol', reason: `unsupported protocol ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { code: 'embedded_credentials', reason: 'URLs with embedded credentials are not allowed' };
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return { code: 'invalid_host', reason: 'URL has no hostname' };
  if (hostname === 'localhost' || hostname === 'localhost.localdomain' || isRestrictedAddress(hostname)) {
    return { code: 'blocked_host', reason: `blocked host ${url.hostname}` };
  }
  return null;
}

export async function resolvePublicAddresses(hostname) {
  const records = await lookup(normalizeHostname(hostname), { all: true, verbatim: true });
  const addresses = [...new Set(records.map((record) => record.address))];
  if (addresses.length === 0) throw new Error(`DNS resolution returned no addresses for ${hostname}`);
  return addresses;
}

export async function assertSafeRemoteUrl(
  rawUrl,
  { resolveHostname = resolvePublicAddresses } = {},
) {
  return (await resolveSafeRemoteTarget(rawUrl, { resolveHostname })).url;
}

export async function resolveSafeRemoteTarget(
  rawUrl,
  { resolveHostname = resolvePublicAddresses } = {},
) {
  const rejected = inspectRemoteUrl(rawUrl);
  if (rejected) {
    const error = new Error(`Egress denied: ${rejected.reason}`);
    error.code = rejected.code;
    throw error;
  }
  const url = new URL(String(rawUrl));
  const addresses = await resolveHostname(normalizeHostname(url.hostname));
  for (const address of addresses) {
    if (!isIP(address)) {
      const error = new Error(`Egress denied: DNS returned invalid address ${address}`);
      error.code = 'invalid_address';
      throw error;
    }
    if (isRestrictedAddress(address)) {
      const error = new Error(`Egress denied: DNS resolved ${url.hostname} to restricted address ${address}`);
      error.code = 'blocked_address';
      throw error;
    }
  }
  return {
    url,
    addresses: [...new Set(addresses.map(String))],
  };
}
