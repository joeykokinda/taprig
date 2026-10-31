# Desktop application

TapRig's Electron desktop application is a hardened shell around the same local
daemon and control room used by the CLI and MCP adapter.

```console
npm run desktop       # development launch
npm run desktop:pack  # unpacked Linux application
npm run desktop:dist  # Linux AppImage and Debian package
```

At startup the app:

1. uses Electron's private OS application-data directory;
2. reuses a healthy TapRig daemon or launches the bundled CLI in Electron's
   Node-only mode;
3. exchanges a one-time browser-session nonce for an HttpOnly cookie;
4. loads only the loopback control-room origin in a sandboxed renderer with
   Node integration disabled.

If the desktop app launched the daemon, it stops it during normal app shutdown.
An existing daemon is left running. External HTTPS links open in the system
browser and arbitrary in-app navigation is rejected.

The `0.1.0` Linux application directory and AppImage were launch-tested on
Wayland: the bundled daemon passed authenticated health and its process/state
were removed on app exit. Local release artifacts are:

- `TapRig-0.1.0.AppImage` (123 MB), SHA-256
  `624f0ba0977a7b65337c2da5d1a9c0bad21cccf2ceff0ab4ebf21c81c2a315d9`;
- `taprig_0.1.0_amd64.deb` (98 MB), SHA-256
  `cf8aaf12e7ab73599e6a3132ae28b781f381124e9697a0365ce5af81d67e3b53`.

These files are local evidence, not published downloads. macOS and Windows
targets are configured, but public artifacts remain disabled until CI
credentials, platform signing identities, bundled Android tools, and
cross-platform smoke tests are available. Production dependencies have no
known audit findings; electron-builder's development-only graph currently has
moderate advisories and must be refreshed before release automation is enabled.
