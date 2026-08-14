# Kitsu Android (standalone)

Native shell around the Kitsu UI with **matrix-js-sdk** in the WebView. Logs into your homeserver directly — no desktop companion required.

## Install (Obtainium)

1. Open Obtainium → Add App  
2. Source: `https://github.com/ExcaliburAU/kitsu`  
3. APK filter (optional): `Kitsu-.*\.apk`  
4. Install from the latest release  

## Use

1. Open Kitsu on the phone.  
2. Enter homeserver (e.g. `matrix.org`), username, and password.  
3. Chat syncs and encrypts on-device (Rust crypto WASM + IndexedDB).

## Develop

```bash
# needs Node, JDK 21, Android SDK
npm run mobile:apk
# → mobile/android/app/build/outputs/apk/debug/app-debug.apk
# → dist/Kitsu-0.3.13.apk
```

`mobile:apk` builds `public/vendor/matrix-browser.js`, syncs `public/` into Capacitor `www/`, and assembles the debug APK.

## Notes

Safe-area / status-bar handling follows [Paarrot-Mobile](https://github.com/Paarrot/Paarrot-Mobile) (edge-to-edge WebView + themed insets).
