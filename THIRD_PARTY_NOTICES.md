# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below. The ported parts were rewritten
in JavaScript; they are changed from the original (another language, another
structure, only what this integration needs, read only). None of the original
code is copied as is.

## aioeagle (home-assistant-libs/aioeagle)

- Project: [home-assistant-libs/aioeagle](https://github.com/home-assistant-libs/aioeagle),
  the asynchronous Python library of the Rainforest EAGLE-200 used by the
  Home Assistant integration `rainforest_eagle`. Version 1.1.1
  (`pyproject.toml`), branch `main` at commit a9bf530 (2026-10-14).
- Copyright 2018 Paulus Schoutsen.
- What is ported (in `src/eagle/client.js`, `src/eagle/model.js` and
  `src/constants.js`): the local API of the gateway (an XML command POSTed to
  `http://<address>/cgi-bin/post_manager`, `Content-Type: text/xml`, the
  Cloud ID and the install code as HTTP Basic credentials, a 401 for refused
  credentials, one second between two requests), the `device_list` and
  `device_query` commands and their XML (`util.py` `create_command`,
  `dicttoxml`), the reading of the device list (`DeviceList`, `Device`,
  `HardwareAddress`, `ModelId` `electric_meter`, `ConnectionStatus`
  `Connected`) and of the device query (`DeviceDetails`, `Components`,
  `Component`, `Variables`, `Variable`, `Name`, `Value`, `Units`; every
  variable asked with `All` = `Y`, because some firmware omit
  `CurrentSummationDelivered` when it is asked by name), the variables read
  (`zigbee:InstantaneousDemand` in kW, `zigbee:CurrentSummationDelivered` and
  `zigbee:CurrentSummationReceived` in kWh). The test answers of
  `test/fixtures/eagle.js` follow the docstring of its `electric_meter.py`
  and the values of its `data.txt`.
- Changes: rewritten in JavaScript for a Gladys external integration; read
  only (nothing but the two read commands); a small bounded XML reader of our
  own instead of xmltodict (no DOCTYPE, no entity expansion, linear, no key of
  the answer as a property name); answers bounded to 256 KiB; a timeout on
  every request (the library sets none); no redirect followed; the
  credentials never logged; a value missing or odd is never read as 0; the
  answer of a meter is checked against its hardware address; the mDNS host
  name `eagle-<cloud id>.local` is not used (the address is typed).
- Licence: Apache License 2.0, whose full text is the `LICENSE` file shipped
  with this integration (and copied into its Docker image). The project ships
  no `NOTICE` file.

## gladys-sonnen, gladys-p1-monitor and gladys-air-q

The plausibility guard of the energy index (`src/guard.js`, the approved guard
of gladys-p1-monitor with its margin as a parameter, as in gladys-sonnen), the
structure of the integration (pace, pauses, refusal kept in `/data`), the
address parser (`src/config.js`) and the two-click acceptance come from the
sibling integrations [gladys-sonnen](https://github.com/LM1LC3N7/gladys-sonnen)
and [gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor); the
fingerprint of refused credentials kept in `/data` (`src/store.js`) from
[gladys-air-q](https://github.com/LM1LC3N7/gladys-air-q). Same project,
Apache-2.0.
