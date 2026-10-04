package is.atlipall.garminmap;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The app's entry point: starts the app in Chrome (ChromeLauncher), or in the built-in browser
 * (MainActivity) once that was chosen. Shows a diagnostics screen instead when the last start
 * crashed, or when the app has started over and over in a few seconds (a loop through Chrome):
 * what happened (App's log and crash report) and on what, with a way to try again or to use the
 * built-in browser.
 */
public class StartActivity extends Activity {
    /** This many starts within LOOP_MS is a loop, not someone opening the app. */
    private static final int LOOP_STARTS = 3;
    private static final long LOOP_MS = 15_000;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        SharedPreferences prefs = getSharedPreferences("start", MODE_PRIVATE);
        // A new version tries Chrome again (it may be what fixes it), whatever was chosen before.
        if (prefs.getInt("version", 0) != BuildConfig.VERSION_CODE) {
            prefs.edit().putInt("version", BuildConfig.VERSION_CODE).remove("builtIn").remove("starts").apply();
        }
        long now = System.currentTimeMillis();
        // Recent starts, oldest first, as "t1,t2,…".
        StringBuilder kept = new StringBuilder();
        int recent = 1;
        for (String t : prefs.getString("starts", "").split(",")) {
            if (t.isEmpty()) continue;
            long at = Long.parseLong(t);
            if (now - at < LOOP_MS) {
                recent++;
                kept.append(at).append(',');
            }
        }
        prefs.edit().putString("starts", kept.toString() + now).apply();
        File report = new File(getFilesDir(), App.REPORT);
        boolean builtIn = prefs.getBoolean("builtIn", false);
        // Opened again within 30 s of handing over to Chrome: Chrome didn't keep the app. Show
        // what happened rather than trying the same again.
        long handedOver = prefs.getLong("handedOverAt", 0);
        if (!builtIn && now - handedOver < 30_000) {
            prefs.edit().remove("handedOverAt").remove("starts").apply();
            App.log(this, "start: back " + (now - handedOver) / 1000 + " s after handing over to Chrome");
            showDiagnostics(report, false, true);
            return;
        }
        App.log(this, "start #" + recent + " in 15 s" + (builtIn ? " (built-in browser chosen)" : "") + (report.exists() ? " (crash report waiting)" : ""));
        if (!report.exists() && recent < LOOP_STARTS) {
            go(builtIn);
            return;
        }
        prefs.edit().remove("starts").apply();
        showDiagnostics(report, recent >= LOOP_STARTS, false);
    }

    private void go(boolean builtIn) {
        App.log(this, builtIn ? "opening the built-in browser" : "opening in Chrome");
        Intent intent = new Intent(this, builtIn ? MainActivity.class : ChromeLauncher.class);
        // The Chrome launcher wants a task of its own: without one it relaunches itself, and that
        // second copy, seeing the first still alive, takes the app for running and closes (the
        // head unit's flicker: Chrome was never asked).
        if (!builtIn) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        finish();
    }

    private void showDiagnostics(File report, boolean looped, boolean backFromChrome) {
        String crash = read(report);
        String log = read(new File(getFilesDir(), App.LOG));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(48, 32, 48, 32);
        page.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(this);
        title.setText(backFromChrome
            ? "Back soon after opening in Chrome: it didn't keep the map open? Take a photo of this screen and send it on."
            : looped
            ? "Garmin Map kept starting over, so it stopped here. Take a photo of this screen and send it on."
            : "Garmin Map stopped the last time it started. Take a photo of this screen and send it on.");
        title.setTextSize(20);
        title.setTextColor(Color.BLACK);
        page.addView(title);
        LinearLayout buttons = new LinearLayout(this);
        Button chrome = new Button(this);
        chrome.setText("Try Chrome again");
        chrome.setOnClickListener(v -> choose(report, false));
        Button builtIn = new Button(this);
        builtIn.setText("Use the built-in browser");
        builtIn.setOnClickListener(v -> choose(report, true));
        buttons.addView(chrome);
        buttons.addView(builtIn);
        page.addView(buttons);
        TextView details = new TextView(this);
        details.setText(App.deviceInfo(this) + "\n" + (crash.isEmpty() ? "" : "Crash:\n" + crash + "\n\n") + "What happened:\n" + log);
        details.setTextSize(13);
        details.setTextColor(Color.DKGRAY);
        details.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(details);
        page.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(page);
    }

    /** Chrome or the built-in browser from now on (remembered), starting afresh. */
    private void choose(File report, boolean builtIn) {
        report.delete();
        getSharedPreferences("start", MODE_PRIVATE).edit().putBoolean("builtIn", builtIn).remove("starts").apply();
        go(builtIn);
    }

    private static String read(File f) {
        try {
            return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : "";
        } catch (Exception e) {
            return "(could not be read: " + e + ")";
        }
    }
}
