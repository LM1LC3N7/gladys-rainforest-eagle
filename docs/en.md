# Rainforest Eagle

**Unofficial** integration, not affiliated with Rainforest Automation. It
reads your **Rainforest Eagle-200** or **Eagle-3** energy gateway (the Zigbee
gateway that reads the smart electricity meter of many utilities in the
United States and Canada) on your local network, through its local API
(HTTP), with the Cloud ID and the install code printed on its label, without
any cloud.

**Never tested with a real device**: the integration was written from the
[aioeagle](https://github.com/home-assistant-libs/aioeagle) library (the one
of Home Assistant), without an Eagle at hand. The Eagle-3 is expected to
answer like the Eagle-200 (same local API), this is not verified. The old
Eagle-100 (another API) is not supported. Your feedback is welcome.

## Read-only

The integration **only reads** (the `device_list` and `device_query` commands
of the local API). It never changes anything on the gateway nor on the meter
(no price, no message confirmation, no setting).

## What you get

One device per electricity meter the Eagle reads (named "Eagle meter" and its
hardware address, e.g. `0x00abcd123`):

- **power** (W): the instantaneous demand of the meter, **negative** when the
  home sends power to the grid (solar);
- **consumption index** (kWh): the energy the meter delivered to the home,
  for the Gladys energy monitoring (Gladys computes the consumption and its
  cost from it);
- **energy sent to the grid** (kWh, total): a plain sensor, **never** counted
  as consumption. It is never sent at 0: without solar panels (nothing ever
  sent to the grid), it stays empty, which is normal.

### Energy monitoring

The consumption index is the energy taken from the grid, as measured by the
meter of your utility. If another integration already sends this same meter
to Gladys (another gateway, a utility account), **keep only one source**,
otherwise the consumption is counted twice. The integration never sends a
daily consumption.

## Requirements

- Gladys 5.2.0 or later.
- The Eagle on the same network as Gladys, its local API reachable over HTTP
  (port 80), already joined to your meter (see its app).
- The **Cloud ID** (6 characters) and the **install code** (16 characters):
  on the label under the gateway.

## Configuration

1. Install the integration from the Gladys store.
2. **Eagle IP address**: its address on your network (with `:port` only if it
   is not 80). Preferably give it a fixed address in your router (the
   `eagle-<cloud id>.local` name usually does not resolve inside a
   container).
3. **Cloud ID**: never logged.
4. **Install code**: kept by Gladys in its database, never shown again; sent
   only to the Eagle (in the header of its requests), never logged.
5. **Reading interval**: 30 s by default, 30 to 300 s (each read: the device list,
   then one small request per meter, one second apart: two requests for one
   meter).
6. After the first read, create the meter device from the **Discover** tab.

The **Test the connection** button reads the Eagle once if the interval has
passed; otherwise it shows the last read and when the next one can be.

## Pace of the reads

Nothing reads the Eagle faster than the interval: not the test button, not
the Discover tab, not a reconnection to Gladys, not a save of an unchanged
configuration, not a restart of the container (the instant of the last read
is kept in `/data`, written at most once a minute: after a restart, the first
read waits the interval plus one minute). A new address or new credentials
are tried at once.

## Held index

Gladys counts each rise of an index in full. So that no fictive energy is
ever counted, the consumption index goes through a guard:

- a value of 0 is never sent;
- a drop, or a rise faster than 100 kW on average, is **held**: the last
  accepted value is sent again, and the status of the integration shows it.
  Neither time nor repetition confirm it (it stays held after a restart);
- if it is right, click **Accept the held index** **twice**: the first click
  lists what is held without accepting anything, the second, from 3 seconds
  to 5 minutes later, accepts exactly what was listed (a jump is then counted
  at once, a drop counts nothing). Saving the configuration accepts nothing.

## Errors

- **Credentials refused** (HTTP 401/403 of the device list): the reads stop
  and **never start again by themselves** (a wrong install code is never
  tried in a loop); the stop is kept in `/data` across restarts. Saving other
  credentials tries them at once; **Test the connection** tries once per
  click. To recognize refused credentials after a restart, `/data` keeps a
  salted fingerprint of the refused pair only (never of a working one),
  erased by the first successful read.
- An HTTP 429 answer (to any request) or a 5xx answer of the device list
  pauses the reads from 1 minute to 6 hours, kept in `/data`. Another error
  of the query of one meter only leaves that meter out: the others are
  published.
- Devices of the Eagle that are not electricity meters, or whose hardware
  address cannot be read, are left out; the status gives their number.
- An unreachable Eagle is tried again after 1 minute, then 2, up to
  15 minutes, never faster than the interval.
- Every read starts with the device list, with the credentials of the label:
  another Eagle that takes the address (DHCP) refuses them and gives nothing;
  another device answers something that is not an Eagle answer, nothing is
  published.
- A meter the Eagle no longer reaches (not "Connected") publishes nothing (its
  values would be stale); the status says so.

## Privacy

Nothing leaves your network: the integration only talks to the Eagle, over
local HTTP, and follows no redirect. The install code travels in clear text
on your local network (HTTP Basic), as for any client of this local API.
