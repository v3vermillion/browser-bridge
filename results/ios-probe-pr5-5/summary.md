# iOS Safari run ios-probe-pr5-5

Device: **iPhone Air**, iOS 26.0 Simulator (real Mobile Safari). Status: **failed**.

Error: `TimeoutExpired: Command '['xcrun', 'simctl', 'bootstatus', 'AB0FB058-2DF8-4824-A382-91FE8566B342', '-b']' timed out after 600 seconds`

Notes: Automatic keyboard probe for a pull request

## Steps

| # | step | result | keyboard | shot |
|---|---|---|---|---|

## Notes

- safaridriver could not connect to Safari on iPhone Air iOS 26.2 (attempt 1): session not created: Could not create a session: Could not find Simulator.app or a devices:// URL handler.
- safaridriver could not connect to Safari on iPhone Air iOS 26.2 (attempt 2): session not created: Could not create a session: Could not find Simulator.app or a devices:// URL handler.
- safaridriver could not connect to Safari on iPhone Air iOS 26.1 (attempt 1): session not created: Could not create a session: Could not find Simulator.app or a devices:// URL handler.
- safaridriver could not connect to Safari on iPhone Air iOS 26.1 (attempt 2): session not created: Could not create a session: Could not find Simulator.app or a devices:// URL handler.

Shots are the whole device screen (Safari's bars, keyboard, pickers included). `steps.json` has every measurement; `keyboard-*/` has the video, frames, and filmstrip of each keyboard attempt.
