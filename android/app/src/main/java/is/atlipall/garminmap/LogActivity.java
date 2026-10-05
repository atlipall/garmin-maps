package is.atlipall.garminmap;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * The app's log on screen, opened from the web app's ⋯ → Diagnostics → "Android app's log" (the
 * link garminmap://log): the device, the location permission and sources as Android sees them, a
 * GPS test that bypasses Chrome, and what happened at the last starts (App's log: Chrome's
 * messages, the location service). Back returns to the map.
 */
public class LogActivity extends Activity implements LocationListener {
    private TextView details;
    private Button test;
    private LocationManager manager;
    private final List<String> fixes = new ArrayList<>();
    private int count;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(48, 32, 48, 32);
        page.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(this);
        title.setText(getString(R.string.app_name) + ": the app's log");
        title.setTextSize(20);
        title.setTextColor(Color.BLACK);
        page.addView(title);
        LinearLayout buttons = new LinearLayout(this);
        test = button(buttons, "Test GPS", v -> {
            if (manager == null) startTest();
            else stopTest("stopped");
        });
        button(buttons, "Refresh", v -> show());
        button(buttons, "Clear log", v -> {
            new File(getFilesDir(), App.LOG).delete();
            show();
        });
        button(buttons, "Back to the map", v -> finish());
        page.addView(buttons);
        details = new TextView(this);
        details.setTextSize(13);
        details.setTextColor(Color.DKGRAY);
        details.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(details);
        page.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(page);
        show();
    }

    private Button button(LinearLayout row, String text, android.view.View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(text);
        b.setOnClickListener(click);
        row.addView(b);
        return b;
    }

    private void show() {
        StringBuilder s = new StringBuilder(App.deviceInfo(this)).append('\n');
        s.append("Location permission: ").append(granted(Manifest.permission.ACCESS_FINE_LOCATION) ? "precise" : granted(Manifest.permission.ACCESS_COARSE_LOCATION) ? "approximate only" : "NOT granted").append('\n');
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        for (String p : lm.getAllProviders()) {
            s.append("  ").append(p).append(": ").append(lm.isProviderEnabled(p) ? "on" : "off");
            try {
                @SuppressWarnings("MissingPermission")
                Location last = lm.getLastKnownLocation(p);
                if (last != null) s.append(", last fix ").append(age(last.getTime())).append(" ±").append(Math.round(last.getAccuracy())).append(" m");
            } catch (Throwable e) {
                s.append(", ").append(e.getClass().getSimpleName());
            }
            s.append('\n');
        }
        s.append('\n');
        if (manager != null || !fixes.isEmpty()) {
            s.append("GPS test (").append(manager != null ? "running" : "stopped").append(", ").append(count).append(" fixes):\n");
            for (int i = fixes.size() - 1; i >= 0; i--) s.append(fixes.get(i)).append('\n');
            s.append('\n');
        }
        String crash = read(new File(getFilesDir(), App.REPORT));
        if (!crash.isEmpty()) s.append("Last crash:\n").append(crash).append("\n\n");
        s.append("What happened (newest last):\n").append(read(new File(getFilesDir(), App.LOG)));
        details.setText(s);
        test.setText(manager != null ? "Stop the test" : "Test GPS");
    }

    private boolean granted(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** Listens to every location source the device has, straight from Android (not through Chrome). */
    @SuppressWarnings("MissingPermission")
    private void startTest() {
        fixes.clear();
        count = 0;
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION) && !granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
            requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 1);
            return;
        }
        manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        note("test started");
        for (String p : manager.getAllProviders()) {
            if (LocationManager.PASSIVE_PROVIDER.equals(p)) continue;
            try {
                manager.requestLocationUpdates(p, 1000, 0, this, Looper.getMainLooper());
                note("listening to " + p + (manager.isProviderEnabled(p) ? "" : " (it's off)"));
            } catch (Throwable e) {
                note(p + " failed: " + e);
            }
        }
        show();
    }

    private void stopTest(String why) {
        if (manager == null) return;
        manager.removeUpdates(this);
        manager = null;
        note("test " + why);
        show();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        note("permission " + (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION) ? "granted" : "refused"));
        if (granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)) startTest();
        else show();
    }

    @Override
    public void onLocationChanged(Location l) {
        count++;
        note(String.format(Locale.ROOT, "fix %d from %s: %.5f, %.5f ±%d m, %s old", count, l.getProvider(), l.getLatitude(), l.getLongitude(), Math.round(l.getAccuracy()), age(l.getTime()).replace(" ago", "")));
        show();
    }

    private void note(String line) {
        fixes.add(new SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(new Date()) + " " + line);
        while (fixes.size() > 30) fixes.remove(0);
    }

    private static String age(long time) {
        long s = Math.max(0, (System.currentTimeMillis() - time) / 1000);
        return s < 120 ? s + " s ago" : s < 7200 ? s / 60 + " min ago" : s / 3600 + " h ago";
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {
        note(provider + " turned on");
        show();
    }

    @Override
    public void onProviderDisabled(String provider) {
        note(provider + " turned off");
        show();
    }

    @Override
    protected void onPause() {
        stopTest("stopped (screen left)");
        super.onPause();
    }

    private static String read(File f) {
        try {
            return f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : "";
        } catch (Exception e) {
            return "(could not be read: " + e + ")";
        }
    }
}
