import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EagleClient, readBounded } from '../src/eagle/client.js';
import { createFetch, timeoutError } from './helpers/fakeFetch.js';
import {
  ADDRESS,
  CLOUD_ID,
  HOST,
  INSTALL_CODE,
  METER,
  basic,
  eagle,
  xml,
} from './fixtures/eagle.js';

const CREDENTIALS = { cloudId: CLOUD_ID, installCode: INSTALL_CODE };

const setup = (overrides) => {
  const routes = eagle(overrides);
  const fake = createFetch({ [HOST]: routes });
  const sleeps = [];
  const clock = { mono: 0 };
  const client = new EagleClient({
    fetchImpl: fake.fetch,
    monotonic: () => clock.mono,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.mono += ms;
    },
  });
  return { fake, routes, client, sleeps, clock };
};

test('one read: POST of the two read commands, Basic credentials, no redirect, 1 s apart', async () => {
  const { client, fake, sleeps } = setup();
  const read = await client.readAll(ADDRESS, CREDENTIALS);
  assert.deepEqual(read.meters, [{ id: METER, address: '0x00abcd123', connected: true }]);
  assert.deepEqual(read.values.get(METER), {
    connected: true,
    power: 1965,
    delivered: 2853.662,
    received: 0,
  });
  assert.deepEqual(read.missing, []);
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assert.equal(call.url, `http://${ADDRESS}/cgi-bin/post_manager`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers.Authorization, basic(CLOUD_ID, INSTALL_CODE));
    assert.equal(call.init.headers['Content-Type'], 'text/xml');
    assert.equal(call.init.headers['User-Agent'], undefined, 'no imitation');
  }
  assert.match(fake.calls[0].init.body, /<Name>device_list<\/Name>/);
  assert.match(fake.calls[1].init.body, /<Name>device_query<\/Name>/);
  assert.deepEqual(sleeps, [1000], 'one second between the two requests');
});

test('refused credentials stop the read; the error never carries them nor the URL', async () => {
  const { client } = setup({ installCode: 'ffffffffffffffff' });
  const err = await client.readAll(ADDRESS, CREDENTIALS).catch((e) => e);
  assert.equal(err.code, 'refused');
  assert.equal(err.status, 401);
  for (const text of [err.message, String(err), JSON.stringify(err)]) {
    assert.ok(!text.includes(INSTALL_CODE));
    assert.ok(!text.includes(CLOUD_ID));
    assert.ok(!text.includes('http'));
  }
});

test('a query that fails leaves that meter out; a 401 of a query is "denied"', async () => {
  const two = [{ id: METER }, { id: 'beef' }];
  const server = setup({ meters: two, fail: { device_query: 500 } });
  const read = await server.client.readAll(ADDRESS, CREDENTIALS);
  assert.deepEqual(read.missing, [METER, 'beef']);
  const denied = await setup({ meters: two, fail: { device_query: 403 } }).client.readAll(
    ADDRESS,
    CREDENTIALS,
  );
  assert.deepEqual(denied.denied, [METER, 'beef']);
  const slow = setup({
    meters: two,
    fail: {
      device_query: () => {
        throw timeoutError();
      },
    },
  });
  const cut = await slow.client.readAll(ADDRESS, CREDENTIALS);
  assert.deepEqual(cut.missing, [METER, 'beef']);
  assert.equal(slow.fake.calls.length, 2, 'the remaining queries are not sent');
});

test('a 5xx or a 429 of the device list stops the read, with the Retry-After', async () => {
  const server = setup({ fail: { device_list: 503 } });
  const err = await server.client.readAll(ADDRESS, CREDENTIALS).catch((e) => e);
  assert.equal(err.code, 'server');
  const limited = setup({
    fail: { device_query: () => xml('', 429, { 'retry-after': '120' }) },
  });
  const tooMany = await limited.client.readAll(ADDRESS, CREDENTIALS).catch((e) => e);
  assert.equal(tooMany.code, 'rate_limited');
  assert.equal(tooMany.retryAfter, 120_000);
});

test('another device at the address, a redirect, odd answers', async () => {
  const other = setup({ fail: { device_list: () => xml('<html><body>hi</body></html>') } });
  assert.equal(
    (await other.client.readAll(ADDRESS, CREDENTIALS).catch((e) => e)).code,
    'unknown_answer',
  );
  const moved = setup({
    fail: {
      device_list: () =>
        new Response('', { status: 302, headers: { location: 'http://evil.example/' } }),
    },
  });
  assert.equal((await moved.client.readAll(ADDRESS, CREDENTIALS).catch((e) => e)).code, 'http');
  const text = setup({ fail: { device_list: () => xml('{"json": true}') } });
  assert.equal((await text.client.readAll(ADDRESS, CREDENTIALS).catch((e) => e)).code, 'not_xml');
  const none = new EagleClient({ fetchImpl: createFetch({}).fetch, sleep: async () => {} });
  assert.equal((await none.readAll(ADDRESS, CREDENTIALS).catch((e) => e)).code, 'unreachable');
  const stopped = setup();
  const read = await stopped.client.readAll(ADDRESS, CREDENTIALS, () => false);
  assert.equal(stopped.fake.calls.length, 1, 'stopped after the device list');
  assert.equal(read.values.size, 0);
});

test('a body is bounded, read into one buffer', async () => {
  const big = new Response('x'.repeat(300 * 1024));
  assert.equal((await readBounded(big, 256 * 1024).catch((e) => e)).code, 'too_large');
  const chunks = new ReadableStream({
    start(controller) {
      for (const part of ['<A>', '1', '</A>']) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  assert.equal(await readBounded(new Response(chunks), 64), '<A>1</A>');
  assert.equal(await readBounded(new Response(null), 64), '');
});

test('read-only: the client has no method that changes anything, only the two read commands', () => {
  const source = readFileSync(new URL('../src/eagle/client.js', import.meta.url), 'utf8');
  const model = readFileSync(new URL('../src/eagle/model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(`${source}${model}`, /set_|confirm_message|wifi|cloud_/i);
  const methods = Object.getOwnPropertyNames(EagleClient.prototype);
  assert.deepEqual(methods.sort(), [
    'constructor',
    'post',
    'readAll',
    'readDeviceList',
    'readMeter',
  ]);
});
