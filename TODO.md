# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Eagle-200 (and an Eagle-3): the
      test button, device creation, the consumption index in the energy
      monitoring.
- [ ] Test the Docker image (no Docker on the development PC yet).
- [ ] Run the store validator (`npx github:GladysAssistant/integration-store .`):
      the development agent could not run it.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real gateway (built without one)

- [ ] That the Eagle-3 answers the same `device_list` / `device_query` as the
      Eagle-200 (the proposal names both; aioeagle only names the 200).
- [ ] The units the firmware sends (`kW`, `kWh`; `W` and `Wh` are read too)
      and that the values are already scaled (Divisor and Multiplier
      applied by the gateway, as `data.txt` of aioeagle shows).
- [ ] The sign of `InstantaneousDemand` on a home with solar (negative when
      sending to the grid).
- [ ] The answer to refused credentials (401, as aioeagle reads it) and to a
      malformed command.
- [ ] Whether the `ConnectionStatus` of the device list follows a lost meter
      quickly enough to stop stale values, and whether every firmware
      (Eagle-3?) sends it at all (missing: read as unknown, the values go).
- [ ] `LastContact` (hexadecimal seconds, clock of the Eagle) is not read: if
      an Eagle keeps "Connected" with frozen values, they are sent again (no
      delta for the index, the guard does not move). Read it once seen on a
      real gateway, compared with the clock of the Eagle, never ours.
- [ ] A real answer that ends in `not_xml`: the XML reader keeps a bare `&`
      (`AT&T`) as text and accepts `&#9;`, `&#10;`, `&#13;`; anything else
      odd refuses the whole answer.

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-rainforest-eagle:0.1.0`),
  as for the sibling integrations; the Release workflow owns them from now on
  (the first patch release gives 0.1.1).
- **Reused project**: aioeagle (home-assistant-libs, Apache-2.0, 1.1.1,
  `main` at commit a9bf530, LICENSE checked: Apache License 2.0, "Copyright
  2018 Paulus Schoutsen", no NOTICE file), cloned read-only in
  `_ref/aioeagle`, ported to JavaScript: the URL, the XML commands, the Basic
  credentials, the one-second gap, the reading of the answers. The SDK stays
  the only runtime dependency (no XML library: a small bounded reader of our
  own). Structure, pace, pauses, store and two-click acceptance from
  gladys-sonnen; guard identical to gladys-sonnen's `src/guard.js` (the
  approved guard of gladys-p1-monitor with `maxKw` as a parameter). The
  template's demo files were removed (`git rm`). The Eagle-100 (eagle100
  library, another API, license not checked) is not covered.
- **Read-only (v1)**: no `onSetValue`; the client only knows the two read
  commands (tested). Nothing sensitive to command on this device anyway.
- **Identity, one device per meter**: external id `meter:<hardware address>`
  (the `HardwareAddress` of the device list, `0x` dropped, lower case, hex
  only, at most 16 digits): it belongs to the meter, so a new gateway or a
  new IP address keeps the device and its history. An unreadable address
  leaves that entry out (counted, never taken for another meter; the status
  gives the number of devices left out); the answer of a query naming
  another meter is refused. At most 4 meters. The query sends the address
  back exactly as listed (case, leading zeros), once checked to be the same
  hexadecimal address (review 1, point 1).
- **Identity of the gateway at every read**: the device list is asked first,
  with the Cloud ID and the install code; another Eagle at the address (DHCP)
  refuses them (401: refused, final, see below); another device gives an
  answer that is not a `DeviceList` (`unknown_answer`, retried at the pace of
  failures, nothing published).
- **Refused credentials are final** (lot 12 lesson): a 401/403 of the device
  list is kept in `/data` (`{ status, fp }`), the timer never tries again (no
  spaced automatic retry: an install code is never tried in a loop). A click
  on "Test the connection" tries once when the interval has passed; saving
  other credentials tries them at once (in memory, or by a different salted
  scrypt fingerprint after a restart). The refusal is erased only by a
  success. `fp` is a fingerprint of the refused pair only: nothing in `/data`
  can confirm working credentials. A 401/403 of one meter query after the
  device list took the credentials only leaves that meter out (`denied`).
- **Energy (lot 6 rules)**: `CurrentSummationDelivered` is the only index
  (`energy-sensor` / `index`, kWh), through the IndexGuard with
  `INDEX_LIMITS.consumption` = 100 kW, 0.5 kWh (as gladys-p1-monitor: a home
  connection); the same margin bounds the second click. The energy received
  from the home (`CurrentSummationReceived`) is a plain sensor (`unknown`,
  kWh in the name), never published at 0, never an index. The power
  (`InstantaneousDemand`) is the only `energy-sensor` / `power`, signed as the
  meter gives it (as gladys-energieleser). No daily value, never
  `publishEnergyConsumption` (tested). The price variables of the meter are
  not read (often `invalid`, currency of the utility).
- **Stale values**: a meter whose `ConnectionStatus` is read and not
  `Connected` (in the list or in its own answer) publishes nothing; the
  status names it. A status missing on either side is unknown, the same rule
  for both (review 1, point 3).
- **Pace (lot 11)**: one read = one `device_list` + one `device_query` per
  meter, one second apart (aioeagle), 30 s by default (30-300 s, Home
  Assistant reads every 30 s). The timer looks every 5 s whether a read is
  due; nothing reads sooner than the last request + the interval (monotonic
  clock): not the test button, not Discovery (it only republishes the
  meters known), not a (re)connection, not a save of an unchanged form, not a
  restart (the last request is written to `/data` at most once a minute, so
  after a restart the first read waits that instant + one minute + the
  interval). A new address or new credentials are read at once. A read
  running is never doubled, whatever its generation; a read that ends after
  a restart or a new configuration publishes nothing and sets no status.
- **429 / 5xx**: of the device list (or a 429 anywhere): pause
  `{ until, count, code, status }` in `/data`, from Retry-After or 1 min
  doubled, 1 min - 6 h, at least the interval, end capped when read back.
- **Unreachable**: 1 min (never faster than a read), doubled up to 15 min.
- **Hostile answers**: bodies bounded to 256 KiB, read into one buffer; the
  XML reader is linear (each `<` and `>` found once), at most 5000 elements
  and 16 levels, no DOCTYPE, only the XML entities and numeric references,
  elements kept in arrays (no prototype pollution); numbers only as plain
  decimals with a known unit, ranges checked. Never a text of the Eagle in a
  message (meter names, utility messages are not read).
- **No custom User-Agent**, no imitation: Node's own fetch, the requests of
  the library. No Bluetooth. No network discovery (the address is typed; the
  `eagle-<cloud id>.local` default of the library is not used: mDNS rarely
  resolves in a container).
- **States per minute**: a sliding budget of 270 states over 60 s, taken
  before each publication.
- **Gladys version**: `>=5.2.0`, like the other energy integrations.

## Ideas

- The price and the tier the utility sends (`zigbee:Price`, `PriceTier`),
  once their format is seen on a real meter.
- The Eagle-100 (another API: eagle100 library, license to check).
