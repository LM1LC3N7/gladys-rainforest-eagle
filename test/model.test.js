// -----------------------------------------------------------------------------
// The XML reader and the meaning of the answers of the Eagle.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deviceListCommand,
  deviceQueryCommand,
  hardwareId,
  numberOf,
  parseDeviceList,
  parseDeviceQuery,
} from '../src/eagle/model.js';
import { MAX_DEPTH, MAX_ELEMENTS, XmlError, parseXml, textOf } from '../src/eagle/xml.js';
import { METER, deviceList, deviceQuery } from './fixtures/eagle.js';

test('xml: the plain trees of the Eagle, entities, CDATA, comments, declarations', () => {
  const root = parseXml(
    '<?xml version="1.0"?>\n<!-- c --><A x="1"><B>a &amp; b &#65;&#x42;</B><C/><D><![CDATA[<x>]]></D></A>\n',
  );
  assert.equal(root.name, 'A');
  assert.equal(textOf(root, 'B'), 'a & b AB');
  assert.equal(textOf(root, 'C'), '');
  assert.equal(textOf(root, 'D'), '<x>');
  assert.equal(textOf(root, 'E'), undefined);
  assert.equal(
    textOf(parseXml('<A><B><C>1</C></B></A>'), 'B'),
    undefined,
    'never a nested element',
  );
});

test('xml: hostile or broken answers are refused', () => {
  for (const text of [
    '',
    'hello',
    '<A>',
    '<A></B>',
    '<A></A><B></B>',
    '<A/><B/>',
    '<A></A>trailing',
    '<!DOCTYPE A [<!ENTITY x "y">]><A>&x;</A>',
    '<A>&unknown;</A>',
    '<A>&#0;</A>',
    '<A>&#27;</A>',
    '<1A></1A>',
    '<A><!-- open</A>',
    `${'<A>'.repeat(MAX_DEPTH + 1)}${'</A>'.repeat(MAX_DEPTH + 1)}`,
    `<A>${'<B/>'.repeat(MAX_ELEMENTS)}</A>`,
  ]) {
    assert.throws(() => parseXml(text), XmlError, JSON.stringify(text.slice(0, 40)));
  }
});

test('xml: a key of the answer never becomes a property (no prototype pollution)', () => {
  const root = parseXml(
    '<__proto__><constructor>1</constructor><polluted>x</polluted></__proto__>',
  );
  assert.equal(root.name, '__proto__');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const list = parseDeviceList(
    parseXml(
      '<DeviceList><Device><ModelId>electric_meter</ModelId><HardwareAddress>__proto__</HardwareAddress></Device></DeviceList>',
    ),
  );
  assert.deepEqual(list, { meters: [], others: 1 });
});

test('xml: linear on large inputs (no backtracking)', () => {
  const started = performance.now();
  for (const text of [
    `<A>${'<'.repeat(100_000)}`,
    `<A>${'&'.repeat(200_000)}</A>`,
    `<A></A>${'<?'.repeat(100_000)}`,
    `<A>${'<B>x</B>'.repeat(4000)}</A>`,
  ]) {
    try {
      parseXml(text);
    } catch {
      // refused or read: only the time matters here
    }
  }
  assert.ok(performance.now() - started < 2000);
});

test('the commands are those of aioeagle', () => {
  assert.equal(deviceListCommand(), '<Command><Name>device_list</Name></Command>');
  assert.equal(
    deviceQueryCommand(METER),
    '<Command><Name>device_query</Name><DeviceDetails><HardwareAddress>0x00abcd123</HardwareAddress></DeviceDetails><Components><All>Y</All></Components></Command>',
  );
  assert.throws(() => deviceQueryCommand('0x</HardwareAddress>'), TypeError);
});

test('the device list: electricity meters with a readable address, the rest counted', () => {
  const list = parseDeviceList(
    parseXml(
      deviceList([
        { id: METER },
        { id: 'abc', connected: false },
        { id: 'def', model: 'gas_meter' },
        { id: METER },
      ]),
    ),
  );
  assert.deepEqual(list.meters, [
    { id: METER, address: '0x00abcd123', connected: true },
    { id: 'abc', address: '0xabc', connected: false },
  ]);
  assert.equal(list.others, 2);
  assert.deepEqual(parseDeviceList(parseXml('<DeviceList></DeviceList>')), {
    meters: [],
    others: 0,
  });
  assert.throws(() => parseDeviceList(parseXml('<Device/>')), /unknown_answer/);
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `${i + 1}` }));
  assert.equal(parseDeviceList(parseXml(deviceList(many))).meters.length, 4);
});

test('the device query: W from kW, kWh, the sign of the demand, odd values left out', () => {
  const values = parseDeviceQuery(parseXml(deviceQuery({ id: METER })), METER);
  assert.deepEqual(values, { connected: true, power: 1965, delivered: 2853.662, received: 0 });
  const exporting = parseDeviceQuery(
    parseXml(deviceQuery({ id: METER, demand: '-0.250', received: '12.5' })),
    METER,
  );
  assert.equal(exporting.power, -250);
  assert.equal(exporting.received, 12.5);
  const odd = parseDeviceQuery(
    parseXml(deviceQuery({ id: METER, demand: 'invalid', delivered: '', received: '1e9' })),
    METER,
  );
  assert.deepEqual(odd, {
    connected: true,
    power: undefined,
    delivered: undefined,
    received: undefined,
  });
  const huge = parseDeviceQuery(parseXml(deviceQuery({ id: METER, demand: '500' })), METER);
  assert.equal(huge.power, undefined, '500 kW is a glitch');
  const down = parseDeviceQuery(parseXml(deviceQuery({ id: METER, connected: false })), METER);
  assert.equal(down.connected, false);
  const wh = parseXml(
    '<Device><Components><Component><Variables><Variable><Name>zigbee:CurrentSummationDelivered</Name><Value>2000</Value><Units>Wh</Units></Variable><Variable><Name>zigbee:InstantaneousDemand</Name><Value>300</Value><Units>__proto__</Units></Variable></Variables></Component></Components></Device>',
  );
  assert.deepEqual(parseDeviceQuery(wh, METER), {
    connected: undefined,
    power: undefined,
    delivered: 2,
    received: undefined,
  });
});

test('the device query of another meter is never taken for this one', () => {
  assert.throws(
    () => parseDeviceQuery(parseXml(deviceQuery({ id: 'ffff' })), METER),
    /unknown_answer/,
  );
  assert.throws(() => parseDeviceQuery(parseXml('<DeviceList/>'), METER), /unknown_answer/);
});

test('numbers and hardware addresses are strict', () => {
  assert.equal(numberOf('1.965000'), 1.965);
  assert.equal(numberOf(' -2 '), -2);
  for (const raw of ['', 'invalid', '1e3', '0x10', 'Infinity', '1.2.3', undefined, null]) {
    assert.equal(numberOf(raw), undefined, String(raw));
  }
  assert.equal(hardwareId('0x00ABCD123'), '00abcd123');
  assert.equal(hardwareId('00abcd123'), '00abcd123');
  for (const raw of ['', '0x', 'zz', '0x12345678901234567', undefined]) {
    assert.equal(hardwareId(raw), undefined, String(raw));
  }
});

test('review 1, point 1: the query sends the address back exactly as listed, once checked', () => {
  const list = parseDeviceList(parseXml(deviceList([{ id: METER, address: ' 0x00ABCD123 ' }])));
  assert.deepEqual(list.meters, [{ id: METER, address: '0x00ABCD123', connected: true }]);
  assert.match(
    deviceQueryCommand(METER, list.meters[0].address),
    /<HardwareAddress>0x00ABCD123<\/HardwareAddress>/,
  );
  assert.throws(() => deviceQueryCommand(METER, '0x00abcd124'), TypeError);
  assert.throws(() => deviceQueryCommand(METER, '0x00abcd123<x>'), TypeError);
});

test('review 1, point 3: a list without ConnectionStatus is unknown, never "not linked"', () => {
  const list = parseDeviceList(parseXml(deviceList([{ id: METER, connected: null }])));
  assert.deepEqual(list.meters, [{ id: METER, address: '0x00abcd123', connected: undefined }]);
});

test('review 1, point 7: tab, line feed and carriage return references; a bare & kept', () => {
  assert.equal(parseXml('<A>a&#9;b&#10;c&#13;</A>').text, 'a\tb\nc');
  assert.equal(parseXml('<A>AT&T</A>').text, 'AT&T');
});
