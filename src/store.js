// -----------------------------------------------------------------------------
// What must survive a restart of the container (a small JSON file under
// /data, the only writable place): the instant of the last request (written
// at most once a minute), a pause asked by the Eagle (429/5xx), refused
// credentials, the guards of the energy index, and the hardware addresses of
// the meters read (for the Discovery list; nothing secret, no text of the
// Eagle).
//
// The install code and the Cloud ID are never written. Only while they are
// refused, the file keeps a salted scrypt fingerprint (16 bytes, a random
// salt per file) of that refused pair, to know after a restart whether the
// refusal still concerns the configured one; it is erased by the first
// successful read. Nothing in the file can confirm credentials that work.
// (After gladys-sonnen and gladys-air-q.)
//
// Written through a temporary file and a rename, one write at a time; a
// failure is logged, never fatal.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { MAX_METERS } from './constants.js';

export const DEFAULT_STATE_FILE = '/data/rainforest-eagle-state.json';
const MAX_FILE = 64 * 1024;

/** A JSON file: `load()` (sync, `{}` when absent or odd) and `save(data)` (atomic). */
export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      try {
        const text = readFileSync(file, 'utf8');
        if (text.length > MAX_FILE) return {};
        const data = JSON.parse(text);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  let saves = 0;
  return {
    load: () => structuredClone(data),
    async save(next) {
      saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
    get saves() {
      return saves;
    },
  };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A pause read back: `{ until, count, code, status }`, its end capped from now. */
export function validPause(pause, now, max) {
  if (
    !isObject(pause) ||
    finite(pause.until) === undefined ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    (pause.code !== 'rate_limited' && pause.code !== 'server')
  ) {
    return undefined;
  }
  return {
    until: Math.min(pause.until, now + max),
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : null,
  };
}

/** A refusal read back: `{ status, fp }` (final: no automatic retry, src/app.js). */
export function validRefusal(refusal) {
  if (!isObject(refusal) || typeof refusal.fp !== 'string' || !/^[0-9a-f]{32}$/.test(refusal.fp)) {
    return undefined;
  }
  return { status: refusal.status === 403 ? 403 : 401, fp: refusal.fp };
}

/** The meter ids read back: hexadecimal hardware addresses only. */
export const validMeters = (meters) =>
  Array.isArray(meters)
    ? [
        ...new Set(meters.filter((id) => typeof id === 'string' && /^[0-9a-f]{1,16}$/.test(id))),
      ].slice(0, MAX_METERS)
    : [];

/**
 * The persisted state, sanitized: times capped (a request never "in the
 * future", a pause never longer than a fresh one), so a clock that jumped or
 * a hand-edited file never stops the Eagle for longer.
 */
export function readState(raw, now, { maxPause }) {
  const data = isObject(raw) ? raw : {};
  const salt =
    typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
      ? data.salt
      : randomBytes(16).toString('hex');
  const address =
    typeof data.address === 'string' && data.address.length <= 300 ? data.address : null;
  const indexes = {};
  if (isObject(data.indexes)) {
    for (const [id, state] of Object.entries(data.indexes).slice(0, 20)) {
      // Feature external ids only (`ext:…`): never `__proto__` or another odd key.
      if (id.startsWith('ext:') && id.length <= 200 && isObject(state)) indexes[id] = state;
    }
  }
  return {
    salt,
    address,
    lastAttemptAt: Math.min(finite(data.lastAttemptAt) ?? 0, now),
    pause: address ? (validPause(data.pause, now, maxPause) ?? null) : null,
    // Kept until a read succeeds or other credentials are saved.
    refusal: address ? (validRefusal(data.refusal) ?? null) : null,
    meters: validMeters(data.meters),
    indexes,
  };
}

/** The salted fingerprint of REFUSED credentials for an address (never the credentials). */
export function fingerprint(salt, address, cloudId, installCode) {
  return scryptSync(`${cloudId}:${installCode}`, `${salt}:${address}`, 16).toString('hex');
}
