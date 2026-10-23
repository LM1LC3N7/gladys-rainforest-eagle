import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

const CLOUD = '0077DD';
const CODE = '6c9d2e4f1a3b5c7d';

test('addresses: IP, host name, port, pasted URL; port 80 by default', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { address: '192.168.1.60:80' });
  assert.deepEqual(parseAddress(' http://192.168.1.60:8080/cgi-bin/post_manager '), {
    address: '192.168.1.60:8080',
  });
  assert.deepEqual(parseAddress('Eagle-0077dd.local'), { address: 'eagle-0077dd.local:80' });
  assert.deepEqual(parseAddress('fe80::1'), { address: '[fe80::1]:80' });
  assert.deepEqual(parseAddress(''), { empty: true });
  for (const bad of ['u:p@192.168.1.60', 'a b', '1.2.3.4:0', '1.2.3.4:70000', 'x'.repeat(301)]) {
    assert.deepEqual(parseAddress(bad), { error: 'invalid' }, bad);
  }
});

test('the configuration: problems named, credentials never kept when anything is invalid', () => {
  const base = { address: '192.168.1.60' };
  assert.equal(normalizeConfig({}).problem, 'address_missing');
  assert.equal(normalizeConfig({ address: 'a b' }).problem, 'address_invalid');
  assert.equal(normalizeConfig(base).problem, 'cloud_id_missing');
  for (const bad of ['a b', '0077-dd', 'abc', 'é'.repeat(6)]) {
    const config = normalizeConfig({ ...base, cloud_id: bad, install_code: CODE });
    assert.equal(config.problem, 'cloud_id_invalid', bad);
    assert.equal(config.installCode, undefined);
  }
  assert.equal(normalizeConfig({ ...base, cloud_id: CLOUD }).problem, 'install_code_missing');
  for (const bad of ['short', 'with space inside', 'line\nbreak12345', 'colon:in:it:1234']) {
    const config = normalizeConfig({ ...base, cloud_id: CLOUD, install_code: bad });
    assert.equal(config.problem, 'install_code_invalid', bad);
    assert.equal(config.installCode, undefined);
    assert.equal(config.cloudId, undefined);
  }
  const ok = normalizeConfig({
    ...base,
    cloud_id: ` ${CLOUD} `,
    install_code: ` ${CODE} `,
    poll_interval: '45',
  });
  assert.deepEqual(ok, {
    address: '192.168.1.60:80',
    cloudId: '0077dd',
    installCode: CODE,
    pollInterval: 45,
    problem: undefined,
  });
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 300);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 30);
});
