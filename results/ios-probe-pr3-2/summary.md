# iOS Safari run ios-probe-pr3-2

Device: **iPhone Air**, iOS 26.2 Simulator (real Mobile Safari, Safari 26.2). Status: **failed**.

Error: `TimeoutError: timed out`

Notes: Automatic keyboard probe for a pull request

## Page as loaded

- Screen 420x912 pt at 3x; layout viewport 420x746 CSS px; visual viewport 420x746.
- Safe-area insets (notch / Dynamic Island / home indicator): {'bottom': 0, 'top': 0, 'right': 0, 'left': 0} (all 0 unless the page uses `viewport-fit=cover`).
- JavaScript measurements: working.

## On-screen keyboard

- `#price`: error: KeyError: 'element-6066-11e4-a52f-4f735466cecf'
- `#name`: error: KeyError: 'element-6066-11e4-a52f-4f735466cecf'

## Steps

| # | step | result | keyboard | shot |
|---|---|---|---|---|
| 1 | loaded | ok | False | `shots/01-loaded.jpg` |
| 2 | keyboard-number | error: KeyError: 'element-6066-11e4-a52f-4f735466cecf' | None | `shots/02-keyboard-number-error.jpg` |
| 3 | typed-price | error: KeyError: 'element-6066-11e4-a52f-4f735466cecf' | None | `shots/03-typed-price-error.jpg` |
| 4 | keyboard-dismissed | ok | False | `shots/04-keyboard-dismissed.jpg` |
| 5 | keyboard-text | error: KeyError: 'element-6066-11e4-a52f-4f735466cecf' | None | `shots/05-keyboard-text-error.jpg` |
| 6 | dismissed-2 | ok | False | `shots/06-dismissed-2.jpg` |
| 7 | picker-select | error: KeyError: 'element-6066-11e4-a52f-4f735466cecf' | None | `shots/07-picker-select-error.jpg` |
| 8 | picker-closed | ok | False | `shots/08-picker-closed.jpg` |
| 9 | picker-date | error: KeyError: 'element-6066-11e4-a52f-4f735466cecf' | None | `shots/09-picker-date-error.jpg` |
| 10 | date-closed | ok | False | `shots/10-date-closed.jpg` |
| 11 | top | error: ValueError: invalid literal for int() with base 10: 'top' | None | `shots/11-top-error.jpg` |
| 12 | swipe-up | error: TimeoutError: timed out | None | `shots/12-swipe-up-error.jpg` |

Shots are the whole device screen (Safari's bars, keyboard, pickers included). `steps.json` has every measurement; `keyboard-*/` has the video, frames, and filmstrip of each keyboard attempt.
