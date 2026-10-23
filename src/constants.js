// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js) is forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_index' };

/**
 * The external id of a meter: `meter:<hardware address>`, the Zigbee address
 * of the smart meter the Eagle lists (`HardwareAddress`, `0x` dropped, lower
 * case). It belongs to the meter, not to the gateway nor to its IP address.
 */
export const EXTERNAL_ID_TYPE = 'meter';

// --- The local API of the Eagle-200 / Eagle-3 (as the aioeagle library uses it) ------
export const DEFAULT_PORT = 80;
/** The only URL: every command is an XML document POSTed here. */
export const PATH = '/cgi-bin/post_manager';
/** The commands sent (read-only): the device list, and the values of one meter. */
export const COMMANDS = { DEVICE_LIST: 'device_list', DEVICE_QUERY: 'device_query' };
/** The ModelId of a smart electricity meter in the device list. */
export const ELECTRIC_METER = 'electric_meter';
/** The variables read (names of the Eagle API). */
export const VARIABLES = {
  DEMAND: 'zigbee:InstantaneousDemand',
  DELIVERED: 'zigbee:CurrentSummationDelivered',
  RECEIVED: 'zigbee:CurrentSummationReceived',
};
/** The library sets no timeout; an answer of a gateway on the home network comes far sooner. */
export const HTTP_TIMEOUT = 10_000;
/** A device query with every variable is about 15 KiB: more is not an answer of the Eagle. */
export const MAX_BODY_BYTES = 256 * 1024;
/** The library waits one second between two requests to the gateway. */
export const REQUEST_GAP = 1000;
/** At most this many meters are read (a home has one, rarely two). */
export const MAX_METERS = 4;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** The reading interval of the form (s): 30 s by default (as Home Assistant), 30 to 300. */
export const POLL_DEFAULT = 30;
export const POLL_MIN = 30;
export const POLL_MAX = 300;
/** How often the integration looks whether a read is due (never a read by itself). */
export const TICK = 5 * SECOND;
/**
 * The instant of the last request is written to /data at most once a minute:
 * after a restart, the first read waits this long on top of the interval, so
 * that a container restarting in a loop never reads faster than the interval.
 */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** The states sent in any 60 s, at most (the core refuses a whole batch beyond 300). */
export const STATES_PER_MINUTE = 270;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** Unreachable: tried again after 1 min (never faster than a read), doubled up to 15 min. */
export const RETRY_MIN = MINUTE;
export const RETRY_MAX = 15 * MINUTE;
/** HTTP 429 or 5xx of the device list: a pause from 60 s to 6 h, kept in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** The test button answers within this delay. */
export const TEST_ANSWER_WITHIN = 25 * SECOND;
/** The second click of "Accept the held index" counts from 3 s to 5 min after the first. */
export const ACCEPT_CONFIRM_AFTER = 3 * SECOND;
export const ACCEPT_CONFIRM_WITHIN = 5 * MINUTE;
/** Values older than this many intervals are no longer published as current. */
export const FRESH_INTERVALS = 2;

// --- Energy index ---------------------------------------------------------------------
/**
 * The guard of the consumption index (src/guard.js), as gladys-p1-monitor: a
 * home never draws more than 100 kW on average between two reads (a 200 A
 * service at 240 V is 48 kW), and 0.5 kWh is always accepted on top
 * (rounding, a late read).
 */
export const INDEX_LIMITS = { consumption: { maxKw: 100, slackKwh: 0.5 } };

/** A power above this (W, either sign) is a glitch. */
export const POWER_MAX = 100_000;
/** A lifetime counter above this (kWh) is a glitch. */
export const ENERGY_MAX = 100_000_000;
