# Pi Mode

This private T3 Code build supports Pi Agent 0.80.4 or newer. Install and authenticate Pi first, then
open **Settings → Providers**. The Pi provider card shows its version, model inventory, and any setup
error.

Turn on **Pi mode** at the top of the provider settings page. The switch is available only when an
enabled Pi instance has a usable model.

While Pi Mode is on:

- every project remains visible, but only Pi-backed threads appear
- new threads and model pickers use Pi only
- Full access is the only runtime mode
- provider settings show Pi instances only
- title, branch, commit, and pull-request writing temporarily use Pi

Hidden threads are not stopped, edited, archived, or deleted. Turn Pi Mode off from the same settings
page to restore the normal home page and provider list.

The switch is stored in the current browser profile. It does not enable Pi Mode on another browser,
desktop install, or mobile device. This downstream release certifies the CLI-served web client; it does
not include a custom Electron or mobile application.
