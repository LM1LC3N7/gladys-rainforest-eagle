// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// The Cloud ID and the install code (both printed on the label of the Eagle)
// are the user name and the password of its local API. The install code is a
// secret: never logged, never shown, never written to /data, and only ever
// sent to the configured address, in the Authorization header. The Cloud ID
// is not logged either.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, POLL_DEFAULT, POLL_MAX, POLL_MIN } from './constants.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port (80 when absent). A pasted URL ("http://192.168.1.30/x") is
 * reduced to its host and port. (The parser of gladys-p1-monitor.)
 * @returns {{ address: string } | { error: 'invalid' } | { empty: true }}
 *   `address` is always `host:port`.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { empty: true };
  }
  if (text.length > 300) {
    return { error: 'invalid' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(`[${bracketed[1].toLowerCase()}]`, bracketed[2]);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return withPort(`[${text.toLowerCase()}]`, undefined);
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2]);
}

function withPort(host, port) {
  const number = port === undefined ? DEFAULT_PORT : Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { address: `${host}:${number}` };
}

/** The Cloud ID: letters and digits (6 hexadecimal digits on the label), lower case. */
const CLOUD_ID = /^[0-9a-z]{4,32}$/i;
/**
 * The install code: printable ASCII without space nor colon (it goes into an
 * HTTP Basic header), 8 to 64 characters (16 on the label). Anything else is
 * refused before any request, without being echoed.
 */
const INSTALL_CODE = /^[\x21-\x39\x3b-\x7e]{8,64}$/;

/** The reading interval (s): a number from 30 to 300, else 30. */
function pollOf(raw) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return POLL_DEFAULT;
  }
  return Math.min(POLL_MAX, Math.max(POLL_MIN, Math.round(value)));
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * `{ address, cloudId, installCode, pollInterval, problem }`: `address`,
 * `cloudId` and `installCode` are undefined when anything is missing or
 * invalid; `problem` is 'address_missing', 'address_invalid',
 * 'cloud_id_missing', 'cloud_id_invalid', 'install_code_missing',
 * 'install_code_invalid' or undefined.
 */
export function normalizeConfig(raw = {}) {
  const parsed = parseAddress(text(raw?.address));
  const cloudText = text(raw?.cloud_id);
  const codeText = text(raw?.install_code);
  let problem;
  if (parsed.empty) problem = 'address_missing';
  else if (parsed.error) problem = 'address_invalid';
  else if (cloudText === '') problem = 'cloud_id_missing';
  else if (!CLOUD_ID.test(cloudText)) problem = 'cloud_id_invalid';
  else if (codeText === '') problem = 'install_code_missing';
  else if (!INSTALL_CODE.test(codeText)) problem = 'install_code_invalid';
  return {
    address: parsed.address,
    cloudId: problem ? undefined : cloudText.toLowerCase(),
    installCode: problem ? undefined : codeText,
    pollInterval: pollOf(raw?.poll_interval),
    problem,
  };
}
