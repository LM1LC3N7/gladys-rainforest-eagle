// -----------------------------------------------------------------------------
// A fake Eagle-200: the device list and the device query of one electricity
// meter, shaped as the answers aioeagle parses (the docstring of its
// `electric_meter.py` and its `data.txt`), with the values of `data.txt`.
// `state` is mutable by the tests.
// -----------------------------------------------------------------------------

export const ADDRESS = '192.168.1.60:80';
export const HOST = '192.168.1.60';
export const NOW = Date.parse('2026-10-23T10:00:00Z');
export const CLOUD_ID = '0077dd';
export const INSTALL_CODE = '6c9d2e4f1a3b5c7d';
export const METER = '00abcd123';

export const basic = (cloudId, code) =>
  `Basic ${Buffer.from(`${cloudId}:${code}`).toString('base64')}`;

export const xml = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/xml', ...headers } });

export const deviceList = (meters) =>
  `<DeviceList>${meters
    .map(
      ({ id, connected = true, model = 'electric_meter', address = `0x${id}` }) =>
        `<Device><HardwareAddress>${address}</HardwareAddress><Manufacturer>Generic</Manufacturer>` +
        `<ModelId>${model}</ModelId><Protocol>Zigbee</Protocol><LastContact>0x611d885a</LastContact>` +
        // `connected: null`: a firmware that sends no ConnectionStatus in the list.
        (connected === null
          ? ''
          : `<ConnectionStatus>${connected ? 'Connected' : 'Not Joined'}</ConnectionStatus>`) +
        `<NetworkAddress>0x0000</NetworkAddress><Name>Power Meter</Name></Device>`,
    )
    .join('')}</DeviceList>`;

const variable = (name, value, units) =>
  `<Variable><Name>${name}</Name><Value>${value ?? ''}</Value>` +
  `${units === undefined ? '' : `<Units>${units}</Units>`}<Description>x</Description></Variable>`;

export const deviceQuery = ({
  id,
  connected = true,
  demand = '1.965000',
  delivered = '2853.662000',
  received = '0.000000',
}) =>
  `<?xml version="1.0"?><Device><DeviceDetails><HardwareAddress>0x${id}</HardwareAddress>` +
  `<Name>Power Meter</Name><Protocol>Zigbee</Protocol>` +
  `<ConnectionStatus>${connected ? 'Connected' : 'Not Joined'}</ConnectionStatus></DeviceDetails>` +
  `<Components><Component><HardwareId>0x${id}</HardwareId><FixedId>0</FixedId><Name>Main</Name>` +
  '<Variables>' +
  variable('zigbee:InstantaneousDemand', demand, 'kW') +
  variable('zigbee:CurrentSummationDelivered', delivered, 'kWh') +
  variable('zigbee:CurrentSummationReceived', received, 'kWh') +
  variable('zigbee:Price', 'invalid') +
  variable('zigbee:Message', '') +
  '</Variables></Component></Components></Device>';

/**
 * The routes of an Eagle at HOST. `state.meters`: the device list;
 * `state.values[id]`: the query answer fields; `state.fail[command]`: a
 * status or a handler; `state.hold`: a promise the answers wait for.
 */
export function eagle({
  cloudId = CLOUD_ID,
  installCode = INSTALL_CODE,
  meters = [{ id: METER }],
  values = {},
  fail = {},
  hold,
} = {}) {
  const state = { meters, values, fail, hold };
  const route = async (call) => {
    if (state.hold) await state.hold;
    if (call.init.method !== 'POST') return xml('', 405);
    const command = /<Name>([a-z_]+)<\/Name>/.exec(call.init.body ?? '')?.[1];
    const failing = state.fail[command];
    if (typeof failing === 'function') return failing(call);
    if (typeof failing === 'number') return xml('', failing);
    if (call.init.headers.Authorization !== basic(cloudId, installCode)) {
      return xml('Unauthorized', 401);
    }
    if (command === 'device_list') return xml(deviceList(state.meters));
    if (command === 'device_query') {
      // A picky firmware: the address must come back exactly as listed.
      const sent = /<HardwareAddress>([^<]*)<\/HardwareAddress>/.exec(call.init.body)[1];
      const meter = state.meters.find((m) => (m.address ?? `0x${m.id}`) === sent);
      if (!meter) return xml('', 500);
      return xml(deviceQuery({ id: meter.id, ...state.values[meter.id] }));
    }
    return xml('', 400);
  };
  return { '/cgi-bin/post_manager': route, state };
}
