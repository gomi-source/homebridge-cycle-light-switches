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
- **Switch** → by default, a HAP `StatelessProgrammableSwitch` service, restricted to
  only ever report a `SINGLE_PRESS` event — HomeKit's stateless "button" accessory type,
  which is what Home/Homebridge calls a Generic Switch, configured for single press
  only. When a light has more than one switch, they're grouped under a `ServiceLabel`
  service, which is the standard HomeKit pattern for exposing several buttons on one
  accessory. These switches are read-only: you can react to them, but nothing can
  trigger one directly, since a stateless switch has no "on" state to set.
- **Stateful switch** (`statefulSwitches: true`) → an ordinary HAP `Switch` service
  instead — the same service type used for a plain HomeKit switch accessory. Because
  it's a regular settable on/off characteristic, a scene, automation, or a tap in the
  Home app can turn a *specific* switch on directly, jumping the rotation to it. This is
  how you let something other than "turn the light on" pick which step comes next.
  Exactly one switch per light is ever on — whichever one the rotation is currently
  sitting on — and it stays on until the rotation moves elsewhere, rather than pulsing
  back off a moment later. That matters for scenes in particular: a Home scene can only
  capture and re-apply explicit target states, so a switch that reverted itself a moment
  later made the scene that had just set it look "off" again, even though the jump it
  triggered had already worked — staying on keeps the scene's own displayed state honest
  too. As a bonus, each one is also individually renameable in the Home app, unlike the
  grouped "Button 1, Button 2, ..." stateless switches (which Home hardcodes those
  labels for, regardless of the name configured here).

  Stateful switches live on their **own standalone accessory each** — one accessory
  per switch, not shared with the light or with each other. That's deliberate, for two
  reasons. First, Home collapses any accessory exposing more than one controllable
  service into a secondary picker screen instead of a direct-tap tile, so the switches
  can't share the light's own accessory without dragging the light into that screen too.
  Second — and this is the part that isn't obvious until you hit it — a `Switch` service
  has no naming characteristic beyond its plain `Name`. If several switches shared *one*
  accessory instead (as an earlier version of this plugin did), Home's automation picker
  falls back to labelling every one of them with that shared accessory's name, making
  them indistinguishable when you go to pick "which switch" for an action. A standalone
  accessory per switch has no such ambiguity: the accessory's name *is* the switch's
  name, everywhere in Home. The tradeoff is one extra paired accessory per switch,
  which does clutter up the room view. If that bothers you, each switch accessory can
  be individually hidden from Home's main screen — its own accessory settings have a
  "Show in Favorites" (or similarly named) toggle — without affecting its availability
  to automations or Siri; you just won't see a tile for it day to day. Another option:
  assign all of a light's switches to a dedicated room (e.g. "Hidden" or "Automation")
  that has no other accessories shown in the main Home view — a room with nothing
  visible in it doesn't get listed as a room there at all, so the whole room (and
  everything in it) disappears from the tab bar rather than needing each accessory
  hidden individually. They're still fully there for automations either way. Stateless
  switches don't have either problem: a `StatelessProgrammableSwitch` never renders as
  a controllable tile in the first place, so it's harmless to leave several of them
  nested inside the light's own accessory.

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
        },
        {
          "name": "Evening Routine",
          "switchCount": 3,
          "resetCountOnOff": true,
          "statefulSwitches": true
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
| `statefulSwitches` | boolean | `false` | See below. |
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

**`statefulSwitches: true`** — switches become settable, so something other than the
light itself can pick which step fires next, and each one moves to its own standalone
accessory, named for that switch specifically (e.g. "Kitchen Scene Switch 2") — see
"How?" above for why they can't share an accessory. Turning a specific switch on
directly (from a scene, an automation action, or a tap in the Home app) jumps the
rotation to it — regardless of what the rotation was doing before — so the *next* time
the light turns on, it fires the switch that follows the one you triggered. For
example, with 3 switches, triggering Switch 1 directly and then turning the light on
fires Switch 2, even if the rotation had already moved past Switch 1 long ago. Whether
a switch fired because the light turned on or because it was triggered directly, it
stays on — and every other switch for that light turns off — until the rotation moves
on again, so whichever switch is "on" at any moment tells you exactly which step the
rotation is sitting on. If `resetCountOnOff` also fires (the light turns off with that
enabled), every switch turns off too, since no step is "current" until the next "on".

Toggling `statefulSwitches` for a light you've already set up in Home doesn't lose the
light's own history: the light keeps its accessory (and its rotation position) either
way, and only the switches move in or out of their own standalone accessories.

Other than a reset, the rotation position is kept indefinitely: it's stored in
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
   Button 2 to control lights (or any devices) for two distinct scenes. 
3. Leave Button 3 empty, instead create an automation that turns off your scene/lights
   when "Spotlights" is turned off.

Since `turnOffOnCycleComplete` is true, the scene/lights will turn off anyway on the third
"turn on". They will also turn off when manually turning off "Spotlights" in the app, and
`resetCountOnOff` prepares for the next automated trigger or manual "turn on" of "Spotlights"
in the app to trigger the first switch (i.e. Button 1).

### Jumping to a specific step

Set `statefulSwitches: true` on a light to let an automation or scene pick which step
runs next, instead of always advancing to "whatever's next". For example, with a
3-switch "Kitchen Scene" light:

1. Enable `statefulSwitches` for "Kitchen Scene".
2. Create an automation: some condition (e.g. a specific wall switch, time of day, or
   sensor) sets "Kitchen Scene Switch 2" to on — it's its own accessory, listed
   separately from "Kitchen Scene" itself and from the other switches.
3. The next time anything turns "Kitchen Scene" on — a different automation, or the
   Home app — it fires Switch 3, not whatever the rotation would otherwise have been
   on. Triggering a switch directly always determines what the *following* "on" does.

This is useful when you want an external condition to steer the cycle (e.g. "if it's
after sunset, the next toggle should jump straight to the night scene") without having
to also fire that scene's own action a second time. Since the switch you jump to stays
on until the rotation moves past it, the scene that set it reads back as staying
on/active too — it won't flip back to "off" moments later the way a momentary trigger
would.

## Development

- `npm run watch` — build, `npm link` the plugin, and run Homebridge with `nodemon` for
  live reload (requires a local Homebridge config; see `homebridge-plugin-template`'s
  docs for setting up `test/hbConfig`).
- `npm run lint` — lint with ESLint.
