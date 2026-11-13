<div align="center">

  <img src="logo/nuvio_wordmark.png" alt="Nuvio" width="300" />

  <p>
    The desktop companion for installing Nuvio TV on Samsung Tizen and LG webOS.
    <br />
    Download, sign, install, update, launch, and remove the TV app from one place.
  </p>

[Website](https://nuvio.tv) · [Nuvio TV](https://github.com/NuvioMedia/NuvioTVSmart) · [Android TV](https://github.com/NuvioMedia/NuvioTV) · [Releases](https://github.com/NuvioMedia/NuvioTVSmart-Installer/releases) · [Support Nuvio](https://nuvio.tv/support)

</div>

## Get the installer

Download a packaged build from the [installer releases](https://github.com/NuvioMedia/NuvioTVSmart-Installer/releases):

- Windows portable executable
- macOS application
- Linux AppImage

The installer reads the release configuration from `installer.config.json`, downloads the matching `.wgt` or `.ipk` asset from the Nuvio TV repository, and provides these actions:

- `Install / Update`
- `Launch`
- `Uninstall`

## Supported TVs

- **Samsung Tizen 4+** — standalone WGT installation through Developer Mode; EngineFS/P2P starts at Tizen 5, and executable plugins are supported from Tizen 6.
- **LG webOS 5+** — installation through the official webOS Developer Mode tools.

The Nuvio TV package uses the bundled local companion service where the TV platform supports it. No external torrent or streaming server is configured or required. The installer never permits a Samsung installation or update when the WGT does not contain the required local service.

## Use it

### Samsung Tizen

Before using the installer:

1. Open `Apps` on the TV.
2. Press `12345` on the remote.
3. Enable `Developer Mode`.
4. Enter the computer IP as `Host PC IP`.
5. Restart the TV.

The installer first attempts the direct Samsung Developer Mode connection. If that is unavailable, it uses `sdb` when it is installed on the computer; the `tizen` CLI can be used as a later fallback for compatible setups.

For every Samsung install or update, the installer:

1. downloads the selected WGT;
2. verifies `config.xml`, the declared Tizen version, and the local EngineFS and Plugin Web Services;
3. reads or creates the Samsung certificate for the TV DUID;
4. signs the WGT locally;
5. uploads and installs it with `vd_appinstall`.

The package is rejected before signing if any of these service requirements is missing:

- `http://tizen.org/feature/web.service` in `config.xml`;
- `main.js`, containing the service enablement flags;
- `services/tizen/enginefs-service.js`;
- `services/tizen/runtime/media-http.cjs`;
- `services/tizen/runtime/tx3g-subtitle-parser.cjs`;
- `services/tizen/runtime/tx3g-subtitle-service.cjs`;
- `services/tizen/runtime/embedded-text-subtitle-parser.cjs`;
- a `tizen:service` entry pointing to `services/tizen/enginefs-service.js`;
- when PluginService is enabled, `services/tizen/plugin-service.js` and its declared `tizen:service` entry;
- `services/plugin-http.cjs`, loaded by `services/tizen/plugin-service.js` through its canonical relative path;
- the inline `wrt:service` module bridge in `index.html`.

The installer also verifies that EngineFS listens on port `2710` and PluginService on port `2711`. Alternate or fallback service ports are rejected.

EngineFS and PluginService are independent Web Services packaged in the same WGT. The installer accepts the single current Tizen package layout: the external `services/plugin-http.cjs` helper and the inline Samsung `wrt:service` import. Older bundled or external-bridge layouts are rejected so they cannot be installed accidentally.

The installer does not bypass Samsung certificate or platform checks. A Samsung certificate error such as `118012` means that the TV rejected the signed package; the installer can retry identities previously saved for that TV DUID, but it does not replace the certificate with an unrelated identity or use an unsupported wrapper.

### LG webOS

Before using the installer:

1. Install and open the `Developer Mode` app on the TV.
2. Enable `Developer Mode`.
3. Enable `Key Server`.
4. Copy the passphrase shown by the Developer Mode app.
5. Select `LG TV` in the installer, enter the TV IP and passphrase, then press `Install / Update`.

The device name is optional. The installer creates or updates a local webOS device profile and uses the official commands provided by `@webos-tools/cli`:

```text
ares-setup-device
ares-novacom --getkey
ares-install
ares-launch
```

If a usable profile already exists, the installer can reuse it. Entering a new IP for an existing device name updates that profile before installation.

## Command line

The same install logic is available as a headless, script-friendly CLI on Windows, macOS and Linux (including servers without a display). It needs Node.js 18.17 or newer:

```bash
npx github:NuvioMedia/NuvioTVSmart-Installer samsung install --ip 192.168.0.15
npx github:NuvioMedia/NuvioTVSmart-Installer lg install --ip 192.168.0.13 --device-name lg --passphrase ABC123
```

Commands:

```text
nuvio-tv-installer <samsung|lg> <install|launch|uninstall> --ip <TV IP> [options]
nuvio-tv-installer <samsung|lg> releases
```

`install` also updates an existing installation. Useful options: `--release <tag>` (default: latest), `--file <path>` for a local `.wgt`/`.ipk`, `--json` for one JSON object per log line. Run with `--help` for the full list. The exit code is `0` on success and `1` on failure.

From a clone, use `npm ci --omit=dev` and then `npm run cli -- samsung install --ip ...`. The packaged desktop app can run it too: `ELECTRON_RUN_AS_NODE=1 <installer executable> <resources>/app.asar/src/cli.js ...`.

The CLI uses the same data folder as the desktop app (downloaded packages, Samsung certificates), so a TV already set up in the app works straight away. Set `NUVIO_INSTALLER_DATA_DIR` to use another folder.

Samsung certificate: the first install on a new TV creates a certificate through a Samsung account sign-in. The CLI prints the sign-in URL; open it in a browser on the same computer, because Samsung redirects to `http://localhost:4794`. On a headless machine, forward the port first (for example `ssh -L 4794:localhost:4794 <server>`) and open the URL on your own computer. After that, the saved certificate is reused and installs and updates run without any interaction. To skip the sign-in, pass an existing certificate with `--author-cert`, `--distributor-cert` and `--cert-password` (or `NUVIO_CERT_PASSWORD`), or a Tizen Studio profile with `--cert-profile`.

## TV package contract

The GitHub release workflow publishes the installer input packages together:

- `package:tizen` creates the unsigned WGT used by development and this installer;
- `package:webos` creates the installable LG IPK;
- `package:tizen:store` is a separate Samsung Seller Office build that requires an official Tizen security profile.

The unsigned Samsung WGT is intentional: the installer must sign it locally with the author certificate associated with the target TV DUID. Do not replace it with a Store-signed package. Keeping the installer WGT separate preserves both local Developer Mode installation and the Store publication flow.

There is one direct-install WGT contract for Samsung: the unsigned output of `package:tizen`. The separate `package:tizen:store` output is only for Seller Office and is not an installer input.

For Samsung P2P playback, the WGT generated by the Nuvio TV repository must be built with the local EngineFS service included. The installer validates this contract before it creates a certificate or attempts installation.

## Build from source

```bash
git clone https://github.com/NuvioMedia/NuvioTVSmart-Installer.git
cd NuvioTVSmart-Installer
npm install
npm start
```

Run the available checks with:

```bash
npm test
```

Build standalone desktop packages with:

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

The TV packages themselves are built in the [Nuvio TV repository](https://github.com/NuvioMedia/NuvioTVSmart):

```bash
npm install
npm run build
npm run package:tizen
npm run package:webos
```

The Nuvio TV build reads runtime values from its local `local.properties`; credentials and private runtime configuration must not be committed. Store packaging uses the separate `package:tizen:store` command and does not change the WGT contract consumed by this installer.

## Configuration

The default `installer.config.json` points to the Nuvio TV release assets:

```json
{
  "githubRepo": "NuvioMedia/NuvioTVSmart",
  "webos": {
    "appId": "space.nuvio.webos",
    "assetPattern": "\\.ipk$"
  },
  "tizen": {
    "appId": "NuvioTV001.NuvioTV",
    "packageId": "NuvioTV001",
    "appIds": [
      "NuvioTV001.NuvioTV",
      "NuvioTV001",
      "NuvioTV001.Nuvio",
      "Nuvio",
      "NuvioTV.NuvioTV",
      "NuvioTV"
    ],
    "assetPattern": "\\.wgt$"
  }
}
```

## Security and distribution

Samsung certificates are stored in the application data directory and are keyed by TV DUID. Back up that directory: losing the author certificate used by an installed app can prevent in-place updates.

For public desktop distribution, code-signing the Windows executable and macOS application is recommended. Electron and the bundled webOS CLI contain transitive dependencies, so clean reproducible builds and dependency updates also help reduce antivirus false positives.

## License

[GNU General Public License v3.0](./LICENSE)
