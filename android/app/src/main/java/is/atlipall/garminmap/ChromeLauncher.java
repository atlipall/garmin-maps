package is.atlipall.garminmap;

import android.net.Uri;
import android.os.Bundle;
import androidx.browser.customtabs.CustomTabsCallback;
import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.QualityEnforcer;
import com.google.androidbrowserhelper.trusted.TwaProviderPicker;

/**
 * Starts the app in the head unit's Chrome as a Trusted Web Activity: no address bar, with Chrome's
 * own engine and storage (Google sign-in, downloads and keeping the screen on all work there). The
 * site vouches for this app in https://atlipall.github.io/.well-known/assetlinks.json, which is what
 * lets Chrome drop its address bar. The start URL, display mode and colours are in
 * AndroidManifest.xml.
 */
public class ChromeLauncher extends LauncherActivity {
    @Override
    protected void onCreate(Bundle saved) {
        App.log(this, "Chrome launcher: created (task " + getTaskId() + ", flags 0x" + Integer.toHexString(getIntent().getFlags()) + ")");
        super.onCreate(saved);
    }

    @Override
    protected void launchTwa() {
        TwaProviderPicker.Action pick = TwaProviderPicker.pickProvider(getPackageManager());
        String mode = pick.launchMode == TwaProviderPicker.LaunchMode.TRUSTED_WEB_ACTIVITY ? "full-screen app"
            : pick.launchMode == TwaProviderPicker.LaunchMode.CUSTOM_TAB ? "Chrome tab only" : "browser only";
        App.log(this, "Chrome launcher: handing over to " + pick.provider + " (" + mode + ")");
        super.launchTwa();
    }

    /** What Chrome reports back while this is alive: whether the site vouched for the app, the
     *  page loading, the tab shown or hidden. */
    @Override
    protected CustomTabsCallback getCustomTabsCallback() {
        return new QualityEnforcer() {
            @Override
            public void onNavigationEvent(int event, Bundle extras) {
                App.log(ChromeLauncher.this, "Chrome: " + navigation(event));
                super.onNavigationEvent(event, extras);
            }

            @Override
            public void onRelationshipValidationResult(int relation, Uri origin, boolean ok, Bundle extras) {
                App.log(ChromeLauncher.this, "Chrome: site " + origin + (ok ? " vouches for the app" : " does NOT vouch for the app (address bar shown)"));
                super.onRelationshipValidationResult(relation, origin, ok, extras);
            }

            @Override
            public void extraCallback(String name, Bundle args) {
                App.log(ChromeLauncher.this, "Chrome: " + name);
                super.extraCallback(name, args);
            }
        };
    }

    private static String navigation(int event) {
        switch (event) {
            case CustomTabsCallback.NAVIGATION_STARTED: return "page loading";
            case CustomTabsCallback.NAVIGATION_FINISHED: return "page loaded";
            case CustomTabsCallback.NAVIGATION_FAILED: return "page FAILED to load";
            case CustomTabsCallback.NAVIGATION_ABORTED: return "page loading aborted";
            case CustomTabsCallback.TAB_SHOWN: return "shown";
            case CustomTabsCallback.TAB_HIDDEN: return "hidden";
            default: return "event " + event;
        }
    }

    @Override
    protected void onRestart() {
        App.log(this, "Chrome launcher: back from Chrome (Chrome closed or failed)");
        super.onRestart();
    }

    @Override
    protected void onDestroy() {
        App.log(this, "Chrome launcher: finished");
        super.onDestroy();
    }
}
