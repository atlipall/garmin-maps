package is.atlipall.garminmap;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Garmin Map in a full-screen WebView: the fallback when there's no browser to run it in Chrome
 * (./ChromeLauncher.java), on the web app at BuildConfig.START_URL.
 * It loads the live app, so it updates with the site and works offline once loaded (the app's
 * service worker). This adds what a bare WebView lacks: location (asked for once), the file picker
 * (to import the map), the screen kept on, no system bars, and Back that doesn't close it.
 */
public class MainActivity extends Activity {
    private static final int ASK_LOCATION = 1;
    private static final int PICK_FILES = 2;

    private WebView web;
    private ValueCallback<Uri[]> filesWanted;
    private GeolocationPermissions.Callback locationWanted;
    private String locationOrigin;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        App.log(this, "built-in browser: created");
        // A map in a car: the screen stays on while the app is in front.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Tells the page it runs in this app (its Diagnostics then offers the app's log).
        s.setUserAgentString(s.getUserAgentString() + " GarminMapApp/" + BuildConfig.APPLICATION_ID);
        web.setWebViewClient(new WebViewClient() {
            // The app's own pages stay here; anything else (a link in the guide, Google's sign-in
            // page) opens in the browser.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("atlipall.github.io".equals(url.getHost())) return false;
                // The Diagnostics' link to the app's log (intent://log#Intent;scheme=garminmap;…).
                if ("intent".equals(url.getScheme()) && "log".equals(url.getHost())) {
                    startActivity(new Intent(MainActivity.this, LogActivity.class));
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException ignored) {
                    // no browser: stay put
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocation()) {
                    callback.invoke(origin, true, false);
                } else {
                    locationWanted = callback;
                    locationOrigin = origin;
                    requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, ASK_LOCATION);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filesWanted != null) filesWanted.onReceiveValue(null);
                filesWanted = callback;
                boolean many = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                // Head units vary in which file picker they have (or let apps use): Android's own
                // document picker, else any app that offers files, else what the page asked for.
                Intent open = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                Intent get = new Intent(Intent.ACTION_GET_CONTENT);
                for (Intent i : new Intent[] {open, get}) {
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*"); // a map file (.img) has no type Android knows
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, many);
                }
                Intent asked;
                try {
                    asked = params.createIntent();
                } catch (Throwable e) {
                    asked = null;
                }
                // GET_CONTENT through Android's app chooser: the file manager it lands on may run in
                // a task of its own, which gives an immediate "cancelled" when started directly.
                Intent chooser = Intent.createChooser(get, "Choose the file");
                for (Intent pick : new Intent[] {open, chooser, get, asked}) {
                    if (pick == null) continue;
                    try {
                        startActivityForResult(pick, PICK_FILES);
                        App.log(MainActivity.this, "file picker: opened " + pick.getAction());
                        return true;
                    } catch (Throwable e) {
                        App.log(MainActivity.this, "file picker: " + pick.getAction() + " failed: " + e);
                    }
                }
                filesWanted = null;
                callback.onReceiveValue(null);
                return true;
            }
        });
        setContentView(web);
        hideSystemBars();
        if (saved != null) web.restoreState(saved);
        else web.loadUrl(BuildConfig.START_URL);
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != ASK_LOCATION || locationWanted == null) return;
        locationWanted.invoke(locationOrigin, hasLocation(), false);
        locationWanted = null;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code != PICK_FILES || filesWanted == null) {
            super.onActivityResult(code, result, data);
            return;
        }
        Uri[] uris = null;
        try {
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    uris = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < uris.length; i++) uris[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    uris = new Uri[] {data.getData()};
                }
            }
            App.log(this, "file picker: " + (uris == null ? "nothing picked (result " + result + ")" : uris.length + " file(s)"));
        } catch (Throwable e) {
            App.log(this, "file picker: reading the result failed: " + e);
            uris = null;
        }
        filesWanted.onReceiveValue(uris);
        filesWanted = null;
    }

    /** Full screen: no status or navigation bar (a swipe from the edge shows them for a moment). */
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            android.view.WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(android.view.WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) hideSystemBars();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Back within the page if it has somewhere to go; else to the background, keeping the app's
        // state (a route, navigation) rather than closing it.
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
