# homebridge-cycle-light-switches

A [Homebridge](https://homebridge.io) plugin that adds any number of virtual on/off
lights. Every light is paired with a configurable number of virtual, single-press
switches. Each time the virtual light is turned on — from the Home app, Siri, or an
automation — the plugin fires the *next* switch in a round-robin rotation. Point
HomeKit automations at each switch's "Single Press" trigger to chain further actions
off a light being turned on, cycling through a different action every time.

Built from the [official Homebridge plugin template](https://github.com/homebridge/homebridge-plugin-template),
using the [Homebridge Plugin API](https://developers.homebridge.io/#/).

## Why?

The basic problem to solve is using a trigger (e.g. a wall switch) to trigger different
actions (e.g. different light scenes/scenarios) in sequence. The first time you hit the
a switch you might want to set a mood, the second time blaze all lights max, and finally
turn everything off. And the following time start the cycle again.

I used to achieved this by nested if/else in Shortcuts in Apple Home, but after switching
to Matter over Thread, the delay of several seconds for running a shortcut became very
apparent, and annoying. So this plugin runs the logic without having to slow everything
down with Shortcuts.

## How?

This plugin implements HAP services:

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
      "platform": "CycleLightSwitches",
      "name": "Cycle Light Switches",
      "lights": [
        {
          "name": "Kitchen Scene",
          "switchCount": 3,
          "resetCountOnOff": false
        },
        {
          "name": "Spotlights",
          "switchCount": 3,
          "resetCountOnOff": true,
          "turnOffOnCycleComplete": true
        },
        {
          "name": "Front Door Chime",
          "switchCount": 2,
          "resetCountOnOff": true,
          "switchNames": ["Front Door Chime First", "Front Door Chime Second"]
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
| `turnOffOnCycleComplete` | boolean | `false` | See below. |
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
start. With 3 switches, turning on twice fires `1, 2`; turning the light off; turning
it on twice more fires `1, 2` again — i.e. the full sequence is `1, 2, (off), 1, 2`.

**`turnOffOnCycleComplete: true`** — as soon as the switch that completes a full
rotation fires (e.g. switch 3 of 3), the plugin turns the virtual light off on
its own, immediately, as if it were a momentary trigger rather than something you
leave on. This is useful to combine an automation, e.g. a physical switch trigger
to cycle scenes, with being able to control the lights with buttons in the
Home app (see Advanced cycle below). This combines with `resetCountOnOff`: if
both are enabled, both manual and automatic off resets the rotation, so the next
"on" whether from trigger or button press, always starts the cycle from switch 1. 

Other than that reset, the rotation position is kept indefinitely: it's stored in
Homebridge's accessory cache on disk, so it survives Homebridge restarts. It only
resets to zero if you explicitly enable `resetCountOnOff`, or if the accessory is
removed (e.g. by renaming the light or deleting it from the config).

## Example automations

### Simple cycle

1. In the Home app, create an automation (or a button effect) that turns on "Kitchen
   Scene".
2. On "Kitchen Scene" there are Button 1, Button 2, Button 3. On Button 1, run
   scene A or set lights as required. Repeat for Switch 2 → scene B, Switch 3 →
   scene C.
3. Every time you (or an automation) turn on "Kitchen Scene", it cycles through
   scenes A, B, C, A, B, C, ...

### Advanced on/off scenes

Used for light scenes when the last step is always turn off, and both automation
triggers and manual control is used in combination.

1. In the Home app, set one or several automation triggers to turn on "Spotlights".
2. On "Spotlights" there are Button 1, Button 2, Button 3. Use Button 1 and
   Button 2 to control lights (or any devices). 
3. Leave Button 3 empty, instead create an automation that turn off your scene/lights
   when "Spotlights" is turned off.

Since `turnOffOnCycleComplete` is on, the scene/lights will turn off anyway. They will
also turn off when manually turning off "Spotlights" in the app, and `resetCountOnOff`
prepares for the next automated trigger or manual turn on of "Spotlights" in the app to
trigger the first switch (i.e. Button 1).

## Development

- `npm run watch` — build, `npm link` the plugin, and run Homebridge with `nodemon` for
  live reload (requires a local Homebridge config; see `homebridge-plugin-template`'s
  docs for setting up `test/hbConfig`).
- `npm run lint` — lint with ESLint.
