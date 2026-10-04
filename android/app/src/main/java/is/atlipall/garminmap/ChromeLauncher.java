package is.atlipall.garminmap;

import android.content.Intent;
import android.os.Bundle;
import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/**
 * Starts the app in the head unit's Chrome as a Trusted Web Activity: full screen, with Chrome's
 * own engine and storage (Google sign-in, downloads and keeping the screen on all work there). The
 * site vouches for this app in https://atlipall.github.io/.well-known/assetlinks.json, which is what
 * lets Chrome drop its address bar. Without a browser that can do this, the app's own WebView
 * (MainActivity) takes over. The start URL, display mode and colours are in AndroidManifest.xml.
 */
public class ChromeLauncher extends LauncherActivity {
    @Override
    protected void onCreate(Bundle saved) {
        App.log(this, "Chrome launcher: created (task " + getTaskId() + ", flags 0x" + Integer.toHexString(getIntent().getFlags()) + ")");
        super.onCreate(saved);
    }

    @Override
    protected void launchTwa() {
        App.log(this, "Chrome launcher: handing over to Chrome");
        super.launchTwa();
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

    @Override
    protected TwaLauncher.FallbackStrategy getFallbackStrategy() {
        return (context, builder, provider, done) -> {
            App.log(context, "Chrome launcher: no browser for this (" + provider + "), using the built-in browser");
            context.startActivity(new Intent(context, MainActivity.class));
            if (done != null) done.run();
        };
    }
}
