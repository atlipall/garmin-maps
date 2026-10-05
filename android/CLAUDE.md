# Android app: notes for working here

The app opens the web app in Chrome as a Trusted Web Activity (Chrome only; the WebView fallback was
removed in 1.15). Location stays with the app (its permission and `LocationService`) on purpose: the
owner wants to track location in the background later, which only the app can do.

## Building and testing locally

- `export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=$HOME/Library/Android/sdk`,
  then `~/.local/opt/gradle-8.14.3/bin/gradle assembleLiveRelease` here. Set
  `ANDROID_KEYSTORE_FILE=/Users/atli/projects/maps/.android-signing/release.p12` (absolute: Gradle resolves a relative one from `app/`) and `ANDROID_KEYSTORE_PASSWORD` from
  `.android-signing/password.txt`, or Chrome won't verify the app (the debug key isn't in the asset links).
- Emulator `headunit29` (Android 10, 1280×720): `$ANDROID_HOME/emulator/emulator -avd headunit29 -dns-server 8.8.8.8`
  (without the DNS flag sites don't resolve). Its Chrome 91 is disabled; a Chromium snapshot from
  `commondatastorage.googleapis.com/chromium-browser-snapshots/Android_Arm64/` runs the app.
- Fake GPS with `adb emu geo fix <lon> <lat>`. Drive the page over CDP: `adb forward tcp:9333
  localabstract:chrome_devtools_remote`, then puppeteer `connect` (run from `web/`, which has puppeteer).
- The app's log: `garminmap://log` (LogActivity), or ⋯ → Diagnostics → "Android app's log" in the page.

## Chrome's location delegation (from Chromium 154 source; verified in the emulator)

- Chrome takes the page's location from the app whenever the app *requests* a location permission.
- It finds the app's service only if an exported activity handles VIEW/BROWSABLE https links to the bare
  origin (no `pathPrefix`); without that the page gets `NoTwaFound`.
- Errors go back as `onNewLocationError` (the library's `onNewErrorAvailable` is ignored).
- Chrome also needs its own Android location permission ("needs location permission for this site").
- After a manifest change, force-stop Chrome. Keep only one flavour installed while testing.

## Head unit

Really Android 10 (labelled 12), Unisoc ums512, Chrome 154. It has no system file picker (a file
manager app must be installed to import files).
