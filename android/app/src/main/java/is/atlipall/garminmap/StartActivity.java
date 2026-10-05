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
 * The app's entry point: starts the app in Chrome (ChromeLauncher). Shows a diagnostics screen
 * instead when the last start crashed, or when the app has started over and over in a few seconds
 * (a loop through Chrome): what happened (App's log and crash report) and on what, with a way to
 * try again.
 */
public class StartActivity extends Activity {
    /** This many starts within LOOP_MS is a loop, not someone opening the app. */
    private static final int LOOP_STARTS = 3;
    private static final long LOOP_MS = 15_000;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        SharedPreferences prefs = getSharedPreferences("start", MODE_PRIVATE);
        // A new version starts afresh (it may be what fixes it).
        if (prefs.getInt("version", 0) != BuildConfig.VERSION_CODE) {
            prefs.edit().putInt("version", BuildConfig.VERSION_CODE).remove("starts").apply();
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
        App.log(this, "start #" + recent + " in 15 s" + (report.exists() ? " (crash report waiting)" : ""));
        if (!report.exists() && recent < LOOP_STARTS) {
            go();
            return;
        }
        prefs.edit().remove("starts").apply();
        showDiagnostics(report, recent >= LOOP_STARTS);
    }

    private void go() {
        App.log(this, "opening in Chrome");
        Intent intent = new Intent(this, ChromeLauncher.class);
        // The Chrome launcher wants a task of its own: without one it relaunches itself, and that
        // second copy, seeing the first still alive, takes the app for running and closes (the
        // head unit's flicker: Chrome was never asked).
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(intent);
        finish();
    }

    private void showDiagnostics(File report, boolean looped) {
        String crash = read(report);
        String log = read(new File(getFilesDir(), App.LOG));
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(48, 32, 48, 32);
        page.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(this);
        title.setText(looped
            ? "Garmin Map kept starting over, so it stopped here. Take a photo of this screen and send it on."
            : "Garmin Map stopped the last time it started. Take a photo of this screen and send it on.");
        title.setTextSize(20);
        title.setTextColor(Color.BLACK);
        page.addView(title);
        LinearLayout buttons = new LinearLayout(this);
        Button chrome = new Button(this);
        chrome.setText("Try again");
        chrome.setOnClickListener(v -> {
            report.delete();
            getSharedPreferences("start", MODE_PRIVATE).edit().remove("starts").apply();
            go();
        });
        buttons.addView(chrome);
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

    private static String read(File f) {
        try {
            return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : "";
        } catch (Exception e) {
            return "(could not be read: " + e + ")";
        }
    }
}
