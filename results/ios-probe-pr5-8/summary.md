# iOS Safari run ios-probe-pr5-8

Device: **iPhone Air**, iOS 26.2 Simulator (real Mobile Safari, Safari 26.2). Status: **partial**.

Notes: Automatic keyboard probe for a pull request

## Page as loaded

- Screen 420x912 pt at 3x; layout viewport 420x746 CSS px; visual viewport 420x746.
- Safe-area insets (notch / Dynamic Island / home indicator): {'bottom': 0, 'top': 0, 'right': 0, 'left': 0} (0 on edges Safari's own bars cover, and unless the page uses `viewport-fit=cover`).
- JavaScript measurements: working.

## On-screen keyboard

- `#price`: error: TimeoutError: timed out
- `#name`: error: TimeoutError: timed out

## Steps

| # | step | result | keyboard | shot |
|---|---|---|---|---|
| 1 | loaded | ok | False | `shots/01-loaded.jpg` |
| 2 | keyboard-number | error: TimeoutError: timed out | None | `shots/02-keyboard-number-error.jpg` |
| 3 | typed-price | error: TimeoutError: timed out | None | `shots/03-typed-price-error.jpg` |
| 4 | keyboard-dismissed | error: TimeoutError: timed out | None | `shots/04-keyboard-dismissed-error.jpg` |
| 5 | keyboard-text | error: TimeoutError: timed out | None | `shots/05-keyboard-text-error.jpg` |
| 6 | dismissed-2 | error: TimeoutError: timed out | None | `shots/06-dismissed-2-error.jpg` |
| 7 | picker-select | error: TimeoutError: timed out | None | `shots/07-picker-select-error.jpg` |
| 8 | picker-closed | error: TimeoutError: timed out | None | `shots/08-picker-closed-error.jpg` |
| 9 | picker-date | error: TimeoutError: timed out | None | `shots/09-picker-date-error.jpg` |
| 10 | date-closed | error: TimeoutError: timed out | None | `shots/10-date-closed-error.jpg` |
| 11 | top | error: TimeoutError: timed out | None | `shots/11-top-error.jpg` |
| 12 | swipe-up | error: TimeoutError: timed out | None | `shots/12-swipe-up-error.jpg` |

## Notes

- end-of-run page reads failed: timed out

Shots are the whole device screen (Safari's bars, keyboard, pickers included). `steps.json` has every measurement; `keyboard-*/` has the video, frames, and filmstrip of each keyboard attempt.
