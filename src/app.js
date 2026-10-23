// -----------------------------------------------------------------------------
// The integration itself: the Eagle of the configuration (address, Cloud ID,
// install code), read every 30 s by default (device list, then the query of
// each electricity meter), one device per meter, the consumption index
// checked by its guard, the pauses and the refused credentials kept in /data,
// the test and accept buttons. index.js only wires the SDK handlers to it.
//
// READ-ONLY: only the `device_list` and `device_query` commands; nothing of
// the Eagle or of the meter is ever changed (no onSetValue at all).
//
// Pace: nothing reads the Eagle faster than the interval: not the timer, not
// the test button, not Discovery, not a (re)connection to Gladys, not a save
// of an unchanged configuration, not a restart of the container (the instant
// of the last request is kept in /data, written at most once a minute). New
// credentials or a new address may be read at once.
//
// Refused credentials (401/403 of the device list) are FINAL: kept in /data,
// never tried again by the timer. Only a gesture of the user tries again: the
// test button (once per click, at the pace of the interval), or other
// credentials saved. A success erases the refusal.
//
// A read belongs to its generation (each start/stop opens a new one): a read
// that ends after a restart or a new configuration publishes nothing and sets
// no status. Identity: every read asks the device list first, with the
// credentials of the label of this Eagle (another Eagle at the address, after
// a DHCP exchange, refuses them); each meter is its own device, named by its
// hardware address.
//
// Two clocks: `now` (wall clock) dates the index and what /data keeps;
// `monotonic` paces the reads, so that a wall clock set back never stops them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ACCEPT_CONFIRM_AFTER,
  ACCEPT_CONFIRM_WITHIN,
  ATTEMPT_SAVE_EVERY,
  FRESH_INTERVALS,
  INDEX_LIMITS,
  MAX_METERS,
  PAUSE_MAX,
  PAUSE_MIN,
  RETRY_MAX,
  RETRY_MIN,
  STATE_HEARTBEAT,
  STATES_PER_MINUTE,
  TEST_ANSWER_WITHIN,
  TICK,
} from './constants.js';
import { INDEXES, buildDevice, ids, meterIdOf, readStates, round } from './devices.js';
import { EagleClient } from './eagle/client.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { createFileStore, fingerprint, readState } from './store.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

const MINUTE = 60_000;

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

export class EagleApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'rainforest-eagle' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    client,
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.client = client ?? new EagleClient({ now, monotonic });
    this.store = store;
    /** What /data keeps (src/store.js readState), read once. */
    this.kept = readState(store.load(), now(), { maxPause: PAUSE_MAX });
    /** The instant of the last request as written in /data (written at most once a minute). */
    this.savedAttemptAt = this.kept.lastAttemptAt;
    /**
     * After a restart of the container: the first read waits the interval
     * and the minute the last request may have come after the one written.
     */
    this.restartedAt = this.kept.lastAttemptAt > 0 ? this.kept.lastAttemptAt : 0;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** The credentials of the last start (memory only): other ones may be tried at once. */
    this.knownCredentials = undefined;
    /** Monotonic time of the last request started, in this process. */
    this.lastAttemptMono = undefined;
    /** Unreachable / odd answer: failures in a row, the monotonic time of the next try. */
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
    /** The last good read: its answer (src/eagle/client.js readAll) and monotonic time. */
    this.reading = undefined;
    this.valuesAt = undefined;
    this.readAt = undefined;
    /** By index feature external id: IndexGuard. */
    this.guards = new Map();
    /** The first click of "Accept the held index": `{ at, listedAt, list }`, in memory only. */
    this.pendingAccept = undefined;
    this.publishedDevices = undefined;
    /** The states sent in the last minute: `[{ at, count }]`, monotonic (STATES_PER_MINUTE). */
    this.sent = [];
    /** By index feature external id: the hold last logged (`direction:from`). */
    this.loggedHolds = new Map();
    this.timer = undefined;
    this.busy = undefined;
    this.firstRun = Promise.resolve();
    this.lastStatus = undefined;
    this.generation = 0;
    this.lifecycle = Promise.resolve();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** `fresh`: the user saved the form (not a reconnection). It accepts no index held back. */
  start(raw = {}, { fresh = false } = {}) {
    return this.serialize(() => this.doStart(raw, { fresh }));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read after it are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.firstRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  credentials() {
    const { cloudId, installCode } = this.config;
    return { cloudId, installCode };
  }

  async doStart(raw, { fresh = false } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    const { address, cloudId, installCode } = this.config;
    let changed = false;
    if (address && address !== this.kept.address) {
      // Another address: its pace, pause and refusal start afresh (the
      // devices and their indexes stay: the same Eagle may have moved).
      Object.assign(this.kept, { address, lastAttemptAt: 0, pause: null, refusal: null });
      this.savedAttemptAt = 0;
      this.restartedAt = 0;
      this.forgetPace();
      this.reading = undefined;
      changed = true;
    }
    if (address && cloudId && installCode) {
      const key = `${cloudId}:${installCode}`;
      const refusal = this.kept.refusal;
      const other =
        this.knownCredentials !== undefined
          ? this.knownCredentials !== key
          : Boolean(refusal) &&
            refusal.fp !== fingerprint(this.kept.salt, address, cloudId, installCode);
      this.knownCredentials = key;
      if (other) {
        // Other credentials: tried at once (a pause asked by the Eagle stays).
        this.kept.refusal = null;
        this.restartedAt = 0;
        this.forgetPace();
        changed = true;
      }
    }
    if (changed) {
      await this.saveState();
    }
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again.
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    if (!fresh) {
      // A (re)connection: every value again at the next read.
      this.gladys.forgetPublishedStates?.();
    }
    await this.discover();
    await this.updateStatus({ starting: true });
    // Always armed, whatever the first read gives: never a dead integration.
    this.timer = this.timers.setInterval(() => this.run(generation, () => this.tick()), TICK);
    this.firstRun = this.run(generation, () => this.tick());
  }

  forgetPace() {
    this.lastAttemptMono = undefined;
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
  }

  async doStop() {
    this.generation += 1;
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run a job of a generation: nothing after a restart. */
  async run(generation, job) {
    if (generation !== this.generation) {
      return undefined;
    }
    try {
      return await job();
    } catch (err) {
      this.logger.error(`Eagle: unexpected error (${err?.name ?? 'Error'})`);
      return undefined;
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Devices --------------------------------------------------------------------

  /** The created Gladys device of meter `id`, undefined until the user creates it. */
  createdDevice(id) {
    const external = ids(this.gladys, id).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === external);
  }

  async discover({ force = false } = {}) {
    const address = this.config.address ?? this.kept.address ?? undefined;
    const devices = this.config.address
      ? this.kept.meters.map((id) => buildDevice(this.gladys, id, address))
      : [];
    const json = JSON.stringify(devices);
    if (!force && json === this.publishedDevices) {
      return;
    }
    this.publishedDevices = json;
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) => this.logger.warn(`Publishing the Eagle meters failed: ${err.message}`));
  }

  /** The Discover tab: the meters known, published again; never a request to the Eagle. */
  async scan() {
    await this.discover({ force: true });
    await this.updateStatus();
  }

  isFresh() {
    return (
      this.reading !== undefined &&
      this.monotonic() - this.valuesAt <= FRESH_INTERVALS * this.config.pollInterval * 1000
    );
  }

  /** A device just created: the values of the last read now (no new request). */
  async onDeviceCreated(device) {
    const id = meterIdOf(this.gladys, device?.external_id);
    if (id === undefined) {
      return;
    }
    // A new device: no reference of its index yet (nor a state kept in /data
    // for a deleted device of the same id).
    for (const { key } of INDEXES) {
      const featureId = ids(this.gladys, id).feature(key);
      this.guards.delete(featureId);
      delete this.kept.indexes[featureId];
    }
    this.savedKey = undefined;
    await this.saveState();
    await this.publishLast();
  }

  async onDeviceUpdated(device) {
    if (meterIdOf(this.gladys, device?.external_id) !== undefined) {
      await this.publishLast();
    }
  }

  async publishLast() {
    const generation = this.generation;
    if (!this.isFresh()) return;
    const prepared = this.prepare(this.reading);
    await this.saveState();
    if (prepared && generation === this.generation) {
      await this.send(prepared);
      if (generation === this.generation) await this.updateStatus();
    }
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the state in /data when it changed. The instant of the last request
   * is written at most once a minute (the one already written otherwise).
   */
  async saveState() {
    const indexes = { ...this.kept.indexes };
    for (const [id, guard] of this.guards) {
      indexes[id] = guard.state();
    }
    this.kept.indexes = indexes;
    const now = this.now();
    const attempt =
      this.kept.lastAttemptAt !== this.savedAttemptAt &&
      (this.savedAttemptAt === 0 || now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY)
        ? this.kept.lastAttemptAt
        : this.savedAttemptAt;
    const state = {
      salt: this.kept.salt,
      address: this.kept.address,
      lastAttemptAt: attempt,
      pause: this.kept.pause,
      refusal: this.kept.refusal,
      meters: this.kept.meters,
      indexes,
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
      this.savedAttemptAt = attempt;
    } catch (err) {
      this.logger.warn(`Saving the Eagle state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Reads -------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollInterval * 1000;
  }

  /** The wait after a failure: never faster than a read, doubled up to 15 min. */
  retryWait(failures) {
    const first = Math.max(RETRY_MIN, this.intervalMs());
    return Math.min(first * 2 ** failures, Math.max(RETRY_MAX, first));
  }

  /**
   * The earliest instant (wall clock) of the next read, whatever asks for it.
   * Refused credentials: never for the timer (Infinity), only for a click.
   */
  nextReadAt({ manual = false } = {}) {
    if (!manual && this.kept.refusal) {
      return Infinity;
    }
    const now = this.now();
    const mono = this.monotonic();
    const at = [now];
    if (this.lastAttemptMono !== undefined) {
      // Never sooner than the interval (the timer looks every 5 s: 30 to 35 s at 30 s).
      at.push(now + this.lastAttemptMono + this.intervalMs() - mono);
    }
    if (this.retryAtMono > mono) at.push(now + this.retryAtMono - mono);
    if (this.restartedAt > 0) {
      at.push(this.restartedAt + ATTEMPT_SAVE_EVERY + this.intervalMs());
    }
    if (this.kept.pause) at.push(this.kept.pause.until);
    return Math.max(...at);
  }

  due(options) {
    return (
      Boolean(this.config.installCode) &&
      !this.config.problem &&
      this.nextReadAt(options) <= this.now()
    );
  }

  /**
   * One look: a read when one is due. A read still running is never doubled,
   * whatever its generation (a reconnection during a read starts no other).
   */
  tick({ manual = false } = {}) {
    if (this.busy) {
      return this.busy;
    }
    if (!this.due({ manual })) {
      return undefined;
    }
    const generation = this.generation;
    this.busy = this.read(generation).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read(generation) {
    const { address } = this.config;
    const credentials = this.credentials();
    const alive = () => generation === this.generation;
    // Recorded first: neither a reconnection, a save nor a restart reads sooner.
    this.lastAttemptMono = this.monotonic();
    this.restartedAt = 0;
    this.kept.lastAttemptAt = this.now();
    await this.saveState();
    let reading;
    try {
      reading = await this.client.readAll(address, credentials, alive);
    } catch (err) {
      await this.failed(err, { address, credentials, alive });
      return;
    }
    if (!alive()) {
      // Late: an old configuration or a restart. Nothing published, no status.
      return;
    }
    this.failures = 0;
    this.retryAtMono = 0;
    this.lastError = undefined;
    this.kept.pause = null;
    // The fingerprint of refused credentials goes with the first success.
    this.kept.refusal = null;
    // The meters listed now, then the ones known before (a meter never leaves
    // Discovery by itself, unless MAX_METERS others are listed).
    const listed = reading.meters.map((m) => m.id);
    this.kept.meters = [...new Set([...listed, ...this.kept.meters])].slice(0, MAX_METERS);
    this.reading = reading;
    this.valuesAt = this.monotonic();
    this.readAt = this.now();
    const prepared = this.prepare(reading);
    // Saved BEFORE Gladys gets the values: a crash in between never sends an
    // index /data does not know.
    await this.saveState();
    if (!alive()) return;
    if (prepared) await this.send(prepared);
    if (!alive()) return;
    await this.discover();
    if (!alive()) return;
    await this.updateStatus();
  }

  async failed(err, { address, credentials, alive }) {
    const code = err?.code ?? 'error';
    // A late failure of another configuration is dropped; a pause or a refusal
    // of the same Eagle with the same credentials is still kept.
    const same =
      this.config.address === address &&
      this.config.cloudId === credentials.cloudId &&
      this.config.installCode === credentials.installCode;
    if (!alive() && !same) return;
    // Our own words only (EagleError codes): never a text of the Eagle, never the credentials.
    this.logger.warn(
      `Eagle read of ${address} failed: ${code}${err?.status ? ` ${err.status}` : ''}`,
    );
    const now = this.now();
    const mono = this.monotonic();
    if (code === 'refused') {
      this.kept.refusal = {
        status: err.status === 403 ? 403 : 401,
        fp: fingerprint(this.kept.salt, address, credentials.cloudId, credentials.installCode),
      };
    } else if (code === 'rate_limited' || code === 'server') {
      const count = (this.kept.pause?.count ?? 0) + 1;
      const asked = err.retryAfter ?? PAUSE_MIN * 2 ** (count - 1);
      const wait = Math.min(Math.max(asked, PAUSE_MIN, this.intervalMs()), PAUSE_MAX);
      this.kept.pause = {
        until: now + wait,
        count: Math.min(count, 32),
        code,
        status: err.status ?? null,
      };
    } else {
      this.retryAtMono = mono + this.retryWait(this.failures);
      this.failures += 1;
    }
    this.lastError = err;
    await this.saveState();
    if (alive()) {
      await this.updateStatus();
    }
  }

  /** The guard of an index of a created device, from Gladys and /data. */
  guardOf(created, featureId, limits) {
    if (!this.guards.has(featureId)) {
      this.guards.set(
        featureId,
        new IndexGuard(
          lastValueOf(created, featureId),
          this.kept.indexes[featureId],
          this.now(),
          limits,
        ),
      );
    }
    return this.guards.get(featureId);
  }

  /**
   * Whether the meter is linked to the Eagle, by the list and by its own answer:
   * only a status read and other than "Connected" holds it back (a status
   * missing on either side is unknown, the same rule for both).
   */
  static linked(reading, id) {
    const listed = reading.meters.find((m) => m.id === id);
    const values = reading.values.get(id);
    return Boolean(listed) && listed.connected !== false && values?.connected !== false;
  }

  /**
   * The states of a read, each index through its guard (not sent yet: `send`
   * does it, after /data is saved). Undefined without any state to send.
   * A meter that the Eagle no longer reaches (not "Connected") publishes
   * nothing: its values would be stale.
   */
  prepare(reading) {
    const now = this.now();
    const states = [];
    for (const [id, values] of reading.values) {
      const created = this.createdDevice(id);
      if (!created || !EagleApp.linked(reading, id)) {
        continue;
      }
      const external = ids(this.gladys, id);
      const indexes = {};
      for (const { name, key, value } of INDEXES) {
        const featureId = external.feature(key);
        const guard = this.guardOf(created, featureId, INDEX_LIMITS[name]);
        const total = values[value] === undefined ? undefined : round(values[value], 3);
        if (total === undefined) {
          indexes[key] = guard.held ? guard.last?.value : undefined;
          continue;
        }
        const plausible = guard.accept(total, now);
        const held = guard.held ? `${guard.held.direction}:${guard.held.from}` : undefined;
        if (held && this.loggedHolds.get(featureId) !== held) {
          this.logger.warn(
            `Eagle meter ${id} ${key} ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
          );
        }
        if (held) this.loggedHolds.set(featureId, held);
        else this.loggedHolds.delete(featureId);
        // While a value is held, the last accepted one is sent again (no delta for the core).
        indexes[key] = plausible ? total : guard.held ? guard.last?.value : undefined;
      }
      const features = new Set((created.features ?? []).map((f) => f.external_id));
      states.push(
        ...readStates(external, values, indexes).filter((s) =>
          features.has(s.device_feature_external_id),
        ),
      );
    }
    return states.length > 0 ? states : undefined;
  }

  /**
   * The states, within STATES_PER_MINUTE over any 60 s: a batch that would go
   * beyond is not sent this time. The room is taken BEFORE the publication
   * (two publications at once never both pass).
   */
  async send(states) {
    const mono = this.monotonic();
    this.sent = this.sent.filter((s) => mono - s.at < MINUTE);
    const used = this.sent.reduce((sum, s) => sum + s.count, 0);
    if (used + states.length > STATES_PER_MINUTE) {
      this.logger.debug('Eagle: values kept for the next read (states per minute)');
      return;
    }
    const entry = { at: mono, count: states.length };
    this.sent.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT });
      if (Number.isInteger(result?.count) && result.count >= 0 && result.count <= states.length) {
        entry.count = result.count;
      }
    } catch (err) {
      this.logger.warn(`Publishing the Eagle values failed: ${err.message}`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  /** Every index held back: `{ id, meter, name, direction, from, to }`. */
  heldList() {
    const list = [];
    for (const meter of this.kept.meters) {
      const created = this.createdDevice(meter);
      if (!created) continue;
      for (const { name, key } of INDEXES) {
        const id = ids(this.gladys, meter).feature(key);
        const held = this.guardOf(created, id, INDEX_LIMITS[name]).held;
        if (held) list.push({ id, meter, name, ...held });
      }
    }
    return list;
  }

  async updateStatus({ starting = false } = {}) {
    const { problem, address } = this.config;
    if (problem) {
      await this.setStatus(false, T.problem[problem]);
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    const { pause, refusal } = this.kept;
    if (refusal) {
      await this.setStatus(false, T.refused(address, refusal));
      return;
    }
    if (pause && now < pause.until) {
      await this.setStatus(false, T.paused(address, pause, pause.until - now));
      return;
    }
    if (this.lastError) {
      const wait = Math.max(0, this.retryAtMono - mono);
      await this.setStatus(false, T.failing(address, this.lastError, wait));
      return;
    }
    if (!this.reading) {
      const at = this.nextReadAt();
      if (starting && at <= now) {
        await this.setStatus(false, T.connecting);
      } else {
        // After a restart, an Eagle read before (no refusal, no pause, no
        // error) is shown connected until its next read.
        await this.setStatus(this.kept.meters.length > 0, T.waiting(at));
      }
      return;
    }
    const reading = this.reading;
    const notes = [];
    if (reading.meters.length === 0 && reading.others === 0) notes.push(T.notes.noMeter);
    if (reading.others > 0) notes.push(T.notes.others(reading.others));
    const listed = reading.meters.map((m) => m.id);
    if (listed.some((id) => !this.createdDevice(id))) notes.push(T.notes.noDevice);
    const unlinked = listed.filter((id) => reading.values.has(id) && !EagleApp.linked(reading, id));
    if (unlinked.length > 0) notes.push(T.notes.unlinked(unlinked));
    if (reading.missing.length > 0) notes.push(T.notes.missing(reading.missing));
    if (reading.denied.length > 0) notes.push(T.notes.denied(reading.denied));
    const gone = this.kept.meters.filter((id) => !listed.includes(id) && this.createdDevice(id));
    if (gone.length > 0) notes.push(T.notes.gone(gone));
    const held = this.heldList();
    if (held.length > 0) notes.push(T.notes.held(held));
    await this.setStatus(true, T.ok(listed.length, notes));
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * "Accept the held index", in two clicks: the first lists every index held
   * (nothing is accepted), the second, from 3 s to 5 min later, accepts
   * exactly what the first listed, and only when it still shows that value
   * (or what may have come since, src/guard.js). A save of the form never accepts.
   */
  async acceptHeldIndex() {
    const list = this.heldList();
    const mono = this.monotonic();
    const now = this.now();
    const pending = this.pendingAccept;
    this.pendingAccept = undefined;
    const elapsed = pending ? mono - pending.at : undefined;
    if (!pending || elapsed > ACCEPT_CONFIRM_WITHIN || elapsed < ACCEPT_CONFIRM_AFTER) {
      if (list.length === 0) {
        return T.accept.nothing;
      }
      this.pendingAccept = { at: mono, listedAt: now, list };
      return T.accept.confirm(list, ACCEPT_CONFIRM_WITHIN);
    }
    const accepted = [];
    const changed = [];
    for (const entry of pending.list) {
      const guard = this.guards.get(entry.id);
      const held = guard?.held;
      const margin = guard ? guard.margin(pending.listedAt, now) : 0;
      const same =
        held &&
        held.direction === entry.direction &&
        held.from === entry.from &&
        (entry.direction === 'up'
          ? held.to >= entry.to && held.to - entry.to <= margin
          : Math.abs(held.to - entry.to) <= margin);
      if (same && guard.acceptHeld()) {
        accepted.push({ ...entry, to: held.to });
      } else if (held) {
        changed.push(entry);
      }
    }
    if (accepted.length === 0 && changed.length === 0) {
      return T.accept.nothing;
    }
    for (const { meter, direction } of accepted) {
      this.logger.info(
        `Eagle meter ${meter} consumption index ${direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
      );
    }
    // Published at the next read (never a read sooner than the interval).
    return T.accept.done(accepted, changed);
  }

  /**
   * The test button: a read when one is due (the interval passed; refused
   * credentials are tried again then, once per click), else what is known and
   * when the next read can be. Never a request a pause or the pace forbids.
   */
  async testConnection() {
    const { problem, address } = this.config;
    if (problem) {
      return T.problem[problem];
    }
    const generation = this.generation;
    const job = this.busy ?? this.tick({ manual: true });
    if (job) {
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve('late'), TEST_ANSWER_WITHIN);
      });
      try {
        if ((await Promise.race([job.then(() => 'done'), late])) === 'late') {
          return T.test.slow;
        }
      } finally {
        this.timers.clearTimeout(timer);
      }
    }
    if (generation !== this.generation) {
      return T.test.slow;
    }
    const lines = [];
    const fresh = this.isFresh();
    if (this.kept.refusal) {
      lines.push(T.test.failed(address, { code: 'refused', status: this.kept.refusal.status }));
    } else if (this.kept.pause && this.now() < this.kept.pause.until) {
      lines.push(T.test.failed(address, this.kept.pause));
    } else if (this.lastError) {
      lines.push(T.test.failed(address, this.lastError));
    } else if (fresh) {
      lines.push(T.test.ok(address, this.reading));
    }
    if (fresh && this.readAt !== undefined) lines.push(T.test.lastRead(this.readAt));
    if (!job) lines.push(T.test.notNow(this.nextReadAt({ manual: true })));
    return T.test.lines(lines);
  }
}
