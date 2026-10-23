# iOS Safari run ios-probe-pr5-11

Device: **iPhone 16e**, iOS 18.6 Simulator (real Mobile Safari, Safari 18.6). Status: **partial**.

Notes: Automatic keyboard probe for a pull request

## Page as loaded

- Screen 390x844 pt at 3x; layout viewport 390x663 CSS px; visual viewport 390x663.
- Safe-area insets (notch / Dynamic Island / home indicator): {'bottom': 0, 'top': 0, 'right': 0, 'left': 0} (0 on edges Safari's own bars cover, and unless the page uses `viewport-fit=cover`).
- JavaScript measurements: working.

## On-screen keyboard

- `#price`: keyboard **did NOT appear**.
  - webdriver-tap: open=False, focused=None, visual viewport 663 -> 663; screen motion 950..1883 ms after the action. Shot: `shots/02-keyboard-webdriver-tap.jpg`, filmstrip: `keyboard-02-1/filmstrip.jpg`
  - send-keys: open=False, focused={'id': 'price', 'inputmode': 'decimal', 'type': 'number', 'tag': 'input'}, visual viewport 663 -> 663; screen motion 245..245 ms after the action. Shot: `shots/03-keyboard-send-keys.jpg`, filmstrip: `keyboard-03-2/filmstrip.jpg`
  - simulator-app+webdriver-tap: open=False, focused=None, visual viewport 663 -> 663; screen motion 161..827 ms after the action. Shot: `shots/04-keyboard-simulator-app-webdriver-tap.jpg`, filmstrip: `keyboard-04-3/filmstrip.jpg`
- `#name`: keyboard **did NOT appear**.
  - webdriver-tap: open=False, focused=None, visual viewport 663 -> 663; screen motion 147..980 ms after the action. Shot: `shots/07-keyboard-webdriver-tap.jpg`, filmstrip: `keyboard-07-1/filmstrip.jpg`

## Steps

| # | step | result | keyboard | shot |
|---|---|---|---|---|
| 1 | loaded | ok | False | `shots/01-loaded.jpg` |
| 2 | keyboard-number | ok | False | `` |
| 3 | typed-price | field value now '' | False | `shots/05-typed-price.jpg` |
| 4 | keyboard-dismissed | ok | False | `shots/06-keyboard-dismissed.jpg` |
| 5 | keyboard-text | ok | False | `` |
| 6 | dismissed-2 | ok | False | `shots/08-dismissed-2.jpg` |
| 7 | picker-select | error: WebDriverError: click intercepted:  | None | `shots/09-picker-select-error.jpg` |
| 8 | picker-closed | ok | False | `shots/10-picker-closed.jpg` |
| 9 | picker-date | via webdriver | False | `shots/11-picker-date.jpg` |
| 10 | date-closed | ok | False | `shots/12-date-closed.jpg` |
| 11 | top | ok | False | `` |
| 12 | swipe-up | webdriver-touch: innerHeight 663 -> 663, address bar unchanged, scrolled 0 px | False | `shots/13-swipe-up.jpg` |

Shots are the whole device screen (Safari's bars, keyboard, pickers included). `steps.json` has every measurement; `keyboard-*/` has the video, frames, and filmstrip of each keyboard attempt.
