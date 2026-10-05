package is.atlipall.garminmap;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Records a trip: the unit's GPS, straight from Android, while the map is closed, another app is in
 * front or the screen is off. Started and stopped from the map (TripActivity) or the notification's
 * Stop. Points are thinned to about one every 10 m (sooner on bends) and appended to a file as they
 * come, so a crash or a restart of the app loses nothing: Android starts the service again and it
 * carries on. On Stop the map opens with the trip in its address (Trip.toFragment), and saves it.
 */
public class TripRecorder extends Service implements LocationListener {
    static final String START = "is.atlipall.garminmap.trip.START";
    static final String STOP = "is.atlipall.garminmap.trip.STOP";
    private static final String FILE = "trip.csv";
    private static final String PREFS = "trip";
    private static final int NOTIFICATION = 2;
    private static final String CHANNEL = "trip";
    /** Fixes rougher than this (m) are skipped. */
    private static final float MAX_ACCURACY_M = 50;
    /** The notification's figures are brought up to date this often (ms). */
    private static final long NOTIFY_MS = 15_000;

    private LocationManager manager;
    private final Trip.Thinner thinner = new Trip.Thinner();
    private long started;
    private long lastNotified;

    /** Whether a trip is being recorded (the map asks before starting another). */
    static boolean recording(Context c) {
        return c.getSharedPreferences(PREFS, MODE_PRIVATE).getLong("started", 0) != 0;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (STOP.equals(action)) {
            stop();
            return START_NOT_STICKY;
        }
        // START, or Android restarting the service after it was killed while recording.
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (intent == null && prefs.getLong("started", 0) == 0) {
            stopSelf();
            return START_NOT_STICKY;
        }
        begin(prefs);
        return START_STICKY;
    }

    @SuppressWarnings("MissingPermission")
    private void begin(SharedPreferences prefs) {
        if (manager != null) return; // already recording
        started = prefs.getLong("started", 0);
        File file = new File(getFilesDir(), FILE);
        if (started == 0) {
            started = System.currentTimeMillis();
            prefs.edit().putLong("started", started).apply();
            file.delete();
            App.log(this, "trip: recording started");
        } else {
            // Carrying on after a restart: the distance so far from what was written.
            for (Trip.Point p : read(file)) thinner.accept(p);
            App.log(this, "trip: recording resumed with " + thinner.count() + " points");
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION, notification());
        } catch (Throwable e) {
            App.log(this, "trip: couldn't go to the foreground: " + e);
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            App.log(this, "trip: no location permission");
            return;
        }
        manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
        } catch (Throwable e) {
            App.log(this, "trip: GPS failed: " + e);
        }
    }

    @Override
    public void onLocationChanged(Location l) {
        if (l.hasAccuracy() && l.getAccuracy() > MAX_ACCURACY_M) return;
        Trip.Point p = new Trip.Point(l.getLatitude(), l.getLongitude(), l.getTime());
        if (!thinner.accept(p)) return;
        try (FileWriter w = new FileWriter(new File(getFilesDir(), FILE), true)) {
            w.write(p.line());
        } catch (IOException e) {
            App.log(this, "trip: couldn't write: " + e);
        }
        long now = System.currentTimeMillis();
        if (now - lastNotified > NOTIFY_MS) {
            lastNotified = now;
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION, notification());
        }
    }

    /** Ends the trip: stops listening and hands it to the map. */
    private void stop() {
        if (manager != null) manager.removeUpdates(this);
        manager = null;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long start = prefs.getLong("started", 0);
        prefs.edit().remove("started").apply();
        File file = new File(getFilesDir(), FILE);
        List<Trip.Point> points = read(file);
        App.log(this, "trip: stopped, " + points.size() + " points, " + Math.round(thinner.metres()) + " m");
        stopForeground(true);
        stopSelf();
        if (start == 0) return; // not recording
        // Kept until the next trip starts, in case the map doesn't take it.
        file.renameTo(new File(getFilesDir(), "trip-last.csv"));
        Intent open = new Intent(this, ChromeLauncher.class);
        open.setData(Uri.parse(BuildConfig.START_URL + "#" + Trip.toFragment(start, System.currentTimeMillis(), points)));
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(open);
    }

    private Notification notification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        Notification.Builder n;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Trip recording", NotificationManager.IMPORTANCE_LOW));
            n = new Notification.Builder(this, CHANNEL);
        } else {
            n = new Notification.Builder(this);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, TripRecorder.class).setAction(STOP), flags);
        PendingIntent map = PendingIntent.getActivity(this, 2, new Intent(this, ChromeLauncher.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        long minutes = (System.currentTimeMillis() - started) / 60_000;
        String so = String.format(Locale.ROOT, "%.1f km so far · %d min", thinner.metres() / 1000, minutes);
        return n.setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Recording your trip")
            .setContentText(so)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(map)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
            .addAction(new Notification.Action.Builder(null, "Open map", map).build())
            .build();
    }

    private static List<Trip.Point> read(File file) {
        List<Trip.Point> out = new ArrayList<>();
        if (!file.exists()) return out;
        try {
            for (String line : Files.readAllLines(file.toPath(), StandardCharsets.UTF_8)) {
                Trip.Point p = Trip.Point.parse(line);
                if (p != null) out.add(p);
            }
        } catch (IOException ignored) {
            // what was read so far
        }
        return out;
    }

    @Override
    public void onDestroy() {
        if (manager != null) manager.removeUpdates(this);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}
}
