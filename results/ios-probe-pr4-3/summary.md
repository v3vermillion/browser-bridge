# iOS Safari run ios-probe-pr4-3

Device: **iPhone Air**, iOS 26.2 Simulator (real Mobile Safari, Safari 26.2). Status: **partial**.

Notes: Automatic keyboard probe for a pull request

## Page as loaded

- Screen 420x912 pt at 3x; layout viewport 420x746 CSS px; visual viewport 420x746.
- Safe-area insets (notch / Dynamic Island / home indicator): {'bottom': 0, 'top': 0, 'right': 0, 'left': 0} (0 on edges Safari's own bars cover, and unless the page uses `viewport-fit=cover`).
- JavaScript measurements: working.

## On-screen keyboard

- `#price`: keyboard **did NOT appear**.
  - webdriver-tap: open=False, focused=None, visual viewport 746 -> 746; screen motion 1790..1790 ms after the action. Shot: `shots/02-keyboard-webdriver-tap.jpg`, filmstrip: `keyboard-02-1/filmstrip.jpg`
  - send-keys: open=False, focused={'id': 'price', 'inputmode': 'decimal', 'type': 'number', 'tag': 'input'}, visual viewport 746 -> 746. Shot: `shots/03-keyboard-send-keys.jpg`, filmstrip: `keyboard-03-2/filmstrip.jpg`
  - simulator-app+webdriver-tap: open=False, focused=None, visual viewport 746 -> 746. Shot: `shots/04-keyboard-simulator-app-webdriver-tap.jpg`, filmstrip: `keyboard-04-3/filmstrip.jpg`
- `#name`: keyboard **did NOT appear**.
  - webdriver-tap: open=False, focused=None, visual viewport 746 -> 746; screen motion 1393..1393 ms after the action. Shot: `shots/07-keyboard-webdriver-tap.jpg`, filmstrip: `keyboard-07-1/filmstrip.jpg`
  - send-keys: open=False, focused={'id': 'name', 'inputmode': None, 'type': 'text', 'tag': 'input'}, visual viewport 746 -> 746; screen motion 311..311 ms after the action. Shot: `shots/08-keyboard-send-keys.jpg`, filmstrip: `keyboard-08-2/filmstrip.jpg`

## Steps

| # | step | result | keyboard | shot |
|---|---|---|---|---|
| 1 | loaded | ok | False | `shots/01-loaded.jpg` |
| 2 | keyboard-number | ok | False | `` |
| 3 | typed-price | ok | False | `shots/05-typed-price.jpg` |
| 4 | keyboard-dismissed | ok | False | `shots/06-keyboard-dismissed.jpg` |
| 5 | keyboard-text | ok | False | `` |
| 6 | dismissed-2 | ok | False | `shots/09-dismissed-2.jpg` |
| 7 | picker-select | ok | False | `shots/10-picker-select.jpg` |
| 8 | picker-closed | ok | False | `shots/11-picker-closed.jpg` |
| 9 | picker-date | error: WebDriverError: click intercepted:  | None | `shots/12-picker-date-error.jpg` |
| 10 | date-closed | ok | False | `shots/13-date-closed.jpg` |
| 11 | top | ok | False | `` |
| 12 | swipe-up | webdriver-touch: innerHeight 746 -> 746, address bar unchanged, scrolled 0 px | False | `shots/14-swipe-up.jpg` |

Shots are the whole device screen (Safari's bars, keyboard, pickers included). `steps.json` has every measurement; `keyboard-*/` has the video, frames, and filmstrip of each keyboard attempt.
