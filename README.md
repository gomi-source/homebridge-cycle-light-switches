# homebridge-cycle-light-switches

A [Homebridge](https://homebridge.io) plugin that adds any number of virtual on/off
lights. Every light is paired with a configurable number of virtual, single-press
switches. Each time the light is turned on — from the Home app, Siri, or an
automation — the plugin fires the *next* switch in a round-robin rotation. Point
HomeKit automations at each switch's "Single Press" trigger to chain further actions
off a light being turned on, cycling through a different action every time.

Built from the [official Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template),
using the [Homebridge Plugin API](https://developers.homebridge.io/#/).

## Why "virtual"?

Homebridge bridges accessories into Apple's HomeKit Accessory Protocol (HAP), not
Matter, so it doesn't have literal `OnOffLight` / `GenericSwitch` device types. This
plugin implements the closest HAP equivalents:

- **Light** → a HAP `Lightbulb` service exposing only the `On` characteristic (no
  brightness/color) — an on/off-only light.
- **Switch** → a HAP `StatelessProgrammableSwitch` service, restricted to only ever
  report a `SINGLE_PRESS` event — HomeKit's stateless "button" accessory type, which is
  what Home/Homebridge calls a Generic Switch, configured for single press only. When a
  light has more than one switch, they're grouped under a `ServiceLabel` service, which
  is the standard HomeKit pattern for exposing several buttons on one accessory.

## Installation

```bash
npm install
npm run build
```

Then either:

- `npm link` and add it to a local Homebridge instance's `node_modules`, or
- publish it to npm and install it normally (`npm install -g homebridge-cycle-light-switches`).

## Configuration

Add a platform block to Homebridge's `config.json` (or use the plugin's settings UI,
which reads `config.schema.json`):

```json
{
  "platforms": [
    {
      "platform": "VirtualLightSwitches",
      "name": "Virtual Light Switches",
      "lights": [
        {
          "name": "Kitchen Scene Trigger",
          "switchCount": 3,
          "resetCountOnOff": false
        },
        {
          "name": "Front Door Chime",
          "switchCount": 2,
          "resetCountOnOff": true,
          "switchNames": ["Front Door Chime - Day", "Front Door Chime - Night"]
        }
      ]
    }
  ]
}
```

### Options (per light)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | — | Display name of the light. Must be unique. Renaming a light creates a new HomeKit accessory (and resets its switch counter), since the accessory identity is derived from the name. |
| `switchCount` | integer | `1` | How many switches accompany this light. |
| `resetCountOnOff` | boolean | `false` | See below. |
| `switchNames` | string[] | — | Optional custom names for each switch, in order. Falls back to `"<Light Name> Switch <n>"`. |

## Behavior

Turning the light **on** — regardless of whether it was already on (e.g. an automation
re-sends "turn on" while it's already on) — advances an internal counter and fires
exactly one switch: the counter modulo `switchCount`. Turning the light **off** never
fires a switch.

**`resetCountOnOff: false` (default)** — the rotation never resets. With 3 switches,
turning the light on four times in a row fires switches `1, 2, 3, 1`, in that order,
no matter how many times the light was turned off in between.

**`resetCountOnOff: true`** — turning the light off resets the rotation back to the
start. With 2 switches: turning on twice fires `1, 2`; turning the light off; turning
it on twice more fires `1, 2` again — i.e. the full sequence is `1, 2, (off), 1, 2`.

Other than that reset, the rotation position is kept indefinitely: it's stored in
Homebridge's accessory cache on disk, so it survives Homebridge restarts. It only
resets to zero if you explicitly enable `resetCountOnOff`, or if the accessory is
removed (e.g. by renaming the light or deleting it from the config).

## Example automation

1. In the Home app, create an automation that turns on "Kitchen Scene Trigger".
2. Create a second automation: "When Kitchen Scene Trigger Switch 1 is single pressed →
   run scene A." Repeat for Switch 2 → scene B, Switch 3 → scene C.
3. Every time you (or another automation) turn on "Kitchen Scene Trigger", it cycles
   through scenes A, B, C, A, B, C, ...

## Development

- `npm run watch` — build, `npm link` the plugin, and run Homebridge with `nodemon` for
  live reload (requires a local Homebridge config; see `homebridge-plugin-template`'s
  docs for setting up `test/hbConfig`).
- `npm run lint` — lint with ESLint.
