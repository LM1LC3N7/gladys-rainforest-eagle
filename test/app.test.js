// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Eagle-200.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EagleApp } from '../src/app.js';
import { ACTIONS, PAUSE_MIN, RETRY_MIN } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { EagleClient } from '../src/eagle/client.js';
import { createMemoryStore } from '../src/store.js';
import { createFetch } from './helpers/fakeFetch.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import { ADDRESS, CLOUD_ID, HOST, INSTALL_CODE, METER, NOW, eagle, xml } from './fixtures/eagle.js';

const SELECTOR = 'rainforest-eagle';
const DEVICE = (id = METER) => `ext:${SELECTOR}:meter:${id}`;
const F = (key, id = METER) => `${DEVICE(id)}:${key}`;
const CONFIG = { address: HOST, cloud_id: CLOUD_ID, install_code: INSTALL_CODE };
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const POLL = 30 * SECOND;

function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** The device as the user created it from the discovered one. */
function created({ id = METER, index } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, id, ADDRESS);
  if (index) {
    const feature = device.features.find((f) => f.external_id === F('consumption_index', id));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return device;
}

async function setup({
  config = CONFIG,
  routes = eagle(),
  devices = [],
  store = createMemoryStore(),
  now = NOW,
  clock = { now },
} = {}) {
  const fake = createFetch({ [HOST]: routes });
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const timers = createFakeTimers();
  const logger = createLogger();
  const app = new EagleApp({
    gladys,
    logger,
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
    client: new EagleClient({
      fetchImpl: fake.fetch,
      now: () => clock.now,
      monotonic: () => clock.now,
      sleep: async () => {},
    }),
  });
  gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldIndex());
  gladys.onScanRequest(() => app.scan());
  /** `ms` later, the timer looks whether a read is due. */
  const tick = async (ms = POLL) => {
    clock.now += ms;
    await timers.runIntervals();
    await app.idle();
  };
  return { app, gladys, timers, clock, logger, fake, tick, store, routes };
}

const status = (gladys) => gladys.fake.connectionStatus;
const command = (call) => /<Name>([a-z_]+)<\/Name>/.exec(call.init.body)?.[1];
/** The reads (each starts with the device list). */
const reads = (fake) => fake.calls.filter((c) => command(c) === 'device_list').length;
const last = (gladys, key, id) => gladys.fake.lastState(F(key, id));
const text = (message) => `${message.en} ${message.fr}`;

test('nothing configured, or bad credentials: the status says so, nothing is called', async () => {
  for (const [config, words] of [
    [{}, /adresse IP de l’Eagle/],
    [{ address: HOST }, /Cloud ID de l’Eagle/],
    [{ address: HOST, cloud_id: 'a b' }, /Cloud ID n’est pas valide/],
    [{ address: HOST, cloud_id: CLOUD_ID }, /code d’installation de l’Eagle/],
    [{ address: HOST, cloud_id: CLOUD_ID, install_code: 'a:bcdefghij' }, /pas valide/],
    [{ address: 'u:p@x', cloud_id: CLOUD_ID, install_code: INSTALL_CODE }, /adresse n’est pas/],
  ]) {
    const { app, gladys, fake } = await setup({ config });
    await app.start(config);
    await app.idle();
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, words);
    assert.equal(fake.calls.length, 0);
    assert.match(String((await gladys.fake.action(ACTIONS.TEST)).data.message.fr), words);
  }
});

test('the first read: the meter in Discovery, no value before it is created', async () => {
  const { app, gladys } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE());
  assert.equal(device.name, 'Eagle meter 0x00abcd123');
  assert.deepEqual(
    device.params.find((p) => p.name === 'EAGLE_METER'),
    { name: 'EAGLE_METER', value: '0x00abcd123' },
  );
  assert.ok(device.features.every((f) => f.read_only));
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Découverte/);
});

test('a created meter gets its power and indexes, read-only, never the consumption endpoint', async () => {
  const routes = eagle({ values: { [METER]: { received: '12.25' } } });
  const { app, gladys, fake } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'power'), 1965);
  assert.equal(last(gladys, 'consumption_index'), 2853.662);
  assert.equal(last(gladys, 'injection_index'), 12.25);
  assert.equal(gladys.fake.publishedEnergyConsumption.length, 0);
  assert.deepEqual(
    fake.calls.map(command),
    ['device_list', 'device_query'],
    'only the two read commands',
  );
  assert.match(status(gladys).message.en, /Rainforest Eagle answering \(1 electricity meter\)/);
});

test('a meter sending power to the grid: negative power; 0 kWh received is never published', async () => {
  const routes = eagle({ values: { [METER]: { demand: '-1.5' } } });
  const { app, gladys } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'power'), -1500);
  assert.equal(last(gladys, 'injection_index'), undefined);
});

test('a meter not linked to the Eagle publishes nothing (stale values); the status says it', async () => {
  const routes = eagle({ meters: [{ id: METER, connected: false }] });
  const { app, gladys } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.states.length, 0);
  assert.match(status(gladys).message.fr, /Non relié à l’Eagle en ce moment : 0x00abcd123/);
});

test('pace: nothing reads faster than the interval (timer, reconnection, unchanged save, test, Discovery)', async () => {
  const { app, gladys, fake, tick, clock } = await setup({ devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(reads(fake), 1);
  await tick(10 * SECOND);
  assert.equal(reads(fake), 1, 'the timer waits the interval');
  await app.start(CONFIG);
  await app.idle();
  await app.start(CONFIG, { fresh: true });
  await app.idle();
  await gladys.fake.scanRequest();
  await app.idle();
  const answer = (await gladys.fake.action(ACTIONS.TEST)).data.message;
  assert.match(text(answer), /next read possible at 10:00:30 UTC/);
  assert.match(text(answer), /credentials accepted \(meter 0x00abcd123 1965 W\)/);
  assert.equal(reads(fake), 1);
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'Discovery republished, no request');
  await tick(20 * SECOND);
  assert.equal(reads(fake), 2, 'read once the interval passed');
  await tick(28 * SECOND);
  assert.equal(reads(fake), 2);
  clock.now += 2 * SECOND;
  const clicked = (await gladys.fake.action(ACTIONS.TEST)).data.message;
  assert.match(clicked.fr, /identifiants acceptés/);
  assert.equal(reads(fake), 3);
});

test('a reconnection during a read starts no other read; the late read publishes nothing', async () => {
  let release;
  const routes = eagle({ hold: new Promise((r) => (release = r)) });
  const { app, gladys, fake, clock } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.lifecycle;
  assert.equal(fake.calls.length, 1, 'the read is waiting for the Eagle');
  const statuses = gladys.fake.connectionStatuses.length;
  await app.start(CONFIG);
  await app.lifecycle;
  clock.now += 40 * SECOND;
  const running = app.tick();
  assert.ok(running);
  assert.equal(fake.calls.length, 1, 'no second read while the first runs');
  routes.state.hold = undefined;
  release();
  await app.idle();
  assert.equal(gladys.fake.states.length, 0, 'the late read publishes nothing');
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1, 'only the restart status');
  clock.now += 1;
  await app.tick();
  await app.idle();
  assert.equal(last(gladys, 'power'), 1965);
});

test('a restart of the container never reads sooner: last request in /data, written once a minute', async () => {
  const store = createMemoryStore();
  const clock = { now: NOW };
  const first = await setup({ store, clock, devices: [created()] });
  await first.app.start(CONFIG);
  await first.app.idle();
  assert.equal(store.data.lastAttemptAt, NOW);
  await first.tick(POLL);
  assert.equal(reads(first.fake), 2);
  assert.equal(store.data.lastAttemptAt, NOW, 'not written again within the minute');
  await first.tick(POLL);
  assert.equal(store.data.lastAttemptAt, NOW + 2 * POLL, 'written after a minute');
  await first.app.stop();
  const second = await setup({ store, clock, devices: [created()] });
  await second.app.start(CONFIG);
  await second.app.idle();
  assert.equal(second.fake.calls.length, 0);
  assert.equal(status(second.gladys).connected, true, 'an Eagle read before');
  assert.match(status(second.gladys).message.en, /next read at/);
  assert.equal(second.gladys.fake.discoveredDevices.length, 1, 'its meter from /data');
  await second.tick(POLL + MINUTE - 1000);
  assert.equal(second.fake.calls.length, 0, 'the interval and the minute not written');
  await second.tick(1000);
  assert.equal(reads(second.fake), 1);
});

test('refused credentials: final, kept in /data, never retried by the timer; a click or new ones try', async () => {
  const store = createMemoryStore();
  const clock = { now: NOW };
  const routes = eagle({ installCode: 'ffffffffffffffff' });
  const a = await setup({ store, clock, routes });
  await a.app.start(CONFIG);
  await a.app.idle();
  assert.equal(status(a.gladys).connected, false);
  assert.match(
    status(a.gladys).message.fr,
    /refuse le Cloud ID ou le code d’installation \(HTTP 401\)/,
  );
  assert.match(status(a.gladys).message.fr, /ne reprennent jamais seules/);
  assert.match(store.data.refusal.fp, /^[0-9a-f]{32}$/);
  await a.tick(24 * 60 * MINUTE);
  await a.tick(POLL);
  assert.equal(reads(a.fake), 1, 'never tried again by itself');
  // An unchanged save neither.
  await a.app.start(CONFIG, { fresh: true });
  await a.app.idle();
  assert.equal(reads(a.fake), 1);
  // A click: one try, still refused.
  const clicked = (await a.gladys.fake.action(ACTIONS.TEST)).data.message;
  assert.match(clicked.en, /Cloud ID or install code refused 401/);
  assert.equal(reads(a.fake), 2);
  // A restart: still stopped, nothing asked.
  await a.app.stop();
  const b = await setup({ store, clock, routes });
  await b.app.start(CONFIG);
  await b.app.idle();
  await b.tick(10 * MINUTE);
  assert.equal(b.fake.calls.length, 0);
  assert.match(status(b.gladys).message.en, /refuses the Cloud ID or the install code/);
  // The right install code saved: read at once, the fingerprint erased.
  const right = { ...CONFIG, install_code: 'ffffffffffffffff' };
  await b.app.start(right, { fresh: true });
  await b.app.idle();
  assert.equal(reads(b.fake), 1);
  assert.equal(store.data.refusal, null);
  assert.equal(status(b.gladys).connected, true);
  const everything = [
    ...a.logger.lines,
    ...b.logger.lines,
    JSON.stringify(store.data),
    JSON.stringify(a.gladys.fake.connectionStatuses),
    JSON.stringify(b.gladys.fake.connectionStatuses),
  ].join('\n');
  for (const secret of [INSTALL_CODE, 'ffffffffffffffff', CLOUD_ID]) {
    assert.ok(!everything.includes(secret), secret);
  }
});

test('a refusal ends with the first success of a click (the Eagle was rebooting)', async () => {
  const routes = eagle();
  routes.state.fail.device_list = 401;
  const { app, gladys, fake, store, clock } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.ok(store.data.refusal);
  delete routes.state.fail.device_list;
  clock.now += POLL;
  await gladys.fake.action(ACTIONS.TEST);
  assert.equal(reads(fake), 2);
  assert.equal(store.data.refusal, null);
  assert.equal(last(gladys, 'power'), 1965);
});

test('429 / 5xx of the device list: a pause kept in /data; the test button never asks', async () => {
  const store = createMemoryStore();
  const routes = eagle({
    fail: { device_list: () => xml('', 429, { 'retry-after': '600' }) },
  });
  const { app, gladys, fake, tick } = await setup({ store, routes });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(store.data.pause.code, 'rate_limited');
  assert.equal(store.data.pause.until, NOW + 600 * SECOND);
  assert.match(status(gladys).message.fr, /demande d’attendre/);
  routes.state.fail = {};
  await tick(5 * MINUTE);
  const answer = (await gladys.fake.action(ACTIONS.TEST)).data.message;
  assert.match(answer.en, /too many requests 429/);
  assert.equal(fake.calls.length, 1);
  await tick(5 * MINUTE);
  assert.equal(reads(fake), 2, 'read again after the pause');
  assert.equal(store.data.pause, null);
  const server = await setup({ routes: eagle({ fail: { device_list: 500 } }) });
  await server.app.start(CONFIG);
  await server.app.idle();
  assert.ok(server.app.kept.pause.until >= NOW + PAUSE_MIN);
});

test('a failing meter query keeps the other meter and says what is missing', async () => {
  const routes = eagle({ meters: [{ id: METER }, { id: 'beef' }] });
  routes['/cgi-bin/post_manager'] = ((route) => async (call) =>
    call.init.body.includes('0xbeef') ? xml('', 500) : route(call))(
    routes['/cgi-bin/post_manager'],
  );
  const { app, gladys } = await setup({
    routes,
    devices: [created(), created({ id: 'beef' })],
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'power'), 1965);
  assert.equal(last(gladys, 'power', 'beef'), undefined);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Non lu cette fois \(erreur de l’Eagle\) : 0xbeef/);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

test('unreachable: tried again after a minute, doubled, never faster than the interval', async () => {
  const { app, gladys, fake, tick } = await setup({ routes: {} });
  await app.start(CONFIG);
  await app.idle();
  assert.match(status(gladys).message.en, /unreachable/);
  await tick(RETRY_MIN - 1000);
  assert.equal(fake.calls.length, 1);
  await tick(1000);
  assert.equal(fake.calls.length, 2);
  await tick(RETRY_MIN);
  assert.equal(fake.calls.length, 2, 'doubled: 2 min');
  await tick(RETRY_MIN);
  assert.equal(fake.calls.length, 3);
});

test('another device at the address: an odd answer, nothing published, retried later', async () => {
  const routes = eagle({ fail: { device_list: () => xml('<html><body>router</body></html>') } });
  const { app, gladys } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(gladys.fake.states.length, 0);
  assert.match(status(gladys).message.fr, /pas celle d’un Rainforest Eagle/);
});

test('the consumption index: never 0, a jump held until accepted in two clicks', async () => {
  const routes = eagle();
  const { app, gladys, tick } = await setup({
    routes,
    devices: [created({ index: { value: 2853, at: NOW - MINUTE } })],
  });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'consumption_index'), 2853.662);
  routes.state.values[METER] = { delivered: '0' };
  await tick();
  assert.equal(last(gladys, 'consumption_index'), 2853.662, 'never 0');
  routes.state.values[METER] = { delivered: '9000' };
  await tick();
  assert.equal(last(gladys, 'consumption_index'), 2853.662, 'a jump is held');
  assert.match(status(gladys).message.fr, /saut de 2853.662 à 9000 kWh/);
  const first = (await gladys.fake.action(ACTIONS.ACCEPT_HELD)).data.message;
  assert.match(first.en, /A second click accepts exactly/);
  assert.match(first.en, /meter 0x00abcd123: 2853.662 → 9000 kWh/);
  await tick(5 * SECOND);
  assert.equal(last(gladys, 'consumption_index'), 2853.662);
  const second = (await gladys.fake.action(ACTIONS.ACCEPT_HELD)).data.message;
  assert.match(second.en, /Accepted: consumption index of meter 0x00abcd123 9000 kWh/);
  await tick();
  assert.equal(last(gladys, 'consumption_index'), 9000);
  assert.equal(
    (await gladys.fake.action(ACTIONS.ACCEPT_HELD)).data.message.en,
    'No index is held back: nothing to accept.',
  );
});

test('a drop of the index is held across a restart (kept in /data)', async () => {
  const store = createMemoryStore();
  const clock = { now: NOW };
  const routes = eagle();
  const a = await setup({ store, clock, routes, devices: [created()] });
  await a.app.start(CONFIG);
  await a.app.idle();
  routes.state.values[METER] = { delivered: '10' };
  await a.tick();
  assert.equal(store.data.indexes[F('consumption_index')].held.direction, 'down');
  await a.app.stop();
  const b = await setup({ store, clock, routes, devices: [created()] });
  await b.app.start(CONFIG);
  await b.tick(POLL + MINUTE);
  assert.equal(last(b.gladys, 'consumption_index'), 2853.662, 'the last accepted value');
  assert.match(status(b.gladys).message.fr, /baisse de 2853.662 à 10 kWh/);
});

test('the device created after a read gets the last values at once, without a request', async () => {
  const { app, gladys, fake } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const calls = fake.calls.length;
  await gladys.fake.deviceCreated(created());
  await app.idle();
  assert.equal(fake.calls.length, calls);
  assert.equal(last(gladys, 'power'), 1965);
});

test('the states budget is taken before a publication: two at once never both pass', async () => {
  const { app, gladys } = await setup({ devices: [created()] });
  const states = Array.from({ length: 200 }, (_, i) => ({
    device_feature_external_id: F('power'),
    state: i,
  }));
  let calls = 0;
  const publish = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = (...args) => {
    calls += 1;
    return publish(...args);
  };
  await Promise.all([app.send(states), app.send(states)]);
  assert.equal(calls, 1);
});

test('each connection publishes the status and the meters again', async () => {
  const { app, gladys } = await setup();
  await app.start(CONFIG);
  await app.idle();
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  await app.start(CONFIG);
  await app.idle();
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('a restart during the Discovery of a read leaves it without status', async () => {
  const { app, gladys } = await setup();
  let calls = 0;
  const publish = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.publishDiscoveredDevices = async (devices) => {
    calls += 1;
    if (calls === 2) app.generation += 1;
    return publish(devices);
  };
  await app.start(CONFIG);
  await app.idle();
  assert.equal(calls, 2);
  assert.equal(gladys.fake.connectionStatuses.length, 1, 'only the status of the start');
});

test('a meter no longer listed keeps its device, gets nothing, and the status says it', async () => {
  const routes = eagle();
  const { app, gladys, tick } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  routes.state.meters = [];
  await tick();
  assert.match(status(gladys).message.fr, /aucun compteur électrique/);
  assert.match(status(gladys).message.fr, /Plus listé par l’Eagle : 0x00abcd123/);
  assert.equal(gladys.fake.discoveredDevices.length, 1, 'never lost from Discovery');
});

test('review 1, point 1: a firmware that wants the address as listed still answers', async () => {
  const routes = eagle({ meters: [{ id: METER, address: '0x00ABCD123' }] });
  const { app, gladys, fake } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'power'), 1965);
  assert.match(fake.calls[1].init.body, /<HardwareAddress>0x00ABCD123<\/HardwareAddress>/);
  assert.equal(gladys.fake.discoveredDevices[0].external_id, DEVICE());
});

test('review 1, point 2: devices left out are counted in the status, never "no meter joined"', async () => {
  const routes = eagle({
    meters: [
      { id: METER, address: 'zz' },
      { id: 'def', model: 'gas_meter' },
    ],
  });
  const { app, gladys } = await setup({ routes });
  await app.start(CONFIG);
  await app.idle();
  assert.match(status(gladys).message.fr, /2 appareils de l’Eagle ignorés/);
  assert.match(status(gladys).message.en, /2 devices of the Eagle left out/);
  assert.doesNotMatch(status(gladys).message.fr, /est-il appairé/);
});

test('review 1, point 3: no ConnectionStatus in the list: the values are published', async () => {
  const routes = eagle({ meters: [{ id: METER, connected: null }] });
  const { app, gladys } = await setup({ routes, devices: [created()] });
  await app.start(CONFIG);
  await app.idle();
  assert.equal(last(gladys, 'power'), 1965);
  assert.doesNotMatch(status(gladys).message.fr, /Non relié/);
});
