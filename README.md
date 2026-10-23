# gladys-rainforest-eagle

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**Rainforest Eagle-200** and **Eagle-3** energy gateways (smart electricity
meters of the United States and Canada). It reads the gateway through its
local API (HTTP, Cloud ID and install code of the label, no cloud) every 30
seconds: the power of the home, the consumption index of the meter for the
Gladys energy monitoring, and the energy sent to the grid. **Read-only**: it
never changes anything on the gateway nor on the meter.

**Never tested with a real device.** Not affiliated with Rainforest
Automation. The Eagle-100 (another API) is not supported.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Requirements: Gladys 5.2.0 or later, the Eagle on the same network, its
  Cloud ID and install code.

## How it works

- Every read: the `device_list` command first (the credentials check), then
  `device_query` for each electricity meter, POSTed as XML to
  `/cgi-bin/post_manager` with HTTP Basic credentials, one second apart, as
  the [aioeagle](https://github.com/home-assistant-libs/aioeagle) library
  (Apache-2.0) does. Ported to JavaScript, see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- One device per meter, keyed by its hardware address. The consumption index
  (`CurrentSummationDelivered`) is the only energy index; it passes the guard
  of gladys-p1-monitor (`src/guard.js`): never 0, jumps and drops held until
  the "Accept the held index" button is clicked twice. The energy sent to the
  grid is a plain sensor.
- Never a read faster than the interval, across reconnections, saves and
  restarts (`/data`); refused credentials stop the reads for good (kept in
  `/data`, only a gesture of the user tries again); 429 and 5xx pause the
  reads; the credentials are never logged.

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run audit
```

See [CLAUDE.md](CLAUDE.md) for the project rules, [TODO.md](TODO.md) for the
decisions and what is left to check on a real gateway.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
