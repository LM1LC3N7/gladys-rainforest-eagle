// -----------------------------------------------------------------------------
// The Gladys device of each smart meter the Eagle reads, and its states. Pure.
//
// External id (forever): meter:<hardware address> (the Zigbee address of the
// meter in the device list, `0x` dropped, lower case: it belongs to the meter,
// whatever the gateway or its IP address). Feature keys (forever): FEATURE.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service), as in gladys-p1-monitor:
// - `consumption_index` (CurrentSummationDelivered: the electricity the meter
//   delivered to the home, a lifetime counter) is the ONLY energy-sensor /
//   index feature: the core derives the consumption and its cost from its
//   deltas, by itself. It passes the guard of src/guard.js: never 0, a drop
//   or a jump held until the user accepts it in two clicks;
// - the energy received from the home (CurrentSummationReceived, solar sent
//   to the grid) is NEVER in an energy-sensor index (it would be billed as
//   consumption): a plain sensor, kWh in the name;
// - `power` (InstantaneousDemand, the net power, negative when the home sends
//   power to the grid) is the only energy-sensor / power feature;
// - no daily total, never publishEnergyConsumption;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): W and kWh for energy-sensor, none for
//   unknown (the unit is then in the name).
//
// The catalog is fixed: every device gets every feature, so a device
// published again never loses one ("Update" in Discovery would drop its
// history).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { ENERGY_MAX, EXTERNAL_ID_TYPE, POWER_MAX } from './constants.js';
import { hardwareAddress } from './eagle/model.js';

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  CONSUMPTION_INDEX: 'consumption_index',
  INJECTION_INDEX: 'injection_index',
};

/**
 * The guarded indexes: their feature, the value they come from
 * (src/eagle/model.js parseDeviceQuery), their limits (INDEX_LIMITS) and
 * their name in the texts (src/i18n.js).
 */
export const INDEXES = [
  { name: 'consumption', key: FEATURE.CONSUMPTION_INDEX, value: 'delivered' },
];

/** The external ids of the meter `id`. */
export const ids = (gladys, id) => gladys.externalIds(EXTERNAL_ID_TYPE, id);

/** The meter id of a device external id of this integration, or undefined. */
export function meterIdOf(gladys, externalId) {
  const prefix = ids(gladys, 'x').device.slice(0, -1);
  const text = String(externalId ?? '');
  if (!text.startsWith(prefix)) return undefined;
  const id = text.slice(prefix.length);
  return /^[0-9a-f]{1,16}$/.test(id) ? id : undefined;
}

const def = (key, value, digits, spec) => ({ key, value, digits, spec });

export const CATALOG = [
  def(FEATURE.POWER, 'power', 0, {
    name: 'Power (negative when sending to the grid)',
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: -POWER_MAX,
    max: POWER_MAX,
  }),
  def(FEATURE.CONSUMPTION_INDEX, 'delivered', 3, {
    name: 'Consumption index',
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    max: ENERGY_MAX,
  }),
  def(FEATURE.INJECTION_INDEX, 'received', 3, {
    name: 'Energy sent to the grid (kWh, total, not counted)',
    category: C.UNKNOWN,
    type: T.SENSOR.DECIMAL,
    max: ENERGY_MAX,
  }),
];

/** The device of one meter. `address`: the address of the Eagle (`host:port`). */
export function buildDevice(gladys, id, address) {
  const external = ids(gladys, id);
  return {
    name: `Eagle meter ${hardwareAddress(id)}`,
    external_id: external.device,
    features: CATALOG.map(({ key, spec }) => ({
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...spec,
      external_id: external.feature(key),
    })),
    params: [
      { name: 'EAGLE_ADDRESS', value: address ?? '' },
      { name: 'EAGLE_METER', value: hardwareAddress(id) },
    ],
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const INDEX_KEYS = new Set(INDEXES.map((i) => i.key));

/**
 * The states of one meter. `values`: src/eagle/model.js parseDeviceQuery;
 * `indexes`: by feature key, the values the guards let through (undefined:
 * not published this time). An index is never taken from `values` directly.
 * A counter is never published at 0.
 */
export function readStates(external, values, indexes = {}) {
  const states = [];
  for (const { key, value, digits, spec } of CATALOG) {
    let v = INDEX_KEYS.has(key) ? indexes[key] : values[value];
    if (!isNumber(v)) {
      continue;
    }
    v = round(v, digits);
    const counter = spec.type === T.ENERGY_SENSOR.INDEX || key === FEATURE.INJECTION_INDEX;
    if ((counter && v <= 0) || v < (spec.min ?? 0) || v > spec.max) {
      continue;
    }
    states.push({ device_feature_external_id: external.feature(key), state: v });
  }
  return states;
}
