// -----------------------------------------------------------------------------
// The commands sent to the Eagle and the meaning of its answers, after
// aioeagle (home-assistant-libs, Apache-2.0, see THIRD_PARTY_NOTICES.md):
// `util.py` (create_command, dicttoxml), `hub.py` (get_device_list) and
// `electric_meter.py` (get_device_query). Pure.
//
// Every value is untrusted: a number is read only when it is written as a
// plain decimal number, with a known unit; anything else is left out (never
// read as 0). No text of the Eagle (meter name, manufacturer, message of the
// utility) ever reaches a status or a log.
// -----------------------------------------------------------------------------

import {
  COMMANDS,
  ELECTRIC_METER,
  ENERGY_MAX,
  MAX_METERS,
  POWER_MAX,
  VARIABLES,
} from '../constants.js';
import { child, children, textOf } from './xml.js';

/** An answer that is XML but not the one asked for (another device at the address?). */
export class AnswerError extends Error {
  constructor() {
    super('unknown_answer');
    this.name = 'AnswerError';
  }
}

/** `0x00abcd123` -> `00abcd123`; undefined when it is not a hexadecimal address. */
export function hardwareId(raw) {
  const match = /^(?:0x)?([0-9a-f]{1,16})$/i.exec(String(raw ?? '').trim());
  return match ? match[1].toLowerCase() : undefined;
}

/** The address as the Eagle wants it back in a command: `0x` + the id. */
export const hardwareAddress = (id) => `0x${id}`;

/** The device list command (aioeagle create_command("device_list")). */
export const deviceListCommand = () => `<Command><Name>${COMMANDS.DEVICE_LIST}</Name></Command>`;

/**
 * The query of every variable of one meter (aioeagle get_device_query with no
 * variable: `All` = `Y`; asking for the three variables by name misses
 * CurrentSummationDelivered on some firmware, the library says).
 */
export function deviceQueryCommand(id) {
  if (hardwareId(id) !== id) {
    throw new TypeError('hardware id');
  }
  return (
    `<Command><Name>${COMMANDS.DEVICE_QUERY}</Name>` +
    `<DeviceDetails><HardwareAddress>${hardwareAddress(id)}</HardwareAddress></DeviceDetails>` +
    '<Components><All>Y</All></Components></Command>'
  );
}

/**
 * The meters of a device list: `{ meters: [{ id, connected }], others }`,
 * the electricity meters with a readable hardware address (at most
 * MAX_METERS, in the order of the list), and how many other devices
 * (unknown models, unreadable addresses) were left out.
 * @throws AnswerError when it is not a device list.
 */
export function parseDeviceList(root) {
  if (root?.name !== 'DeviceList') {
    throw new AnswerError();
  }
  const meters = [];
  let others = 0;
  const seen = new Set();
  for (const device of children(root, 'Device')) {
    const id = hardwareId(textOf(device, 'HardwareAddress'));
    if (textOf(device, 'ModelId') !== ELECTRIC_METER || !id || seen.has(id)) {
      others += 1;
      continue;
    }
    if (meters.length >= MAX_METERS) {
      others += 1;
      continue;
    }
    seen.add(id);
    meters.push({ id, connected: textOf(device, 'ConnectionStatus') === 'Connected' });
  }
  return { meters, others };
}

/** A plain decimal number ("1.965000", "-0.250"), else undefined. */
export function numberOf(raw) {
  const text = String(raw ?? '').trim();
  if (!/^[+-]?\d{1,15}(?:\.\d{1,12})?$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The variables of the answer, by name (a Map: never a property of an object). */
function variablesOf(device) {
  const found = new Map();
  for (const component of children(child(device, 'Components'), 'Component')) {
    for (const variable of children(child(component, 'Variables'), 'Variable')) {
      const name = textOf(variable, 'Name');
      if (name && !found.has(name)) {
        found.set(name, { value: textOf(variable, 'Value'), units: textOf(variable, 'Units') });
      }
    }
  }
  return found;
}

const SCALE = {
  power: { kW: 1000, W: 1, '': 1000 },
  energy: { kWh: 1, Wh: 0.001, '': 1 },
};

/** A variable in W or kWh: its value scaled from its unit (none: the unit of the library). */
function scaled(variable, kind, max, min) {
  if (!variable) return undefined;
  const units = variable.units ?? '';
  const factor = Object.hasOwn(SCALE[kind], units) ? SCALE[kind][units] : undefined;
  const value = numberOf(variable.value);
  if (factor === undefined || value === undefined) return undefined;
  const result = value * factor;
  return result >= min && result <= max ? result : undefined;
}

/**
 * The values of one meter from its device query:
 * `{ connected, power, delivered, received }`: the net power in W (the
 * instantaneous demand, negative when the home sends power to the grid), the
 * energy delivered to the home and received from it in kWh (lifetime
 * counters of the meter). A value missing or odd is undefined.
 * @throws AnswerError when it is not the answer of this meter.
 */
export function parseDeviceQuery(root, id) {
  if (root?.name !== 'Device') {
    throw new AnswerError();
  }
  const details = child(root, 'DeviceDetails');
  const answered = hardwareId(textOf(details, 'HardwareAddress'));
  // Another meter's answer is never taken for this one; an answer without
  // its address is read (the command named the meter).
  if (answered !== undefined && answered !== id) {
    throw new AnswerError();
  }
  const status = textOf(details, 'ConnectionStatus');
  const variables = variablesOf(root);
  return {
    connected: status === undefined ? undefined : status === 'Connected',
    power: scaled(variables.get(VARIABLES.DEMAND), 'power', POWER_MAX, -POWER_MAX),
    delivered: scaled(variables.get(VARIABLES.DELIVERED), 'energy', ENERGY_MAX, 0),
    received: scaled(variables.get(VARIABLES.RECEIVED), 'energy', ENERGY_MAX, 0),
  };
}
