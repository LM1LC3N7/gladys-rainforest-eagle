// -----------------------------------------------------------------------------
// The local API of a Rainforest Eagle-200 (and Eagle-3), plain HTTP on the
// home network, no cloud, after aioeagle (home-assistant-libs, Apache-2.0,
// see THIRD_PARTY_NOTICES.md): an XML command POSTed to
// `/cgi-bin/post_manager`, with the Cloud ID and the install code of the
// label as HTTP Basic credentials, one second between two requests.
//
// READ-ONLY: only the two read commands of COMMANDS (`device_list`,
// `device_query`); no command of the API that changes anything (price,
// schedule, message confirmation, cloud) is ever sent: there is no method
// for it.
//
// The credentials are only ever placed in the header of a request to the
// configured address; a redirect is never followed. Errors carry our own
// codes, never a text of the Eagle, never a URL, never the credentials.
// Every body is bounded (256 KiB), read into one buffer.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, MAX_BODY_BYTES, PATH, REQUEST_GAP } from '../constants.js';
import {
  AnswerError,
  deviceListCommand,
  deviceQueryCommand,
  parseDeviceList,
  parseDeviceQuery,
} from './model.js';
import { XmlError, parseXml } from './xml.js';

export class EagleError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'refused'|'http'|'server'|'rate_limited'|'too_large'|
   *   'not_xml'|'unknown_answer'} code
   */
  constructor(code, { status, retryAfter } = {}) {
    super(code);
    this.name = 'EagleError';
    this.code = code;
    this.status = status;
    /** ms, from a Retry-After header (429, 503), when given. */
    this.retryAfter = retryAfter;
  }
}

function networkError(err) {
  if (err instanceof EagleError) {
    return err;
  }
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new EagleError(timeout ? 'timeout' : 'unreachable');
}

/**
 * The body, read into ONE buffer of at most `limit` bytes (no buffer kept per
 * chunk, no concatenation): a longer one is not an answer of the Eagle.
 */
export async function readBounded(response, limit) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const buffer = Buffer.allocUnsafe(limit);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (size + value.byteLength > limit) {
      await reader.cancel().catch(() => {});
      throw new EagleError('too_large');
    }
    buffer.set(value, size);
    size += value.byteLength;
  }
  return buffer.toString('utf8', 0, size);
}

/** Retry-After in seconds (or an HTTP date) -> ms, undefined when absent or odd. */
function retryAfterOf(response, now) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(raw.trim())) {
    return Number(raw.trim()) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : undefined;
}

/** The HTTP Basic header of the Cloud ID and the install code. */
export const basicAuth = (cloudId, installCode) =>
  `Basic ${Buffer.from(`${cloudId}:${installCode}`, 'utf8').toString('base64')}`;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EagleClient {
  constructor({
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeout = HTTP_TIMEOUT,
    now = Date.now,
    monotonic = () => performance.now(),
    sleep = defaultSleep,
    gap = REQUEST_GAP,
  } = {}) {
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.now = now;
    this.monotonic = monotonic;
    this.sleep = sleep;
    this.gap = gap;
    /** Monotonic time before which no request starts (one second after the last one). */
    this.nextRequestAt = 0;
  }

  /** One command POSTed to `address` (`host:port`): the root element of its XML answer. */
  async post(address, { cloudId, installCode }, command) {
    const wait = this.nextRequestAt - this.monotonic();
    if (wait > 0) {
      await this.sleep(Math.min(wait, this.gap));
    }
    let response;
    let text;
    try {
      response = await this.fetch(`http://${address}${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(cloudId, installCode),
          'Content-Type': 'text/xml',
        },
        body: command,
        // A redirect is never followed: the credentials stay on this address.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeout),
      });
      // The body can fail too (timeout, connection cut): same errors.
      text = await readBounded(response, MAX_BODY_BYTES);
    } catch (err) {
      throw networkError(err);
    } finally {
      this.nextRequestAt = this.monotonic() + this.gap;
    }
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new EagleError('refused', { status });
    }
    if (status === 429 || status >= 500) {
      throw new EagleError(status === 429 ? 'rate_limited' : 'server', {
        status,
        retryAfter: retryAfterOf(response, this.now),
      });
    }
    if (status < 200 || status >= 300) {
      throw new EagleError('http', { status });
    }
    try {
      return parseXml(text);
    } catch (err) {
      if (err instanceof XmlError) {
        throw new EagleError('not_xml');
      }
      throw err;
    }
  }

  /** The electricity meters the Eagle lists: `{ meters: [{ id, connected }], others }`. */
  async readDeviceList(address, credentials) {
    const root = await this.post(address, credentials, deviceListCommand());
    try {
      return parseDeviceList(root);
    } catch (err) {
      if (err instanceof AnswerError) throw new EagleError('unknown_answer');
      throw err;
    }
  }

  /** The values of one meter (src/eagle/model.js parseDeviceQuery). */
  async readMeter(address, credentials, id) {
    const root = await this.post(address, credentials, deviceQueryCommand(id));
    try {
      return parseDeviceQuery(root, id);
    } catch (err) {
      if (err instanceof AnswerError) throw new EagleError('unknown_answer');
      throw err;
    }
  }

  /**
   * One read: the device list first (required: it proves that the Eagle at
   * this address takes these credentials), then the query of each meter. A
   * query that fails with an error of the Eagle (5xx, an odd answer) only
   * leaves that meter out (`missing`); one that refuses the credentials too
   * (`denied`: the device list just took them); only a refusal of the device
   * list is refused credentials. A 429 stops the read; a network failure
   * stops the remaining queries. `alive()` false (a restart, a new
   * configuration) stops between two requests.
   * @returns {Promise<{ meters, others, values: Map<string, object>,
   *   missing: string[], denied: string[] }>}
   */
  async readAll(address, credentials, alive = () => true) {
    const { meters, others } = await this.readDeviceList(address, credentials);
    const result = { meters, others, values: new Map(), missing: [], denied: [] };
    for (const [n, { id }] of meters.entries()) {
      if (!alive()) {
        break;
      }
      try {
        result.values.set(id, await this.readMeter(address, credentials, id));
      } catch (err) {
        if (err.code === 'rate_limited') {
          throw err;
        }
        if (err.code === 'refused') {
          result.denied.push(id);
          continue;
        }
        result.missing.push(id);
        if (err.code === 'timeout' || err.code === 'unreachable') {
          result.missing.push(...meters.slice(n + 1).map((m) => m.id));
          break;
        }
      }
    }
    return result;
  }
}
